/* Rutas de acceso al panel de administración (Etapa 1).
   POST /admin/auth/login        usuario + contraseña → token de sesión
   GET  /admin/auth/me           sesión actual (requiere token)
   POST /admin/auth/logout       cierra la sesión actual
   POST /admin/auth/logout-all   cierra TODAS las sesiones
   GET  /admin/auth/activity     últimos accesos registrados
   Solo se registran si ADMIN_USER y ADMIN_PASSWORD_HASH están definidos. */
"use strict";

const express = require("express");
const { pool } = require("../db/pool");
const A = require("../admin/auth");

const router = express.Router();

function noStore(req, res, next) {
  res.set("Cache-Control", "no-store");
  res.set("X-Content-Type-Options", "nosniff");
  next();
}

async function login(req, res) {
  const ip = A.clientIp(req);
  try {
    await A.ensureSchema();

    const body = req.body;
    const username = body && body.username;
    const password = body && body.password;
    if (
      typeof username !== "string" || typeof password !== "string" ||
      !username || !password ||
      username.length > A.MAX_FIELD_LEN || password.length > A.MAX_FIELD_LEN
    ) {
      return res.status(400).json({ error: "Ingresá usuario y contraseña" });
    }

    if (await A.loginBlockedFor(ip)) {
      await A.audit(null, "login_bloqueado", ip);
      res.set("Retry-After", "900");
      return res.status(429).json({ error: "Demasiados intentos. Esperá 15 minutos antes de volver a probar." });
    }

    let ok;
    try {
      ok = await A.verifyCredentials(username, password);
    } catch (err) {
      if (err.code === "BUSY") {
        res.set("Retry-After", "2");
        return res.status(503).json({ error: "El servidor está ocupado. Probá de nuevo en unos segundos." });
      }
      throw err;
    }

    await A.recordAttempt(ip, ok);
    if (!ok) {
      await A.audit(null, "login_fallido", ip);
      return res.status(401).json({ error: "Usuario o contraseña incorrectos" });
    }

    const { token, expiresAt } = await A.createSession(username, req);
    await A.audit(username, "login_ok", ip);
    A.cleanup(); // limpieza oportunista, sin esperar
    res.json({ token, expiresAt, user: { username } });
  } catch (err) {
    console.error("[admin/login]", err.message); // nunca se loguea la contraseña
    res.status(503).json({ error: "No se pudo iniciar sesión en este momento" });
  }
}

async function me(req, res) {
  res.json({ user: { username: req.admin.username }, expiresAt: req.admin.expiresAt });
}

async function logout(req, res) {
  try {
    await A.revokeSession(req.admin.sessionId);
    await A.audit(req.admin.username, "logout", req.admin.ip);
    res.json({ ok: true });
  } catch (err) {
    console.error("[admin/logout]", err.message);
    res.status(500).json({ error: "No se pudo cerrar la sesión" });
  }
}

async function logoutAll(req, res) {
  try {
    await A.revokeAllSessions();
    await A.audit(req.admin.username, "logout_todas", req.admin.ip);
    res.json({ ok: true });
  } catch (err) {
    console.error("[admin/logout-all]", err.message);
    res.status(500).json({ error: "No se pudieron cerrar las sesiones" });
  }
}

async function activity(req, res) {
  try {
    const r = await pool.query(`SELECT at, actor, action, ip FROM admin_audit_log ORDER BY at DESC LIMIT 20`);
    res.json({ activity: r.rows.map((x) => ({ at: x.at, actor: x.actor, action: x.action, ip: x.ip })) });
  } catch (err) {
    console.error("[admin/activity]", err.message);
    res.status(500).json({ error: "No se pudo obtener la actividad" });
  }
}

if (A.getConfig().enabled) {
  router.post("/admin/auth/login", noStore, login);
  router.get("/admin/auth/me", noStore, A.requireAdmin, me);
  router.post("/admin/auth/logout", noStore, A.requireAdmin, logout);
  router.post("/admin/auth/logout-all", noStore, A.requireAdmin, logoutAll);
  router.get("/admin/auth/activity", noStore, A.requireAdmin, activity);
  console.log("[admin] Panel de administración habilitado.");
} else {
  console.log("[admin] Panel de administración deshabilitado (faltan ADMIN_USER / ADMIN_PASSWORD_HASH).");
}

module.exports = router;
