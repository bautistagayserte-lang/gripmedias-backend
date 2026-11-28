/* =========================================================
   GRIP SPORTS — administración de pedidos (Etapa 2)
   =========================================================
   Rutas (TODAS exigen sesión de administrador válida):
     GET  /admin/orders                          listado, búsqueda, filtros y paginación
     GET  /admin/orders/:id                      detalle completo de un pedido
     POST /admin/orders/:id/status               avanza / retrocede un paso el estado operativo
     POST /admin/orders/:id/transfer-confirmation  confirma (o quita) la recepción de una transferencia
     POST /admin/orders/:id/notes                edita código de seguimiento y nota interna

   Principios:
   - El ESTADO DE PAGO (orders.status, lo escribe el webhook de Mercado Pago) es de solo
     lectura acá: este archivo NUNCA hace UPDATE ni INSERT sobre orders, payments,
     order_items ni variants (stock). Solo lee esas tablas.
   - El ESTADO OPERATIVO (preparando / enviado / entregado-retirado), la confirmación
     de transferencia, el seguimiento y la nota viven en tablas NUEVAS e independientes:
     admin_order_fulfillment y admin_order_events. El webhook no las conoce.
   - Nunca se devuelve payments.raw_payload ni mp_preference_id: las consultas a
     payments piden columnas explícitas.
   Solo se registra si ADMIN_USER y ADMIN_PASSWORD_HASH están definidos. */
"use strict";

const express = require("express");
const { pool } = require("../db/pool");
const A = require("../admin/auth");

const router = express.Router();

// ---------- constantes ----------
const PAGE_SIZE = 25;
const MAX_QUERY_LEN = 100;
const MAX_NOTE_LEN = 1000;
const TRACKING_RE = /^[A-Za-z0-9][A-Za-z0-9 ._\/-]{0,59}$/;

const FULFILLMENT_STATES = ["none", "preparing", "shipped", "delivered"];
// Único estado de pago (orders.status) que prueba un pago aprobado de Mercado Pago:
// el que escribe el webhook con approved -> "paid". preparing/shipped/completed existen
// en el CHECK de la base pero ningún código actual los escribe: si aparecen (ediciones
// manuales antiguas) NO se interpretan como pago aprobado.
const PAID_STATUS = "paid";
const PAY_BLOCKED = new Set(["rejected", "cancelled"]);
const PAYMENT_FILTERS = ["pending", "payment_pending", "paid", "rejected", "cancelled"];
const FULFILLMENT_FILTERS = ["none", "preparing", "shipped", "delivered", "transfer_pending"];

const PAYMENT_LABELS = {
  pending: "Sin pagar",
  payment_pending: "Pago pendiente",
  paid: "Pagado",
  rejected: "Rechazado",
  cancelled: "Cancelado",
  // Estados operativos antiguos: no prueban un pago aprobado.
  preparing: "Estado anterior (pago sin verificar)",
  shipped: "Estado anterior (pago sin verificar)",
  completed: "Estado anterior (pago sin verificar)",
};

// ---------- esquema (solo tablas NUEVAS, idempotente) ----------
const SCHEMA_SQL = [
  `CREATE TABLE IF NOT EXISTS admin_order_fulfillment (
     order_id              INTEGER PRIMARY KEY REFERENCES orders(id) ON DELETE CASCADE,
     fulfillment_status    TEXT NOT NULL DEFAULT 'none'
                             CHECK (fulfillment_status IN ('none','preparing','shipped','delivered')),
     transfer_confirmed_at TIMESTAMPTZ,
     transfer_confirmed_by TEXT,
     tracking_code         TEXT,
     internal_note         TEXT,
     updated_at            TIMESTAMPTZ NOT NULL,
     updated_by            TEXT
   )`,
  `CREATE TABLE IF NOT EXISTS admin_order_events (
     id          SERIAL PRIMARY KEY,
     order_id    INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
     at          TIMESTAMPTZ NOT NULL,
     actor       TEXT,
     event       TEXT NOT NULL,
     from_value  TEXT,
     to_value    TEXT
   )`,
  `CREATE INDEX IF NOT EXISTS idx_admin_order_events_order ON admin_order_events (order_id, at)`,
];

