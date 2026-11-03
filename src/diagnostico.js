/* =========================================================
   ⚠️ TEMPORAL — diagnóstico de conectividad Render → Correo Argentino.
   Para eliminarlo: borrar la variable DIAG_TOKEN en Render, borrar este
   archivo y la línea que lo carga en src/server.js.

   - Solo existe si DIAG_TOKEN está definido (mínimo 32 caracteres).
   - Se autoriza con el header "x-diag-token" (nunca por URL), comparado en
     tiempo constante.
   - La URL objetivo está fija en este archivo: no acepta URLs del usuario.
   - No lee ni envía credenciales: no usa CORREO_ARGENTINO_*, MERCADOPAGO_*
     ni DATABASE_URL. Las pruebas van sin Authorization ni cuerpo.
   - Límites: máx. 5 ejecuciones por arranque del servicio, 1 cada 30 s,
     una a la vez; 10 intentos con token inválido bloquean 15 min.
   ========================================================= */
"use strict";

const express = require("express");
const crypto = require("crypto");
const https = require("https");
const dns = require("dns");
const net = require("net");

const router = express.Router();

// Destino fijo (no configurable desde afuera).
const TARGET = { host: "api.correoargentino.com.ar", port: 443, path: "/micorreo/v1/token" };
const IP_ECHO_URLS = [
  { label: "ipv4_o_auto", url: "https://api.ipify.org?format=json" },
  { label: "ipv6_si_existe", url: "https://api64.ipify.org?format=json" },
];

const MAX_CALLS = 5;
const MIN_INTERVAL_MS = 30_000;
const PROBE_TIMEOUT_MS = 30_000;
const IP_ECHO_TIMEOUT_MS = 10_000;
const DNS_TIMEOUT_MS = 10_000;
const MAX_BODY_BYTES = 4096;
const MAX_FAILED_AUTH = 10;
const FAILED_AUTH_WINDOW_MS = 15 * 60 * 1000;

let calls = 0;
let lastCallAt = 0;
let running = false;
let failedAuthAt = []; // timestamps de intentos con token inválido

// ---------- timestamps UTC + hora argentina ----------
const ARG_FMT = new Intl.DateTimeFormat("sv-SE", {
  timeZone: "America/Argentina/Buenos_Aires",
  year: "numeric", month: "2-digit", day: "2-digit",
  hour: "2-digit", minute: "2-digit", second: "2-digit",
  hour12: false,
});
function stamp(ms = Date.now()) {
  const d = new Date(ms);
  const frac = String(d.getUTCMilliseconds()).padStart(3, "0");
  return { utc: d.toISOString(), argentina: `${ARG_FMT.format(d)}.${frac} (UTC-03:00)` };
}

// ---------- autorización ----------
function tokenOk(provided) {
  const expected = process.env.DIAG_TOKEN || "";
  if (!expected || typeof provided !== "string" || !provided) return false;
  const a = crypto.createHash("sha256").update(provided).digest();
  const b = crypto.createHash("sha256").update(expected).digest();
  return crypto.timingSafeEqual(a, b); // mismo largo (sha256), comparación en tiempo constante
}

function pairs(rawHeaders) {
  const out = [];
  for (let i = 0; i < rawHeaders.length; i += 2) out.push(`${rawHeaders[i]}: ${rawHeaders[i + 1]}`);
  return out;
}

// Limita el tiempo de espera de una promesa (la operación subyacente puede seguir, pero ya no bloquea al diagnóstico).
function withTimeout(promise, ms) {
  let t;
  const limit = new Promise((_, reject) => {
    t = setTimeout(() => reject(Object.assign(new Error(`Sin respuesta tras ${ms} ms`), { code: "TIMEOUT" })), ms);
  });
  return Promise.race([promise, limit]).finally(() => clearTimeout(t));
}

