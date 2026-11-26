#!/usr/bin/env node
/* Respaldo de datos de la tienda en archivos JSON (SOLO LECTURA: únicamente hace SELECT).
   Uso (en tu computadora):   node scripts/backup-db.js
   Requiere un archivo .env local con DATABASE_URL (y PGSSL=true si corresponde).
   Crea la carpeta backups/<fecha-hora>/ con una tabla por archivo.
   ⚠️ Los respaldos incluyen datos personales de compradores: la carpeta backups/
   está en .gitignore y NO debe subirse a GitHub. */
"use strict";

const fs = require("fs");
const path = require("path");
const { pool } = require("../src/db/pool");

const TABLES = ["categories", "products", "variants", "orders", "order_items", "payments"];

(async () => {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const dir = path.join(__dirname, "..", "backups", stamp);
  fs.mkdirSync(dir, { recursive: true });
  let total = 0;
  try {
    for (const t of TABLES) {
      const r = await pool.query(`SELECT * FROM ${t} ORDER BY 1`); // nombres fijos de esta lista, sin entrada del usuario
      fs.writeFileSync(path.join(dir, `${t}.json`), JSON.stringify(r.rows, null, 2));
      console.log(`  ${t.padEnd(12)} ${String(r.rows.length).padStart(5)} filas`);
      total += r.rows.length;
    }
    console.log(`\nRespaldo guardado en: ${dir}  (${total} filas en total)`);
    console.log("Guardalo en un lugar seguro y NO lo subas a GitHub.");
  } catch (err) {
    console.error("\nNo se pudo completar el respaldo:", err.message);
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
})();