let schemaPromise = null;
function ensureOrdersSchema() {
  if (!schemaPromise) {
    schemaPromise = (async () => {
      for (const sql of SCHEMA_SQL) await pool.query(sql);
    })().catch((err) => {
      schemaPromise = null;
      throw err;
    });
  }
  return schemaPromise;
}

// ---------- utilidades ----------
class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function noStore(req, res, next) {
  res.set("Cache-Control", "no-store");
  res.set("X-Content-Type-Options", "nosniff");
  next();
}

function parseId(v) {
  return /^\d{1,9}$/.test(String(v)) ? Number(v) : null;
}

function num(v) {
  return v === null || v === undefined ? null : Number(v);
}

function escapeLike(s) {
  return s.replace(/[\\%_]/g, (m) => "\\" + m);
}

function flowFor(order) {
  // Retiro en persona no pasa por "Enviado".
  return order.shipping_method === "retiro"
    ? ["none", "preparing", "delivered"]
    : ["none", "preparing", "shipped", "delivered"];
}

function fulfillmentLabel(status, shippingMethod) {
  switch (status) {
    case "preparing": return "Preparando";
    case "shipped": return "Enviado";
    case "delivered": return shippingMethod === "retiro" ? "Retirado" : "Entregado";
    default: return "Sin preparar";
  }
}

function paymentLabel(order) {
  if (order.status === "payment_pending" && order.payment_method === "transferencia") return "Pendiente (transferencia)";
  return PAYMENT_LABELS[order.status] || order.status;
}

/* Reglas del estado operativo. Es la ÚNICA fuente de verdad: el panel solo muestra
   lo que esta función permite y el servidor la vuelve a aplicar al guardar. */
function computeActions(order, f) {
  const cur = f ? f.fulfillment_status : "none";
  const steps = flowFor(order);
  let idx = steps.indexOf(cur);
  if (idx < 0) idx = 0;
  const isTransfer = order.payment_method === "transferencia";
  const confirmed = !!(f && f.transfer_confirmed_at);
  const payBlocked = PAY_BLOCKED.has(order.status);

  let next = null;
  if (idx < steps.length - 1) {
    const to = steps[idx + 1];
    let reason = null;
    if (payBlocked) {
      reason = order.status === "rejected" ? "El pago fue rechazado: no se puede avanzar." : "El pedido está cancelado: no se puede avanzar.";
    } else if (cur === "none") {
      if (isTransfer && !confirmed) reason = "Primero confirmá la recepción de la transferencia.";
      else if (!isTransfer && order.status !== PAID_STATUS) reason = "El pago de Mercado Pago todavía no está aprobado.";
    }
    next = { to, label: fulfillmentLabel(to, order.shipping_method), blockedReason: reason };
  }
  let prev = null;
  if (idx > 0) prev = { to: steps[idx - 1], label: fulfillmentLabel(steps[idx - 1], order.shipping_method) };

  return {
    next,
    prev,
    canConfirmTransfer: isTransfer && !confirmed && !payBlocked,
    canUnconfirmTransfer: isTransfer && confirmed && cur === "none",
  };
}

