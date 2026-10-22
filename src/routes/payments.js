const express = require("express");
const crypto = require("crypto");
const { pool } = require("../db/pool");
const { getPreferenceClient, getPaymentClient } = require("../mercadopago");

const router = express.Router();

/* Mapea el status que informa Mercado Pago a los estados internos que ya
   existen en GRIP MEDIAS (pending/payment_pending/paid/rejected/cancelled/
   preparing/shipped/completed). No se agregan estados nuevos. */
function mapMpStatusToOrderStatus(mpStatus) {
  switch (mpStatus) {
    case "approved":
      return "paid";
    case "rejected":
      return "rejected";
    case "cancelled":
      return "cancelled";
    case "refunded":
    case "charged_back":
      return "cancelled";
    case "pending":
    case "in_process":
    case "in_mediation":
    case "authorized":
    default:
      return "payment_pending";
  }
}

async function findOrder(idParam) {
  const isNumeric = /^\d+$/.test(idParam);
  const result = await pool.query(
    isNumeric ? `SELECT * FROM orders WHERE id = $1` : `SELECT * FROM orders WHERE order_code = $1`,
    [isNumeric ? Number(idParam) : idParam]
  );
  return result.rows[0] || null;
}

// POST /orders/:id/preference — genera una Preference de Checkout Pro para un pedido YA creado.
router.post("/orders/:id/preference", async (req, res) => {
  try {
    const order = await findOrder(req.params.id);
    if (!order) return res.status(404).json({ error: "Pedido no encontrado" });

    if (order.payment_method !== "mercadopago") {
      return res.status(409).json({ error: "Este pedido no fue creado con Mercado Pago como medio de pago" });
    }
    if (!["pending", "payment_pending"].includes(order.status)) {
      return res.status(409).json({ error: `El pedido ya está en estado "${order.status}"; no corresponde generar otra preferencia` });
    }

    // Los ítems y precios SIEMPRE salen de lo que ya quedó guardado en la DB
    // al crear el pedido (POST /orders) — nunca de lo que mande el navegador.
    const itemsRes = await pool.query(`SELECT * FROM order_items WHERE order_id = $1 ORDER BY id`, [order.id]);
    if (itemsRes.rows.length === 0) {
      return res.status(409).json({ error: "El pedido no tiene productos cargados" });
    }

    const mpItems = itemsRes.rows.map((it) => ({
      id: it.product_id,
      title: it.product_name + (it.color ? ` (${it.color}${it.size ? ", talle " + it.size : ""})` : ""),
      quantity: it.quantity,
      unit_price: Number(it.unit_price),
      currency_id: "ARS",
    }));

    // El costo de envío (ya calculado y validado en el backend al crear el
    // pedido) se suma como un ítem más de la preferencia, para que Mercado
    // Pago cobre productos + envío y nunca solamente los productos.
    const shippingCost = order.shipping_cost !== null ? Number(order.shipping_cost) : 0;
    if (shippingCost > 0) {
      mpItems.push({
        id: "envio",
        title: order.shipping_product_name ? `Envío — ${order.shipping_product_name}` : "Envío",
        quantity: 1,
        unit_price: shippingCost,
        currency_id: "ARS",
      });
    }

    // El descuento por transferencia no aplica a Mercado Pago (el 10% es
    // exclusivo del medio "transferencia"), así que acá no se resta nada:
    // la preferencia siempre cobra subtotal + envío, sin descuento.

    const frontendUrl = (process.env.FRONTEND_PUBLIC_URL || "").replace(/\/+$/, "");
    const backendUrl = (process.env.BACKEND_PUBLIC_URL || "").replace(/\/+$/, "");

    const preferenceBody = {
      items: mpItems,
      external_reference: order.order_code, // así se relaciona el pago de MP con el pedido de GRIP MEDIAS
      statement_descriptor: "GRIP MEDIAS",
      metadata: { order_id: order.id, order_code: order.order_code },
      payer: {
        name: order.buyer_name,
        surname: order.buyer_lastname,
        email: order.buyer_email || undefined,
        phone: order.buyer_phone ? { number: order.buyer_phone } : undefined,
      },
    };

    if (frontendUrl) {
      preferenceBody.back_urls = {
        success: `${frontendUrl}/#/checkout?mp_status=success&order=${order.order_code}`,
        failure: `${frontendUrl}/#/checkout?mp_status=failure&order=${order.order_code}`,
        pending: `${frontendUrl}/#/checkout?mp_status=pending&order=${order.order_code}`,
      };
      // Mercado Pago exige que back_urls sean HTTPS para poder usar auto_return.
      // En desarrollo local (http://localhost) se arman igual los back_urls,
      // pero auto_return queda deshabilitado hasta que haya HTTPS real.
      if (frontendUrl.startsWith("https://")) {
        preferenceBody.auto_return = "approved";
      }
    }
    if (backendUrl) {
      preferenceBody.notification_url = `${backendUrl}/webhooks/mercadopago`;
    }

    const preference = await getPreferenceClient().create({ body: preferenceBody });

    await pool.query(`UPDATE orders SET mp_preference_id = $1 WHERE id = $2`, [preference.id, order.id]);

    res.status(201).json({
      preferenceId: preference.id,
      initPoint: preference.init_point,
      sandboxInitPoint: preference.sandbox_init_point, // con credenciales TEST, usar este link para pagar sin dinero real
      backUrlsConfigured: !!frontendUrl,
      notificationUrlConfigured: !!backendUrl,
    });
  } catch (err) {
    console.error("[POST /orders/:id/preference]", err);
    res.status(500).json({ error: err.message || "No se pudo generar la preferencia de pago" });
  }
});

