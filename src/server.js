require("dotenv").config();
const express = require("express");
const cors = require("cors");
 
const productsRouter = require("./routes/products");
const ordersRouter = require("./routes/orders");
const paymentsRouter = require("./routes/payments");
const shippingRouter = require("./routes/shipping");
const { pool } = require("./db/pool");
 
const app = express();
 
const allowedOrigins = (process.env.CORS_ORIGINS || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);
 
app.use(
  cors({
    origin(origin, callback) {
      // Permite herramientas sin origin (curl, Postman) y los orígenes configurados.
      if (!origin || allowedOrigins.length === 0 || allowedOrigins.includes(origin)) {
        return callback(null, true);
      }
      callback(new Error("Origen no permitido por CORS: " + origin));
    },
  })
);
app.use(express.json());
 
// Log simple de cada request (útil para depurar en desarrollo)
app.use((req, res, next) => {
  const start = Date.now();
  res.on("finish", () => {
    console.log(`${req.method} ${req.originalUrl} → ${res.statusCode} (${Date.now() - start}ms)`);
  });
  next();
});
 
app.get("/health", async (req, res) => {
  try {
    await pool.query("SELECT 1");
    res.json({ ok: true, db: "connected" });
  } catch (err) {
    res.status(500).json({ ok: false, db: "unreachable", error: err.message });
  }
});
 
app.use(productsRouter);
app.use(ordersRouter);
app.use(paymentsRouter);
app.use(shippingRouter);
 
// ⚠️ TEMPORAL — diagnóstico de conectividad Render → Correo Argentino.
// Borrar esta ruta cuando termine el diagnóstico. No usa credenciales ni body.
app.get("/debug/correo", async (req, res) => {
  const url = "https://api.correoargentino.com.ar/micorreo/v1/token";
  const started = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15000);
  try {
    const r = await fetch(url, { method: "POST", signal: controller.signal });
    // Se espera 401/400 (sin credenciales): lo que importa es que haya respuesta.
    res.json({ ok: true, status: r.status, message: "Hubo respuesta HTTP de Correo Argentino", elapsedMs: Date.now() - started });
  } catch (err) {
    const cause = err.cause ? `${err.cause.code || ""} ${err.cause.message || ""}`.trim() : "";
    res.json({
      ok: false,
      error: err.name === "AbortError" ? "TIMEOUT_15000ms" : (err.cause && err.cause.code) || err.name,
      message: cause || err.message,
      elapsedMs: Date.now() - started,
    });
  } finally {
    clearTimeout(timer);
  }
});
 
// 404
app.use((req, res) => {
  res.status(404).json({ error: "Ruta no encontrada" });
});
 
// manejador de errores genérico (por si algo no capturado llega hasta acá)
app.use((err, req, res, next) => {
  console.error("[unhandled]", err);
  res.status(500).json({ error: "Error interno del servidor" });
});
 
const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log(`GRIP MEDIAS API escuchando en http://localhost:${PORT}`);
});
 