// ---------- listado ----------
async function listOrders(req, res) {
  await ensureOrdersSchema();
  const query = req.query || {};

  const q = typeof query.q === "string" ? query.q.replace(/\s+/g, " ").trim().slice(0, MAX_QUERY_LEN) : "";
  const payment = typeof query.payment === "string" ? query.payment : "";
  const fulfillment = typeof query.fulfillment === "string" ? query.fulfillment : "";
  if (payment && !PAYMENT_FILTERS.includes(payment)) throw new HttpError(400, "Filtro de pago inválido");
  if (fulfillment && !FULFILLMENT_FILTERS.includes(fulfillment)) throw new HttpError(400, "Filtro de estado inválido");
  let page = parseInt(query.page, 10);
  if (!Number.isInteger(page) || page < 1) page = 1;
  if (page > 100000) page = 100000;

  const where = [];
  const params = [];
  const add = (v) => {
    params.push(v);
    return "$" + params.length;
  };

  if (q) {
    const p = add("%" + escapeLike(q) + "%");
    where.push(
      `(o.order_code ILIKE ${p} ESCAPE '\\' OR o.buyer_name ILIKE ${p} ESCAPE '\\' OR o.buyer_lastname ILIKE ${p} ESCAPE '\\'
        OR (o.buyer_name || ' ' || o.buyer_lastname) ILIKE ${p} ESCAPE '\\'
        OR (o.buyer_lastname || ' ' || o.buyer_name) ILIKE ${p} ESCAPE '\\'
        OR o.buyer_email ILIKE ${p} ESCAPE '\\' OR o.buyer_phone ILIKE ${p} ESCAPE '\\')`
    );
  }
  if (payment) where.push(`o.status = ${add(payment)}`);

  if (fulfillment === "none") where.push(`(f.fulfillment_status IS NULL OR f.fulfillment_status = 'none')`);
  else if (fulfillment === "transfer_pending") {
    where.push(`(o.payment_method = 'transferencia' AND f.transfer_confirmed_at IS NULL AND o.status NOT IN ('rejected','cancelled'))`);
  } else if (fulfillment) where.push(`f.fulfillment_status = ${add(fulfillment)}`);

  const whereSql = where.length ? "WHERE " + where.join(" AND ") : "";
  const from = `FROM orders o LEFT JOIN admin_order_fulfillment f ON f.order_id = o.id`;

  const count = await pool.query(`SELECT COUNT(*) AS n ${from} ${whereSql}`, params);
  const total = Number(count.rows[0].n);
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  if (page > totalPages) page = totalPages;

  const limitP = add(PAGE_SIZE);
  const offsetP = add((page - 1) * PAGE_SIZE);
  const rows = await pool.query(
    `SELECT o.id, o.order_code, o.status, o.buyer_name, o.buyer_lastname, o.buyer_email,
            o.shipping_method, o.payment_method, o.total, o.created_at,
            (SELECT COALESCE(SUM(i.quantity), 0) FROM order_items i WHERE i.order_id = o.id) AS units,
            f.fulfillment_status, f.transfer_confirmed_at
     ${from} ${whereSql}
     ORDER BY o.created_at DESC, o.id DESC
     LIMIT ${limitP} OFFSET ${offsetP}`,
    params
  );

  res.json({
    page,
    pageSize: PAGE_SIZE,
    total,
    totalPages,
    orders: rows.rows.map((r) => {
      const fStatus = r.fulfillment_status || "none";
      return {
        id: r.id,
        orderCode: r.order_code,
        createdAt: r.created_at,
        buyer: { name: `${r.buyer_name} ${r.buyer_lastname}`.trim(), email: r.buyer_email },
        total: num(r.total),
        units: Number(r.units),
        paymentMethod: r.payment_method,
        shippingMethod: r.shipping_method,
        payment: { status: r.status, label: paymentLabel(r) },
        fulfillment: { status: fStatus, label: fulfillmentLabel(fStatus, r.shipping_method) },
        transferConfirmed: !!r.transfer_confirmed_at,
      };
    }),
  });
}