/* Valida la firma del webhook (header x-signature) cuando hay
   MERCADOPAGO_WEBHOOK_SECRET configurado. Si no está configurado (por
   ejemplo en desarrollo local sin un secreto todavía asignado en el panel
   de Mercado Pago), se omite la validación para poder seguir probando. */
function isValidSignature(req) {
  const secret = process.env.MERCADOPAGO_WEBHOOK_SECRET;
  if (!secret) return true;

  const signatureHeader = req.headers["x-signature"];
  const requestId = req.headers["x-request-id"];
  const dataId = req.query["data.id"] || (req.body && req.body.data && req.body.data.id);
  if (!signatureHeader || !dataId) return false;

  const parts = {};
  signatureHeader.split(",").forEach((p) => {
    const [k, v] = p.split("=").map((s) => (s || "").trim());
    if (k) parts[k] = v;
  });
  if (!parts.ts || !parts.v1) return false;

  const manifest = `id:${dataId};request-id:${requestId || ""};ts:${parts.ts};`;
  const expected = crypto.createHmac("sha256", secret).update(manifest).digest("hex");
  return expected === parts.v1;
}

// Mercado Pago puede notificar por POST (formato nuevo) o por GET con query params (IPN legacy).
async function handleWebhook(req, res) {
  try {
    if (!isValidSignature(req)) {
      console.warn("[webhook] Firma inválida — se ignora la notificación");
      return res.sendStatus(200); // 200 igual, para que MP no reintente indefinidamente
    }

    const type = (req.body && req.body.type) || req.query.type || req.query.topic;
    const paymentId = (req.body && req.body.data && req.body.data.id) || req.query["data.id"] || req.query.id;

    if (type !== "payment" || !paymentId) {
      return res.sendStatus(200); // otros tipos de notificación (merchant_order, etc.): se ignoran
    }

    const payment = await getPaymentClient().get({ id: paymentId });

    const orderCode = payment.external_reference;
    if (!orderCode) {
      console.warn(`[webhook] El pago ${paymentId} no tiene external_reference`);
      return res.sendStatus(200);
    }

    const orderRes = await pool.query(`SELECT * FROM orders WHERE order_code = $1`, [orderCode]);
    if (orderRes.rows.length === 0) {
      console.warn(`[webhook] No existe el pedido ${orderCode} (pago ${paymentId})`);
      return res.sendStatus(200);
    }
    const order = orderRes.rows[0];

    // Idempotencia: si esta notificación de pago ya se procesó antes (MP puede
    // reenviarla), se actualiza el mismo registro en vez de duplicarlo.
    await pool.query(
      `INSERT INTO payments (order_id, mp_payment_id, status, status_detail, raw_payload)
       VALUES ($1,$2,$3,$4,$5)
       ON CONFLICT (mp_payment_id) WHERE mp_payment_id IS NOT NULL DO UPDATE SET
         status = EXCLUDED.status,
         status_detail = EXCLUDED.status_detail,
         raw_payload = EXCLUDED.raw_payload`,
      [order.id, String(payment.id), payment.status, payment.status_detail, JSON.stringify(payment)]
    );

    const newStatus = mapMpStatusToOrderStatus(payment.status);
    await pool.query(`UPDATE orders SET status = $1, mp_payment_id = $2 WHERE id = $3`, [newStatus, String(payment.id), order.id]);

    console.log(`[webhook] Pedido ${order.order_code}: pago ${payment.id} → "${payment.status}" → orden queda en "${newStatus}"`);
    res.sendStatus(200);
  } catch (err) {
    console.error("[webhook /webhooks/mercadopago]", err);
    // Se responde 200 igual: si devolvemos error, MP reintenta la notificación
    // indefinidamente, y el error puede no depender de MP (ej: DB caída un instante).
    res.sendStatus(200);
  }
}

router.post("/webhooks/mercadopago", handleWebhook);
router.get("/webhooks/mercadopago", handleWebhook);

module.exports = router;