// ---------- una prueba HTTP con trazas de cada etapa (equivalente a curl -v) ----------
// Siempre resuelve (nunca rechaza). Una vez resuelta, ningún evento tardío puede modificar el resultado.
function probe({ name, note, method, userAgent, family, target = TARGET }) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    const out = {
      name,
      note,
      request: { method, url: `https://${target.host}${target.path}`, ipFamilyForced: family || "auto" },
      started: stamp(t0),
      ended: null,
      stageReached: "inicio",
      timings: {},
      dns: null,
      connection: null,
      connectionAttemptsFailed: [],
      tls: null,
      response: null,
      error: null,
    };

    const chunks = [];
    let bodySize = 0;
    let settled = false;
    let req = null;
    let timer = null;

    // Cierra la prueba una sola vez: congela el resultado y lo entrega.
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (out.response) out.response.bodyFirstBytes = Buffer.concat(chunks).toString("utf8");
      out.ended = stamp();
      out.timings.totalMs = Date.now() - t0;
      resolve(out);
    };
    const failWith = (code, message) => {
      if (settled) return;
      out.error = { code, message, lastStage: out.stageReached };
      finish();
    };
    const abortRequest = () => {
      if (req) req.destroy();
    };

    timer = setTimeout(() => {
      failWith("TIMEOUT", `Sin respuesta completa tras ${PROBE_TIMEOUT_MS} ms`);
      abortRequest(); // se destruye después de congelar el resultado; sus eventos tardíos se ignoran
    }, PROBE_TIMEOUT_MS);

    const headers = { "User-Agent": userAgent, Accept: "*/*" };
    if (method === "POST") {
      headers["Content-Type"] = "application/json";
      headers["Content-Length"] = "0";
    }

    try {
      req = https.request(
        {
          host: target.host,
          port: target.port,
          path: target.path,
          method,
          headers,
          family: family || undefined,
          agent: false, // conexión nueva: así se ve DNS/TCP/TLS completos
          servername: target.host,
        },
        (res) => {
          if (settled) return;
          out.stageReached = "respuesta recibida (leyendo cuerpo)";
          out.timings.firstByteAtMs = Date.now() - t0;
          out.response = {
            httpVersion: res.httpVersion,
            statusCode: res.statusCode,
            statusMessage: res.statusMessage,
            headers: pairs(res.rawHeaders),
            bodyFirstBytes: "",
            bodyTruncated: false,
          };
          res.on("data", (c) => {
            if (settled) return;
            const room = MAX_BODY_BYTES - bodySize;
            if (c.length > room) {
              // Tope duro: se guarda solo lo que entra, se corta la lectura y se destruye la conexión.
              if (room > 0) chunks.push(c.subarray(0, room));
              bodySize = MAX_BODY_BYTES;
              out.response.bodyTruncated = true;
              out.stageReached = `respuesta recibida (cuerpo cortado a ${MAX_BODY_BYTES} bytes)`;
              finish();
              abortRequest();
              return;
            }
            chunks.push(c);
            bodySize += c.length;
          });
          res.on("end", () => {
            if (settled) return;
            out.stageReached = "respuesta completa";
            finish();
          });
          res.on("error", (err) => failWith(err.code || err.name, err.message));
        }
      );

      req.on("socket", (socket) => {
        if (settled) return;
        out.stageReached = "socket creado (resolviendo DNS)";
        socket.on("lookup", (err, address, fam) => {
          if (settled) return;
          out.timings.dnsDoneAtMs = Date.now() - t0;
          if (err) {
            out.dns = { error: err.code || err.message };
          } else {
            const list = Array.isArray(address) ? address.map((a) => (a && a.address) || a) : address;
            out.dns = { resolvedTo: list, family: fam };
          }
          out.stageReached = "DNS resuelto (conectando TCP)";
        });
        // Node >= 20 prueba IPv6/IPv4 en secuencia: deja constancia de cada intento fallido.
        socket.on("connectionAttemptFailed", (ip, port, fam, error) => {
          if (settled || out.connectionAttemptsFailed.length >= 10) return;
          out.connectionAttemptsFailed.push({
            ip, port, family: fam, atMs: Date.now() - t0, error: error ? error.code || error.message : null,
          });
        });
        socket.on("connect", () => {
          if (settled) return;
          out.timings.tcpConnectedAtMs = Date.now() - t0;
          out.connection = { remoteAddress: socket.remoteAddress, remotePort: socket.remotePort, family: socket.remoteFamily };
          out.stageReached = "TCP conectado (handshake TLS)";
        });
        socket.on("secureConnect", () => {
          if (settled) return;
          out.timings.tlsDoneAtMs = Date.now() - t0;
          const cert = socket.getPeerCertificate();
          const cipher = socket.getCipher();
          out.tls = {
            protocol: socket.getProtocol(),
            cipher: cipher ? cipher.name : null,
            alpnNegotiated: socket.alpnProtocol || null,
            authorized: socket.authorized,
            authorizationError: socket.authorizationError ? String(socket.authorizationError) : null,
            certificate: cert && cert.subject
              ? {
                  subject: cert.subject,
                  issuer: cert.issuer,
                  validFrom: cert.valid_from,
                  validTo: cert.valid_to,
                  subjectAltName: cert.subjectaltname ? String(cert.subjectaltname).slice(0, 300) : null,
                }
              : null,
          };
          out.stageReached = "TLS establecido (enviando petición)";
        });
      });

      req.on("finish", () => {
        if (settled) return;
        out.stageReached = "petición enviada (esperando respuesta)";
        out.timings.requestSentAtMs = Date.now() - t0;
        // Cabeceras tal como salieron (equivalente al "> ..." de curl -v). Solo incluyen User-Agent/Accept/etc., nunca credenciales.
        if (typeof req._header === "string") {
          out.request.headersSent = req._header.split("\r\n").filter(Boolean);
        }
      });

      req.on("error", (err) => failWith(err.code || err.name, err.message));

      req.end(); // sin cuerpo ni credenciales
    } catch (err) {
      failWith(err.code || err.name, err.message);
    }
  });
}