// ---------- detalle ----------
async function loadDetail(id) {
  const o = (await pool.query(`SELECT * FROM orders WHERE id = $1`, [id])).rows[0];
  if (!o) return null;
  const items = await pool.query(
    `SELECT product_id, product_name, color, size, unit_price, quantity, line_total FROM order_items WHERE order_id = $1 ORDER BY id`,
    [id]
  );
  // Columnas explícitas: jamás raw_payload.
  const pays = await pool.query(
    `SELECT mp_payment_id, status, status_detail, created_at FROM payments WHERE order_id = $1 ORDER BY created_at DESC, id DESC LIMIT 20`,
    [id]
  );
  const f = (await pool.query(`SELECT * FROM admin_order_fulfillment WHERE order_id = $1`, [id])).rows[0] || null;
  const events = await pool.query(
    `SELECT at, actor, event, from_value, to_value FROM admin_order_events WHERE order_id = $1 ORDER BY at DESC, id DESC LIMIT 50`,
    [id]
  );
  const fStatus = f ? f.fulfillment_status : "none";

  return {
    id: o.id,
    orderCode: o.order_code,
    createdAt: o.created_at,
    updatedAt: o.updated_at,
    buyer: { name: o.buyer_name, lastname: o.buyer_lastname, email: o.buyer_email, phone: o.buyer_phone },
    shipping: {
      method: o.shipping_method,
      cp: o.shipping_cp,
      province: o.shipping_province,
      locality: o.shipping_locality,
      address: o.shipping_address,
      notes: o.shipping_notes,
      cost: num(o.shipping_cost),
    },
    amounts: { subtotal: num(o.subtotal), shipping: num(o.shipping_cost), discount: num(o.discount) || 0, total: num(o.total) },
    payment: {
      method: o.payment_method,
      status: o.status,
      label: paymentLabel(o),
      mpPaymentId: o.mp_payment_id || null,
      notifications: pays.rows.map((p) => ({
        mpPaymentId: p.mp_payment_id,
        status: p.status,
        statusDetail: p.status_detail,
        at: p.created_at,
      })),
    },
    items: items.rows.map((i) => ({
      productId: i.product_id,
      name: i.product_name,
      color: i.color,
      size: i.size,
      unitPrice: num(i.unit_price),
      quantity: i.quantity,
      lineTotal: num(i.line_total),
    })),
    fulfillment: {
      status: fStatus,
      label: fulfillmentLabel(fStatus, o.shipping_method),
      trackingCode: f ? f.tracking_code : null,
      note: f ? f.internal_note : null,
      transferConfirmedAt: f ? f.transfer_confirmed_at : null,
      transferConfirmedBy: f ? f.transfer_confirmed_by : null,
      updatedAt: f ? f.updated_at : null,
      updatedBy: f ? f.updated_by : null,
    },
    actions: computeActions(o, f),
    history: events.rows.map((e) => ({ at: e.at, actor: e.actor, event: e.event, from: e.from_value, to: e.to_value })),
  };
}

async function getOrder(req, res) {
  await ensureOrdersSchema();
  const id = parseId(req.params.id);
  if (!id) throw new HttpError(400, "Número de pedido inválido");
  const detail = await loadDetail(id);
  if (!detail) throw new HttpError(404, "Pedido no encontrado");
  res.json({ order: detail });
}

// ---------- escritura (siempre en transacción, solo sobre las tablas nuevas) ----------
async function withOrderTx(id, fn) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const order = (await client.query(`SELECT * FROM orders WHERE id = $1`, [id])).rows[0];
    if (!order) throw new HttpError(404, "Pedido no encontrado");
    await client.query(
      `INSERT INTO admin_order_fulfillment (order_id, fulfillment_status, updated_at) VALUES ($1, 'none', $2)
       ON CONFLICT (order_id) DO NOTHING`,
      [id, new Date()]
    );
    // Bloquea la fila operativa (NO la de orders: así nunca se frena al webhook de Mercado Pago).
    const f = (await client.query(`SELECT * FROM admin_order_fulfillment WHERE order_id = $1 FOR UPDATE`, [id])).rows[0];
    const result = await fn(client, order, f);
    await client.query("COMMIT");
    return result;
  } catch (err) {
    try { await client.query("ROLLBACK"); } catch (_) { /* nada */ }
    throw err;
  } finally {
    client.release();
  }
}

