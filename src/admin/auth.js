/* =========================================================
   GRIP SPORTS — acceso privado al panel de administración (Etapa 1)
   =========================================================
   - Un único administrador, definido por variables de entorno:
       ADMIN_USER            nombre de usuario
       ADMIN_PASSWORD_HASH   hash PBKDF2 (se genera con scripts/hash-password.js)
     La contraseña real NUNCA se guarda ni se escribe en el código.
   - Si esas variables no existen, el panel queda DESHABILITADO (las rutas
     /admin/* responden 404) y el resto de la tienda funciona igual.
   - Sesiones con token aleatorio opaco: en la base solo se guarda su hash
     SHA-256, así que ni una filtración de la base permite usarlo. Se pueden
     revocar (cerrar sesión) y vencen por inactividad y por antigüedad.
   - Límite de intentos persistido en la base (sobrevive a reinicios).
   - No usa dependencias nuevas: solo "crypto" de Node.
   - No toca ninguna tabla existente: crea solo tablas nuevas (admin_*).
   ========================================================= */
"use strict";

const crypto = require("crypto");
const { pool } = require("../db/pool");

// ---------- parámetros ----------
const SESSION_IDLE_MS = 30 * 60 * 1000; // se cierra tras 30 min sin actividad
const SESSION_MAX_MS = 8 * 60 * 60 * 1000; // y como máximo a las 8 h
const LAST_SEEN_UPDATE_MS = 60 * 1000; // no escribir last_seen en cada request
const ATTEMPT_WINDOW_MS = 15 * 60 * 1000;
const MAX_FAILED_PER_IP = 5; // intentos fallidos por IP cada 15 min
const MAX_FAILED_GLOBAL = 30; // tope general (protege contra ataques distribuidos)
const MAX_PARALLEL_HASHES = 2; // evita agotar la CPU del servidor con logins simultáneos
const MAX_FIELD_LEN = 200;

const MIN_ITERATIONS = 100_000;
const MAX_ITERATIONS = 5_000_000;

// ---------- esquema (solo tablas NUEVAS, idempotente) ----------
const SCHEMA_SQL = [
  `CREATE TABLE IF NOT EXISTS admin_sessions (
     id            SERIAL PRIMARY KEY,
     token_hash    TEXT UNIQUE NOT NULL,
     username      TEXT NOT NULL,
     created_at    TIMESTAMPTZ NOT NULL,
     last_seen_at  TIMESTAMPTZ NOT NULL,
     expires_at    TIMESTAMPTZ NOT NULL,
     revoked_at    TIMESTAMPTZ,
     ip            TEXT,
     user_agent    TEXT
   )`,
  `CREATE TABLE IF NOT EXISTS admin_login_attempts (
     id       SERIAL PRIMARY KEY,
     at       TIMESTAMPTZ NOT NULL,
     ip       TEXT,
     success  BOOLEAN NOT NULL
   )`,
  `CREATE TABLE IF NOT EXISTS admin_audit_log (
     id      SERIAL PRIMARY KEY,
     at      TIMESTAMPTZ NOT NULL,
     actor   TEXT,
     action  TEXT NOT NULL,
     ip      TEXT,
     detail  TEXT
   )`,
  `CREATE INDEX IF NOT EXISTS idx_admin_attempts_at ON admin_login_attempts (at)`,
  `CREATE INDEX IF NOT EXISTS idx_admin_sessions_exp ON admin_sessions (expires_at)`,
  `CREATE INDEX IF NOT EXISTS idx_admin_audit_at ON admin_audit_log (at)`,
];

let schemaPromise = null;
function ensureSchema() {
  if (!schemaPromise) {
    schemaPromise = (async () => {
      for (const sql of SCHEMA_SQL) await pool.query(sql);
    })().catch((err) => {
      schemaPromise = null; // permite reintentar en el próximo request
      throw err;
    });
  }
  return schemaPromise;
}

// ---------- configuración ----------
function getConfig() {
  const user = process.env.ADMIN_USER || "";
  const hash = process.env.ADMIN_PASSWORD_HASH || "";
  return { user, hash, enabled: !!(user && hash) };
}