// ---------- IP pública de salida ----------
// Lee como máximo `maxBytes` del cuerpo; si lo supera, aborta.
async function readCapped(response, controller, maxBytes) {
  const reader = response.body.getReader();
  const parts = [];
  let got = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    got += value.length;
    if (got > maxBytes) {
      controller.abort();
      throw new Error("Respuesta demasiado grande");
    }
    parts.push(value);
  }
  return Buffer.concat(parts).toString("utf8");
}

async function discoverPublicIp() {
  return Promise.all(
    IP_ECHO_URLS.map(async ({ label, url }) => {
      const t0 = Date.now();
      const controller = new AbortController();
      const t = setTimeout(() => controller.abort(), IP_ECHO_TIMEOUT_MS); // cubre conexión y lectura del cuerpo
      try {
        const r = await fetch(url, { signal: controller.signal });
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        const data = JSON.parse(await readCapped(r, controller, 512));
        const ip = typeof data.ip === "string" && net.isIP(data.ip) ? data.ip : null; // solo se acepta una IP válida
        return { label, source: new URL(url).host, ip, elapsedMs: Date.now() - t0, observedAt: stamp() };
      } catch (err) {
        return {
          label,
          source: new URL(url).host,
          ip: null,
          error: (err.cause && err.cause.code) || err.name,
          message: err.message,
          elapsedMs: Date.now() - t0,
        };
      } finally {
        clearTimeout(t);
      }
    })
  );
}

// ---------- DNS del destino ----------
// Todas las consultas corren a la vez, cada una con tope de tiempo (el peor caso total ≈ DNS_TIMEOUT_MS).
async function dnsInfo() {
  const resolver = new dns.promises.Resolver({ timeout: 3000, tries: 2 });
  const attempt = async (fn) => {
    try {
      return await withTimeout(fn(), DNS_TIMEOUT_MS);
    } catch (e) {
      return { error: e.code || e.message };
    }
  };
  const t0 = Date.now();
  const [lookupAll, A, AAAA, CNAME] = await Promise.all([
    attempt(async () => {
      const r = await dns.promises.lookup(TARGET.host, { all: true });
      return r;
    }).then((r) => ({ r, ms: Date.now() - t0 })),
    attempt(() => resolver.resolve4(TARGET.host)),
    attempt(() => resolver.resolve6(TARGET.host)),
    attempt(() => resolver.resolveCname(TARGET.host)),
  ]);
  const out = { lookupMs: lookupAll.ms, A, AAAA, CNAME };
  if (lookupAll.r && lookupAll.r.error) out.lookupError = lookupAll.r.error;
  else out.lookupAll = lookupAll.r;
  return out;
}