function addEvent(client, orderId, actor, event, from, to) {
  return client.query(
    `INSERT INTO admin_order_events (order_id, at, actor, event, from_value, to_value) VALUES ($1,$2,$3,$4,$5,$6)`,
    [orderId, new Date(), actor, event, from === null || from === undefined ? null : String(from).slice(0, 200), to === null || to === undefined ? null : String(to).slice(0, 200)]
  );
}

async function changeStatus(req, res) {
  await ensureOrdersSchema();
  const id = parseId(req.params.id);
  if (!id) throw new HttpError(400, "Número de pedido inválido");
  const body = req.body || {};
  const { to, from } = body;
  if (!FULFILLMENT_STATES.includes(to) || !FULFILLMENT_STATES.includes(from)) throw new HttpError(400, "Estado inválido");

  const info = await withOrderTx(id, async (client, order, f) => {
    if (f.fulfillment_status !== from) {
      throw new HttpError(409, "El pedido cambió mientras lo mirabas. Recargá la página e intentá de nuevo.");
    }
    const actions = computeActions(order, f);
    if (actions.next && actions.next.to === to) {
      if (actions.next.blockedReason) throw new HttpError(409, actions.next.blockedReason);
    } else if (!(actions.prev && actions.prev.to === to)) {
      throw new HttpError(409, "Ese cambio de estado no está permitido (solo se avanza o se vuelve un paso).");
    }
    await client.query(`UPDATE admin_order_fulfillment SET fulfillment_status = $1, updated_at = $2, updated_by = $3 WHERE order_id = $4`, [
      to, new Date(), req.admin.username, id,
    ]);
    await addEvent(client, id, req.admin.username, "estado", fulfillmentLabel(from, order.shipping_method), fulfillmentLabel(to, order.shipping_method));
    return { orderCode: order.order_code, from, to };
  });

  await A.audit(req.admin.username, "pedido_estado", req.admin.ip, info);
  res.json({ order: await loadDetail(id) });
}

async function transferConfirmation(req, res) {
  await ensureOrdersSchema();
  const id = parseId(req.params.id);
  if (!id) throw new HttpError(400, "Número de pedido inválido");
  const confirmed = req.body && req.body.confirmed;
  if (typeof confirmed !== "boolean") throw new HttpError(400, "Dato inválido");

  const info = await withOrderTx(id, async (client, order, f) => {
    if (order.payment_method !== "transferencia") throw new HttpError(409, "Este pedido no se paga por transferencia.");
    const isConfirmed = !!f.transfer_confirmed_at;
    if (confirmed) {
      if (PAY_BLOCKED.has(order.status)) throw new HttpError(409, "El pedido está rechazado o cancelado.");
      if (isConfirmed) throw new HttpError(409, "La transferencia ya estaba confirmada.");
      const now = new Date();
      await client.query(
        `UPDATE admin_order_fulfillment SET transfer_confirmed_at = $1, transfer_confirmed_by = $2, updated_at = $1, updated_by = $2 WHERE order_id = $3`,
        [now, req.admin.username, id]
      );
      await addEvent(client, id, req.admin.username, "transferencia_confirmada", null, null);
      return { orderCode: order.order_code, action: "transferencia_confirmada" };
    }
    if (!isConfirmed) throw new HttpError(409, "La transferencia no estaba confirmada.");
    if (f.fulfillment_status !== "none") throw new HttpError(409, "Para quitar la confirmación, primero volvé el pedido a 'Sin preparar'.");
    await client.query(
      `UPDATE admin_order_fulfillment SET transfer_confirmed_at = NULL, transfer_confirmed_by = NULL, updated_at = $1, updated_by = $2 WHERE order_id = $3`,
      [new Date(), req.admin.username, id]
    );
    await addEvent(client, id, req.admin.username, "transferencia_confirmacion_quitada", null, null);
    return { orderCode: order.order_code, action: "transferencia_confirmacion_quitada" };
  });

  await A.audit(req.admin.username, "pedido_" + info.action, req.admin.ip, { orderCode: info.orderCode });
  res.json({ order: await loadDetail(id) });
}

