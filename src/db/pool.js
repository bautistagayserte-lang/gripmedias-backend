require("dotenv").config();
const { Pool } = require("pg");

if (!process.env.DATABASE_URL) {
  console.error(
    "[db] Falta la variable de entorno DATABASE_URL. Copiá .env.example a .env y completá la conexión a Postgres."
  );
}

const useSSL = String(process.env.PGSSL).toLowerCase() === "true";

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: useSSL ? { rejectUnauthorized: false } : false,
});

pool.on("error", (err) => {
  // Errores en clientes ociosos del pool (no deben tirar abajo el proceso)
  console.error("[db] Error inesperado en el pool de Postgres:", err);
});

module.exports = { pool };
