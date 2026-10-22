/* =========================================================
   GRIP MEDIAS — configuración centralizada de envío
   =========================================================
   IMPORTANTE: estos valores de peso/dimensiones son PROVISORIOS,
   usados únicamente para cotizar con la API de MiCorreo mientras
   no esté definido el embalaje real de GRIP MEDIAS.

   NO representan el peso/dimensiones real de cada producto: se usa
   un único paquete "promedio" para TODO el pedido, centralizado acá,
   en vez de inventar un valor por producto.

   Cuando GRIP MEDIAS defina su embalaje real, alcanza con editar estos
   números — no hace falta tocar ninguna otra parte del código.
   ========================================================= */

const SHIPPING_ORIGIN = {
  province: "Santa Fe",
  city: "Rosario",
  postalCode: process.env.CORREO_ARGENTINO_ORIGIN_POSTAL_CODE || "2000",
};

// Paquete "promedio" provisorio (ver aclaración arriba). Unidades: gramos y cm.
const DEFAULT_PACKAGE_DIMENSIONS = {
  weight: 500, // gramos
  height: 10, // cm
  width: 20, // cm
  length: 30, // cm
};

module.exports = { SHIPPING_ORIGIN, DEFAULT_PACKAGE_DIMENSIONS };
