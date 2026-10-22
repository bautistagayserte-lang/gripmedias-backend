const express = require("express");
const crypto = require("crypto");
const { pool } = require("../db/pool");
const { ShippingError, getShippingRates } = require("../correoargentino");

const router = express.Router();

const TRANSFERENCIA_DISCOUNT_RATE = 0.1; // 10%, aplicado sobre productos + envío

/* Vuelve a calcular el costo de envío en el backend — nunca se confía en un
   shipping_cost que mande el frontend. "retiro" es gratis y no consulta
   Correo Argentino. "domicilio" cotiza contra MiCorreo con el CP recibido.
   "sucursal" todavía no está habilitado (no se inventan sucursales). */
async function resolveShippingCost(shipping) {
  if (shipping.method === "retiro") {
    return { cost: 0, deliveredType: null, productType: null, productName: null };
  }

  if (shipping.method === "sucursal") {
    throw new OrderError(409, "El envío a sucursal todavía no está disponible. Elegí domicilio o retiro por cuenta propia.");
  }

  // shipping.method === "domicilio"
  if (!shipping.cp) {
    throw new OrderError(400, "Falta el código postal de destino para cotizar el envío");
  }
  if (!shipping.productType) {
    throw new OrderError(400, "Falta indicar la opción de envío elegida (Clásico/Expreso)");
  }

  let rates;
  try {
    rates = await getShippingRates({ postalCodeDestination: shipping.cp, deliveredType: "D" });
  } catch (err) {
    if (err instanceof ShippingError) {
      throw new OrderError(err.status, `No se pudo calcular el envío: ${err.message}`);
    }
    throw err;
  }

  const chosen = rates.find((r) => r.productType === shipping.productType);
  if (!chosen) {
    throw new OrderError(409, "La opción de envío elegida ya no está disponible para ese código postal. Volvé a cotizar.");
  }

  return {
    cost: chosen.price,
    deliveredType: "D",
    productType: chosen.productType,
    productName: chosen.productName,
  };
}

class OrderError extends Error {
  constructor(status, message, extra) {
    super(message);
    this.status = status;
    this.extra = extra || {};
  }
}

const VALID_SHIPPING_METHODS = ["domicilio", "sucursal", "retiro"];
const VALID_PAYMENT_METHODS = ["mercadopago", "transferencia"];