function parseHash(stored) {
  // formato: pbkdf2-sha256:<iteraciones>:<sal base64url>:<hash base64url>
  const parts = String(stored).split(":");
  if (parts.length !== 4 || parts[0] !== "pbkdf2-sha256") return null;
  const iterations = Number(parts[1]);
  if (!Number.isInteger(iterations) || iterations < MIN_ITERATIONS || iterations > MAX_ITERATIONS) return null;
  const salt = Buffer.from(parts[2], "base64url");
  const expected = Buffer.from(parts[3], "base64url");
  if (salt.length < 16 || expected.length < 32) return null;
  return { iterations, salt, expected };
}

// Hash de relleno para que "usuario inexistente" tarde lo mismo que "contraseña incorrecta".
const DUMMY = { iterations: 600_000, salt: crypto.randomBytes(16), expected: crypto.randomBytes(32) };

let activeHashes = 0;
function pbkdf2(password, salt, iterations, length) {
  return new Promise((resolve, reject) => {
    crypto.pbkdf2(password, salt, iterations, length, "sha256", (err, key) => (err ? reject(err) : resolve(key)));
  });
}

function safeEqualStr(a, b) {
  const ha = crypto.createHash("sha256").update(String(a)).digest();
  const hb = crypto.createHash("sha256").update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
}

/* Verifica usuario + contraseña en tiempo constante. Devuelve true/false.
   Lanza BUSY si ya hay demasiadas verificaciones en curso. */
async function verifyCredentials(username, password) {
  const cfg = getConfig();
  if (activeHashes >= MAX_PARALLEL_HASHES) {
    const err = new Error("busy");
    err.code = "BUSY";
    throw err;
  }
  activeHashes++;
  try {
    const parsed = parseHash(cfg.hash) || DUMMY;
    const derived = await pbkdf2(password, parsed.salt, parsed.iterations, parsed.expected.length);
    const passOk = crypto.timingSafeEqual(derived, parsed.expected);
    const userOk = safeEqualStr(username, cfg.user);
    return passOk && userOk && parsed !== DUMMY;
  } finally {
    activeHashes--;
  }
}

// ---------- utilidades ----------
function sha256Hex(s) {
  return crypto.createHash("sha256").update(s).digest("hex");
}

/* IP del cliente. Detrás del proxy de Render el último valor de
   X-Forwarded-For lo agrega el propio proxy (el cliente no lo puede falsear). */
function clientIp(req) {
  const xff = req.headers && req.headers["x-forwarded-for"];
  if (typeof xff === "string" && xff.trim()) {
    const parts = xff.split(",").map((s) => s.trim()).filter(Boolean);
    return parts[parts.length - 1].slice(0, 64);
  }
  return ((req.socket && req.socket.remoteAddress) || "desconocida").slice(0, 64);
}

function shortUa(req) {
  const ua = req.headers && req.headers["user-agent"];
  return typeof ua === "string" ? ua.slice(0, 200) : null;
}

async function audit(actor, action, ip, detail) {
  try {
    await pool.query(`INSERT INTO admin_audit_log (at, actor, action, ip, detail) VALUES ($1,$2,$3,$4,$5)`, [
      new Date(),
      actor || null,
      action,
      ip || null,
      detail ? JSON.stringify(detail).slice(0, 2000) : null,
    ]);
  } catch (err) {
    console.error("[admin] No se pudo registrar la auditoría:", err.message);
  }
}

// ---------- límite de intentos ----------
async function loginBlockedFor(ip) {
  const since = new Date(Date.now() - ATTEMPT_WINDOW_MS);
  const perIp = await pool.query(
    `SELECT COUNT(*) AS n FROM admin_login_attempts WHERE success = $1 AND at > $2 AND ip = $3`,
    [false, since, ip]
  );
  if (Number(perIp.rows[0].n) >= MAX_FAILED_PER_IP) return true;
  const global = await pool.query(`SELECT COUNT(*) AS n FROM admin_login_attempts WHERE success = $1 AND at > $2`, [false, since]);
  return Number(global.rows[0].n) >= MAX_FAILED_GLOBAL;
}

