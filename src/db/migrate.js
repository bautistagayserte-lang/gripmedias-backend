/* Aplica schema.sql contra la base indicada en DATABASE_URL.
   Uso: npm run db:migrate */
const fs = require("fs");
const path = require("path");
const { pool } = require("./pool");

async function migrate() {
  const schemaPath = path.join(__dirname, "schema.sql");
  const sql = fs.readFileSync(schemaPath, "utf8");
  console.log("[migrate] Aplicando schema.sql...");
  await pool.query(sql);
  console.log("[migrate] Listo. Tablas creadas/actualizadas.");
  await pool.end();
}

migrate().catch((err) => {
  console.error("[migrate] Falló la migración:", err);
  process.exit(1);
});
