#!/usr/bin/env node
/* Genera el valor de ADMIN_PASSWORD_HASH para el panel de administración.
   Uso (en tu computadora, NO en Render):   node scripts/hash-password.js
   - Pide la contraseña dos veces SIN mostrarla en pantalla.
   - Exige un mínimo de 12 caracteres.
   - No guarda ni envía la contraseña a ningún lado: solo imprime el hash.
   El hash es seguro de pegar en Render (no sirve para entrar, solo para verificar). */
"use strict";

const crypto = require("crypto");

const ITERATIONS = 600_000;
const MIN_LENGTH = 12;

let pending = ""; // texto ya recibido y todavía no consumido (modo no interactivo)

function readHidden(prompt) {
  return new Promise((resolve) => {
    const stdin = process.stdin;
    process.stdout.write(prompt);
    if (!stdin.isTTY) {
      // Modo no interactivo (pruebas / entrada redirigida): lee una línea por pregunta.
      const takeLine = () => {
        const i = pending.indexOf("\n");
        if (i === -1) return false;
        const line = pending.slice(0, i).replace(/\r$/, "");
        pending = pending.slice(i + 1);
        stdin.removeListener("data", onData);
        stdin.removeListener("end", onEnd);
        resolve(line);
        return true;
      };
      const onData = (chunk) => { pending += chunk; takeLine(); };
      const onEnd = () => { pending += "\n"; takeLine(); };
      stdin.setEncoding("utf8");
      if (takeLine()) return;
      stdin.on("data", onData);
      stdin.on("end", onEnd);
      stdin.resume();
      return;
    }
    let value = "";
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding("utf8");
    const onKey = (ch) => {
      for (const c of ch) {
        if (c === "\r" || c === "\n") {
          stdin.setRawMode(false);
          stdin.pause();
          stdin.removeListener("data", onKey);
          process.stdout.write("\n");
          return resolve(value);
        }
        if (c === "\u0003") { // Ctrl+C
          stdin.setRawMode(false);
          process.stdout.write("\nCancelado.\n");
          process.exit(1);
        }
        if (c === "\u007f" || c === "\b") value = value.slice(0, -1);
        else if (c >= " ") value += c;
      }
    };
    stdin.on("data", onKey);
  });
}

(async () => {
  const p1 = await readHidden("Elegí la contraseña del administrador (no se muestra): ");
  if (p1.length < MIN_LENGTH) {
    console.error(`\nLa contraseña debe tener al menos ${MIN_LENGTH} caracteres. No se generó nada.`);
    process.exit(1);
  }
  if (p1.length > 200) {
    console.error("\nLa contraseña no puede superar los 200 caracteres.");
    process.exit(1);
  }
  const p2 = await readHidden("Repetila: ");
  if (p1 !== p2) {
    console.error("\nLas contraseñas no coinciden. No se generó nada.");
    process.exit(1);
  }
  const salt = crypto.randomBytes(16);
  const key = crypto.pbkdf2Sync(p1, salt, ITERATIONS, 32, "sha256");
  const line = `pbkdf2-sha256:${ITERATIONS}:${salt.toString("base64url")}:${key.toString("base64url")}`;
  console.log("\nListo. Copiá esta línea y pegala como variable de entorno en Render (nombre: ADMIN_PASSWORD_HASH):\n");
  console.log(line);
  console.log("\nTambién creá la variable ADMIN_USER con el nombre de usuario que quieras usar.");
  console.log("No compartas ni guardes tu contraseña en archivos.\n");
})();