async function recordAttempt(ip, success) {
  await pool.query(`INSERT INTO admin_login_attempts (at, ip, success) VALUES ($1,$2,$3)`, [new Date(), ip, success]);
}

async function cleanup() {
  try {
    const now = new Date();
    await pool.query(`DELETE FROM admin_sessions WHERE expires_at < $1 OR revoked_at IS NOT NULL AND revoked_at < $2`, [
      now,
      new Date(now.getTime() - 24 * 60 * 60 * 1000),
    ]);
    await pool.query(`DELETE FROM admin_login_attempts WHERE at < $1`, [new Date(now.getTime() - 24 * 60 * 60 * 1000)]);
  } catch (err) {
    console.error("[admin] Error limpiando registros viejos:", err.message);
  }
}

// ---------- sesiones ----------
async function createSession(username, req) {
  const token = crypto.randomBytes(32).toString("base64url");
  const now = new Date();
  const expiresAt = new Date(now.getTime() + SESSION_MAX_MS);
  await pool.query(
    `INSERT INTO admin_sessions (token_hash, username, created_at, last_seen_at, expires_at, ip, user_agent)
     VALUES ($1,$2,$3,$4,$5,$6,$7)`,
    [sha256Hex(token), username, now, now, expiresAt, clientIp(req), shortUa(req)]
  );
  return { token, expiresAt };
}

function toMs(v) {
  return v instanceof Date ? v.getTime() : new Date(v).getTime();
}

/* Middleware: exige "Authorization: Bearer <token>" válido, no revocado, no vencido
   y con actividad reciente. Deja la sesión en req.admin. Se reutilizará en las
   próximas etapas para proteger todas las rutas del panel. */
async function requireAdmin(req, res, next) {
  try {
    res.set("Cache-Control", "no-store");
    if (!getConfig().enabled) return res.status(404).json({ error: "Ruta no encontrada" });
    await ensureSchema();

    const header = req.headers.authorization || "";
    const match = /^Bearer ([A-Za-z0-9_-]{20,100})$/.exec(header);
    if (!match) return res.status(401).json({ error: "No autorizado" });

    const found = await pool.query(
      `SELECT id, username, created_at, last_seen_at, expires_at, revoked_at FROM admin_sessions WHERE token_hash = $1`,
      [sha256Hex(match[1])]
    );
    const s = found.rows[0];
    const now = Date.now();
    if (!s || s.revoked_at || toMs(s.expires_at) <= now || now - toMs(s.last_seen_at) > SESSION_IDLE_MS) {
      return res.status(401).json({ error: "Sesión vencida. Ingresá de nuevo." });
    }

    if (now - toMs(s.last_seen_at) > LAST_SEEN_UPDATE_MS) {
      await pool.query(`UPDATE admin_sessions SET last_seen_at = $1 WHERE id = $2`, [new Date(now), s.id]);
    }
    req.admin = {
      sessionId: s.id,
      username: s.username,
      expiresAt: new Date(toMs(s.expires_at)),
      ip: clientIp(req),
    };
    next();
  } catch (err) {
    console.error("[admin] Error validando la sesión:", err.message);
    res.status(503).json({ error: "El panel no está disponible en este momento" });
  }
}

async function revokeSession(id) {
  await pool.query(`UPDATE admin_sessions SET revoked_at = $1 WHERE id = $2 AND revoked_at IS NULL`, [new Date(), id]);
}

async function revokeAllSessions() {
  await pool.query(`UPDATE admin_sessions SET revoked_at = $1 WHERE revoked_at IS NULL`, [new Date()]);
}

module.exports = {
  ensureSchema,
  getConfig,
  verifyCredentials,
  clientIp,
  audit,
  loginBlockedFor,
  recordAttempt,
  cleanup,
  createSession,
  requireAdmin,
  revokeSession,
  revokeAllSessions,
  MAX_FIELD_LEN,
  _internals: { parseHash, pbkdf2, SESSION_IDLE_MS, SESSION_MAX_MS },
};