function cleanNote(v) {
  // Quita caracteres de control (salvo salto de línea y tabulación) y recorta los bordes.
  return v.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "").replace(/\r\n?/g, "\n").trim();
}

async function saveNotes(req, res) {
  await ensureOrdersSchema();
  const id = parseId(req.params.id);
  if (!id) throw new HttpError(400, "Número de pedido inválido");
  const body = req.body || {};
  const hasTracking = body.trackingCode !== undefined;
  const hasNote = body.note !== undefined;
  if (!hasTracking && !hasNote) throw new HttpError(400, "No hay nada para guardar");

  let tracking;
  let note;
  if (hasTracking) {
    if (typeof body.trackingCode !== "string") throw new HttpError(400, "Código de seguimiento inválido");
    tracking = body.trackingCode.trim();
    if (tracking && !TRACKING_RE.test(tracking)) {
      throw new HttpError(400, "El código de seguimiento solo puede tener letras, números, espacios y . _ / - (máx. 60 caracteres).");
    }
  }
  if (hasNote) {
    if (typeof body.note !== "string") throw new HttpError(400, "Nota inválida");
    note = cleanNote(body.note);
    if (note.length > MAX_NOTE_LEN) throw new HttpError(400, `La nota no puede superar los ${MAX_NOTE_LEN} caracteres.`);
  }

  const info = await withOrderTx(id, async (client, order, f) => {
    const sets = [];
    const params = [];
    const changed = [];
    if (hasTracking && (tracking || null) !== (f.tracking_code || null)) {
      params.push(tracking || null);
      sets.push(`tracking_code = $${params.length}`);
      await addEvent(client, id, req.admin.username, "seguimiento", f.tracking_code, tracking || null);
      changed.push("seguimiento");
    }
    if (hasNote && (note || null) !== (f.internal_note || null)) {
      params.push(note || null);
      sets.push(`internal_note = $${params.length}`);
      await addEvent(client, id, req.admin.username, "nota", null, note ? `(${note.length} caracteres)` : "(borrada)");
      changed.push("nota");
    }
    if (sets.length) {
      params.push(new Date(), req.admin.username, id);
      await client.query(
        `UPDATE admin_order_fulfillment SET ${sets.join(", ")}, updated_at = $${params.length - 2}, updated_by = $${params.length - 1} WHERE order_id = $${params.length}`,
        params
      );
    }
    return { orderCode: order.order_code, changed };
  });

  if (info.changed.length) await A.audit(req.admin.username, "pedido_notas", req.admin.ip, info);
  res.json({ order: await loadDetail(id), changed: info.changed });
}

// ---------- envoltorio de errores ----------
function wrap(fn) {
  return async (req, res) => {
    try {
      await fn(req, res);
    } catch (err) {
      if (err instanceof HttpError) return res.status(err.status).json({ error: err.message });
      console.error("[admin/orders]", err.message); // sin datos del pedido ni del cliente
      res.status(503).json({ error: "No se pudo completar la operación. Probá de nuevo." });
    }
  };
}

if (A.getConfig().enabled) {
  router.get("/admin/orders", noStore, A.requireAdmin, wrap(listOrders));
  router.get("/admin/orders/:id", noStore, A.requireAdmin, wrap(getOrder));
  router.post("/admin/orders/:id/status", noStore, A.requireAdmin, wrap(changeStatus));
  router.post("/admin/orders/:id/transfer-confirmation", noStore, A.requireAdmin, wrap(transferConfirmation));
  router.post("/admin/orders/:id/notes", noStore, A.requireAdmin, wrap(saveNotes));
}

module.exports = router;