// ---------- ruta ----------
async function handler(req, res) {
  res.set("Cache-Control", "no-store");
  const now = Date.now();

  failedAuthAt = failedAuthAt.filter((t) => now - t < FAILED_AUTH_WINDOW_MS);
  if (failedAuthAt.length >= MAX_FAILED_AUTH) {
    return res.status(429).json({ error: "Demasiados intentos. Probá más tarde." });
  }
  if (!tokenOk(req.headers["x-diag-token"])) {
    failedAuthAt.push(now);
    return res.status(401).json({ error: "No autorizado" });
  }

  if (running) return res.status(429).json({ error: "Ya hay un diagnóstico en curso" });
  if (calls >= MAX_CALLS) {
    return res.status(429).json({ error: `Límite de ${MAX_CALLS} ejecuciones alcanzado. Reiniciá el servicio para volver a ejecutar.` });
  }
  const wait = MIN_INTERVAL_MS - (now - lastCallAt);
  if (lastCallAt && wait > 0) {
    return res.status(429).json({ error: "Esperá antes de volver a ejecutar", retryAfterSeconds: Math.ceil(wait / 1000) });
  }

  running = true;
  calls += 1;
  lastCallAt = now;
  console.log(`[diagnostico] ejecución ${calls}/${MAX_CALLS}`); // nunca se loguea el token

  try {
    const startedAt = stamp();
    // Las pruebas contra Correo Argentino corren UNA POR UNA (A → B → C), nunca en
    // simultáneo. IP pública y DNS no tocan a Correo Argentino, así que corren aparte.
    const probeDefs = [
      {
        name: "A_GET_estilo_curl",
        note: "Equivale a: curl -v https://api.correoargentino.com.ar/micorreo/v1/token (GET sin credenciales). User-Agent imitando curl solo para replicar el comando pedido.",
        method: "GET",
        userAgent: "curl/8.5.0",
      },
      {
        name: "B_POST_como_la_app",
        note: "POST /token sin credenciales ni cuerpo, como lo hace la aplicación (sin Authorization).",
        method: "POST",
        userAgent: "node",
      },
      {
        name: "C_GET_forzando_IPv4",
        note: "Igual que A pero forzando IPv4.",
        method: "GET",
        userAgent: "curl/8.5.0",
        family: 4,
      },
    ];
    const runProbesSequentially = async () => {
      const results = [];
      for (const def of probeDefs) results.push(await probe(def)); // probe() nunca rechaza: siempre devuelve su resultado
      return results;
    };
    const [publicIp, dnsData, probes] = await Promise.all([
      discoverPublicIp(),
      dnsInfo(),
      runProbesSequentially(),
    ]);

    res.json({
      diagnostico: { ejecucion: `${calls}/${MAX_CALLS}`, nodeVersion: process.version, startedAt, finishedAt: stamp() },
      outboundIp: publicIp,
      dns: dnsData,
      probes,
      aclaraciones: [
        "Node usa HTTP/1.1 (curl suele negociar HTTP/2); es una aproximación a 'curl -v', no una copia exacta.",
        "Las pruebas A, B y C se ejecutaron en ese orden, una por vez (cada una con timeout de 30 s).",
        "Ninguna prueba envía credenciales ni cuerpo.",
      ],
    });
  } catch (err) {
    console.error("[diagnostico] fallo interno:", err.message);
    res.status(500).json({ error: "Fallo interno del diagnóstico" }); // sin detalles internos hacia afuera
  } finally {
    running = false;
  }
}

const token = process.env.DIAG_TOKEN;
if (token && token.length >= 32) {
  router.get("/debug/correo", handler);
} else if (token) {
  console.warn("[diagnostico] DIAG_TOKEN definido pero demasiado corto (mínimo 32 caracteres): la ruta NO se habilita.");
}

// Solo para pruebas locales; no es alcanzable por HTTP.
router._internals = { probe, tokenOk, stamp };

module.exports = router;