function round2(n) {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

/* GM-XXXXXXXX con una parte de timestamp y una parte aleatoria, para que dos
   pedidos creados en el mismo milisegundo (picos de tráfico, tests, etc.) no
   generen el mismo order_code — order_code es UNIQUE en la base. */
function generateOrderCode() {
  const time = Date.now().toString(36).toUpperCase().slice(-5);
  const random = crypto.randomBytes(2).toString("hex").toUpperCase();
  return `GM-${time}${random}`;
}

function validateBody(body) {
  if (!body || typeof body !== "object") throw new OrderError(400, "Cuerpo de la petición inválido");
  const { items, buyer, shipping, payment } = body;

  if (!Array.isArray(items) || items.length === 0) {
    throw new OrderError(400, "El pedido no tiene productos");
  }
  for (const it of items) {
    if (!it.productId || typeof it.productId !== "string") throw new OrderError(400, "Falta productId en un ítem");
    if (!Number.isInteger(it.qty) || it.qty < 1) throw new OrderError(400, `Cantidad inválida para ${it.productId}`);
    if (it.color && typeof it.color !== "string") throw new OrderError(400, "Color inválido");
  }

  if (!buyer || !buyer.nombre || !buyer.apellido || !buyer.telefono) {
    throw new OrderError(400, "Faltan datos del comprador (nombre, apellido, teléfono)");
  }

  if (!shipping || !VALID_SHIPPING_METHODS.includes(shipping.method)) {
    throw new OrderError(400, "Modalidad de envío inválida");
  }

  if (!payment || !VALID_PAYMENT_METHODS.includes(payment.method)) {
    throw new OrderError(400, "Medio de pago inválido");
  }
}

/* Busca (con FOR UPDATE, bloqueando la fila) la variante real de un ítem
   del pedido. No confía en nada que haya mandado el frontend salvo
   productId/color/qty: precio y stock siempre se leen de la base. */
async function lockVariantForItem(client, item) {
  const query = item.color
    ? `SELECT v.id AS variant_id, v.stock, p.id AS product_id, p.name AS product_name, p.price, p.active
       FROM variants v JOIN products p ON p.id = v.product_id
       WHERE v.product_id = $1 AND v.color = $2
       FOR UPDATE OF v`
    : `SELECT v.id AS variant_id, v.stock, p.id AS product_id, p.name AS product_name, p.price, p.active
       FROM variants v JOIN products p ON p.id = v.product_id
       WHERE v.product_id = $1 AND v.color IS NULL
       FOR UPDATE OF v`;
  const params = item.color ? [item.productId, item.color] : [item.productId];
  const result = await client.query(query, params);

  if (result.rows.length === 0) {
    throw new OrderError(404, `No existe la variante solicitada para "${item.productId}"`, {
      productId: item.productId,
      color: item.color || null,
    });
  }
  const row = result.rows[0];
  if (!row.active) {
    throw new OrderError(409, `"${row.product_name}" ya no está disponible`, { productId: item.productId });
  }
  return row;
}

// POST /orders
router.post("/orders", async (req, res) => {
  let client;
  try {
    validateBody(req.body);
  } catch (err) {
    if (err instanceof OrderError) return res.status(err.status).json({ error: err.message, ...err.extra });
    throw err;
  }

  const { items, buyer, shipping, payment } = req.body;

  try {
    client = await pool.connect();
    await client.query("BEGIN");

    const resolvedItems = [];
    let subtotal = 0;

    for (const item of items) {
      const variant = await lockVariantForItem(client, item);

      if (variant.stock < item.qty) {
        throw new OrderError(
          409,
          `Sin stock suficiente de "${variant.product_name}"${item.color ? " (" + item.color + ")" : ""}. Quedan ${variant.stock}.`,
          { productId: item.productId, color: item.color || null, available: variant.stock }
        );
      }

      // Descuento atómico: la fila ya está bloqueada por el FOR UPDATE de arriba,
      // así que este UPDATE es seguro incluso con pedidos concurrentes.
      await client.query(`UPDATE variants SET stock = stock - $1 WHERE id = $2`, [item.qty, variant.variant_id]);

      const unitPrice = Number(variant.price); // precio SIEMPRE desde la DB, nunca el que mande el navegador
      const lineTotal = unitPrice * item.qty;
      subtotal += lineTotal;

      resolvedItems.push({
        productId: item.productId,
        variantId: variant.variant_id,
        productName: variant.product_name,
        color: item.color || null,
        size: item.size || null, // informativo: el talle todavía no se controla como stock
        unitPrice,
        quantity: item.qty,
        lineTotal,
      });
    }

    // Costo de envío SIEMPRE recalculado/validado en el backend — nunca se
    // confía en un shipping_cost enviado por el navegador.
    const shippingResolved = await resolveShippingCost(shipping);
    const shippingCost = shippingResolved.cost;

    // Descuento por transferencia: 10% sobre (productos + envío).
    const preDiscountTotal = subtotal + shippingCost;
    const discount = payment.method === "transferencia" ? round2(preDiscountTotal * TRANSFERENCIA_DISCOUNT_RATE) : 0;
    const total = round2(preDiscountTotal - discount);

    const status = payment.method === "transferencia" ? "payment_pending" : "pending";

    // Reintenta con un order_code nuevo si hubiera una colisión (muy
    // improbable, pero order_code es UNIQUE en la base y no vale la pena
    // devolverle un 500 al cliente por una coincidencia de milisegundos).
    let order;
    for (let attempt = 1; attempt <= 3; attempt++) {
      const orderCode = generateOrderCode();
      try {
        const orderRes = await client.query(
          `INSERT INTO orders
            (order_code, status, buyer_name, buyer_lastname, buyer_email, buyer_phone,
             shipping_method, shipping_cp, shipping_province, shipping_locality, shipping_address, shipping_notes,
             shipping_cost, shipping_delivered_type, shipping_product_type, shipping_product_name,
             payment_method, subtotal, discount, total)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20)
           RETURNING id, order_code, status, created_at`,
          [
            orderCode,
            status,
            buyer.nombre,
            buyer.apellido,
            buyer.email || null,
            buyer.telefono,
            shipping.method,
            shipping.cp || null,
            shipping.provincia || null,
            shipping.localidad || null,
            shipping.direccion || null,
            shipping.notas || null,
            shippingCost,
            shippingResolved.deliveredType,
            shippingResolved.productType,
            shippingResolved.productName,
            payment.method,
            subtotal,
            discount,
            total,
          ]
        );
        order = orderRes.rows[0];
        break;
      } catch (err) {
        // 23505 = unique_violation en Postgres. Si fue por order_code, reintenta.
        if (err.code === "23505" && attempt < 3) continue;
        throw err;
      }
    }

    for (const it of resolvedItems) {
      await client.query(
        `INSERT INTO order_items
          (order_id, product_id, variant_id, product_name, color, size, unit_price, quantity, line_total)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        [order.id, it.productId, it.variantId, it.productName, it.color, it.size, it.unitPrice, it.quantity, it.lineTotal]
      );
    }

    await client.query("COMMIT");

    res.status(201).json({
      orderId: order.id,
      orderCode: order.order_code,
      status: order.status,
      createdAt: order.created_at,
      subtotal,
      shipping: {
        method: shipping.method,
        cost: shippingCost,
        productType: shippingResolved.productType,
        productName: shippingResolved.productName,
      },
      discount,
      total,
      items: resolvedItems,
    });
  } catch (err) {
    if (client) await client.query("ROLLBACK");
    if (err instanceof OrderError) {
      return res.status(err.status).json({ error: err.message, ...err.extra });
    }
    console.error("[POST /orders]", err);
    res.status(500).json({ error: "No se pudo crear el pedido" });
  } finally {
    if (client) client.release();
  }
});

// GET /orders/:id  (acepta el id numérico o el order_code, ej. GM-12345678)
router.get("/orders/:id", async (req, res) => {
  try {
    const { id } = req.params;
    const isNumeric = /^\d+$/.test(id);
    const orderRes = await pool.query(
      isNumeric ? `SELECT * FROM orders WHERE id = $1` : `SELECT * FROM orders WHERE order_code = $1`,
      [isNumeric ? Number(id) : id]
    );
    if (orderRes.rows.length === 0) return res.status(404).json({ error: "Pedido no encontrado" });

    const order = orderRes.rows[0];
    const itemsRes = await pool.query(`SELECT * FROM order_items WHERE order_id = $1 ORDER BY id`, [order.id]);

    res.json({
      order: {
        id: order.id,
        orderCode: order.order_code,
        status: order.status,
        buyer: {
          nombre: order.buyer_name,
          apellido: order.buyer_lastname,
          email: order.buyer_email,
          telefono: order.buyer_phone,
        },
        shipping: {
          method: order.shipping_method,
          cp: order.shipping_cp,
          provincia: order.shipping_province,
          localidad: order.shipping_locality,
          direccion: order.shipping_address,
          notas: order.shipping_notes,
          cost: order.shipping_cost !== null ? Number(order.shipping_cost) : null,
          deliveredType: order.shipping_delivered_type,
          productType: order.shipping_product_type,
          productName: order.shipping_product_name,
        },
        paymentMethod: order.payment_method,
        subtotal: Number(order.subtotal),
        discount: order.discount !== null && order.discount !== undefined ? Number(order.discount) : 0,
        total: order.total !== null ? Number(order.total) : null,
        createdAt: order.created_at,
        updatedAt: order.updated_at,
        items: itemsRes.rows.map((it) => ({
          productId: it.product_id,
          productName: it.product_name,
          color: it.color,
          size: it.size,
          unitPrice: Number(it.unit_price),
          quantity: it.quantity,
          lineTotal: Number(it.line_total),
        })),
      },
    });
  } catch (err) {
    console.error("[GET /orders/:id]", err);
    res.status(500).json({ error: "No se pudo obtener el pedido" });
  }
});

module.exports = router;
