/* Carga el catálogo real de GRIP MEDIAS (el mismo que ya vive en el
   frontend) dentro de PostgreSQL. Es IDEMPOTENTE: se puede correr de
   nuevo y hace UPSERT en vez de duplicar filas.

   Uso: npm run db:seed
   (requiere haber corrido antes npm run db:migrate) */
const { pool } = require("./pool");

// Mismo tope que usa el frontend para productos "simple-status" (neceseres,
// sobres) donde solo se informó DISPONIBLE / SIN STOCK, sin cantidad exacta.
const SIMPLE_STATUS_MAX_QTY = 5;

const CATEGORIES = [
  "Remeras térmicas",
  "Calzas cortas",
  "Calzas largas",
  "Medias antideslizantes",
  "Pantorrilleras",
  "Mochilas de cuero",
  "Neceseres",
  "Sobres",
];

/* Estructura fiel al PRODUCTS del frontend (src/app.js). Ante cualquier
   cambio de catálogo, este archivo es el que hay que actualizar y volver
   a correr "npm run db:seed". */
const PRODUCTS = [
  {
    id: "remera-termica-calcio",
    category: "Remeras térmicas",
    brand: "Calcio",
    name: "Remera térmica Calcio",
    description: "Remera térmica Calcio, ideal para entrenar en temporada fría. Seleccioná color y talle.",
    mode: "color-size-pending",
    price: 18000,
    comparePrice: 20000,
    sizes: ["S", "M", "L", "XL"],
    sizeStockPending: true,
    colors: [
      { name: "Negro", hex: "#17140F", stock: 3 },
      { name: "Blanco", hex: "#F5F3EC", stock: 4 },
    ],
  },
  {
    id: "calza-corta-calcio",
    category: "Calzas cortas",
    brand: "Calcio",
    name: "Calza corta Calcio",
    description: "Calza corta Calcio, calce cómodo para entrenamiento. Seleccioná color y talle.",
    mode: "color-size-pending",
    price: 20000,
    sizes: ["L", "XL"],
    sizeStockPending: true,
    colors: [
      { name: "Blanco", hex: "#F5F3EC", stock: 2 },
      { name: "Negro", hex: "#17140F", stock: 2 },
    ],
  },
  {
    id: "calza-larga",
    category: "Calzas largas",
    brand: null,
    name: "Calza larga",
    description: "Calza larga, cobertura completa para entrenar todo el año. Seleccioná talle.",
    mode: "color-size-pending",
    price: 22500,
    sizes: ["L", "XL"],
    sizeStockPending: true,
    colors: [{ name: "Negro", hex: "#17140F", stock: 2 }],
  },
  {
    id: "medias-classic",
    category: "Medias antideslizantes",
    brand: "Calcio",
    name: "Calcio Classic",
    description: "Medias antideslizantes Calcio Classic.",
    mode: "color-only",
    price: 6000,
    colors: [
      { name: "Blanco", hex: "#F5F3EC", stock: 11 },
      { name: "Negro", hex: "#17140F", stock: 12 },
    ],
  },
  {
    id: "medias-pro",
    category: "Medias antideslizantes",
    brand: "Calcio",
    name: "Calcio Pro",
    description: "Medias antideslizantes Calcio Pro.",
    mode: "color-only",
    price: 8500,
    colors: [
      { name: "Blanco", hex: "#F5F3EC", stock: 2 },
      { name: "Negro", hex: "#17140F", stock: 13 },
    ],
  },
  {
    id: "medias-elite",
    category: "Medias antideslizantes",
    brand: "Calcio",
    name: "Calcio Elite",
    description: "Medias antideslizantes Calcio Elite.",
    mode: "color-only",
    price: 8500,
    colors: [{ name: "Blanco", hex: "#F5F3EC", stock: 10 }],
  },
  {
    id: "pantorrilleras-calcio",
    category: "Pantorrilleras",
    brand: "Calcio",
    name: "Pantorrilleras Calcio",
    description: "Pantorrilleras Calcio, talle único adulto. Precio por par.",
    mode: "color-qty",
    price: 6500,
    talleUnico: "Adulto",
    colors: [
      { name: "Negro", hex: "#17140F", stock: 4 },
      { name: "Celeste", hex: "#AFC9D9", stock: 2 },
      { name: "Blanco", hex: "#F5F3EC", stock: 3 },
    ],
  },

  // ---- Mochilas de cuero: 5 modelos = 5 productos distintos ----
  { id: "mochila-vutto-calcio", category: "Mochilas de cuero", brand: null, name: "Vutto Calcio", description: "Mochila de cuero GRIP MEDIAS, modelo Vutto Calcio.", mode: "simple-qty", price: 45000, stock: 2 },
  { id: "mochila-urbana-calcio", category: "Mochilas de cuero", brand: null, name: "Urbana Calcio", description: "Mochila de cuero GRIP MEDIAS, modelo Urbana Calcio.", mode: "simple-qty", price: 45000, stock: 2 },
  { id: "mochila-xl", category: "Mochilas de cuero", brand: null, name: "XL", description: "Mochila de cuero GRIP MEDIAS, modelo XL.", mode: "simple-qty", price: 45000, stock: 1 },
  { id: "mochila-line", category: "Mochilas de cuero", brand: null, name: "Line", description: "Mochila de cuero GRIP MEDIAS, modelo Line.", mode: "simple-qty", price: 45000, stock: 2 },
  { id: "mochila-city-total-black", category: "Mochilas de cuero", brand: null, name: "City Total Black", description: "Mochila de cuero GRIP MEDIAS, modelo City Total Black.", mode: "simple-qty", price: 45000, stock: 2 },

  // ---- Neceseres: 5 modelos = 5 productos distintos ----
  { id: "neceser-drigo-vutto", category: "Neceseres", brand: null, name: "Drigo Vutto", description: "Neceser GRIP MEDIAS, modelo Drigo Vutto.", mode: "simple-status", price: 25000, available: true },
  { id: "neceser-bomber-con-gajos", category: "Neceseres", brand: null, name: "Bomber con Gajos", description: "Neceser GRIP MEDIAS, modelo Bomber con Gajos.", mode: "simple-status", price: 25000, available: false },
  { id: "neceser-bomber-borde-blanco", category: "Neceseres", brand: null, name: "Bomber Borde Blanco", description: "Neceser GRIP MEDIAS, modelo Bomber Borde Blanco.", mode: "simple-status", price: 25000, available: false },
  { id: "neceser-jack-city-negro", category: "Neceseres", brand: null, name: "Jack City Negro", description: "Neceser GRIP MEDIAS, modelo Jack City Negro.", mode: "simple-status", price: 25000, available: true },
  { id: "neceser-zr3", category: "Neceseres", brand: null, name: "ZR3", description: "Neceser GRIP MEDIAS, modelo ZR3.", mode: "simple-status", price: 25000, available: false },

  // ---- Sobres: 5 modelos = 5 productos distintos ----
  { id: "sobre-urbano", category: "Sobres", brand: null, name: "Urbano", description: "Sobre GRIP MEDIAS, modelo Urbano.", mode: "simple-status", price: 25000, available: false },
  { id: "sobre-city-blanco", category: "Sobres", brand: null, name: "City Blanco", description: "Sobre GRIP MEDIAS, modelo City Blanco.", mode: "simple-status", price: 25000, available: true },
  { id: "sobre-xl", category: "Sobres", brand: null, name: "XL", description: "Sobre GRIP MEDIAS, modelo XL.", mode: "simple-status", price: 25000, available: false },
  { id: "sobre-calcio", category: "Sobres", brand: null, name: "Calcio", description: "Sobre GRIP MEDIAS, modelo Calcio.", mode: "simple-status", price: 25000, available: true },
  { id: "sobre-camuflado", category: "Sobres", brand: null, name: "Camuflado", description: "Sobre GRIP MEDIAS, modelo Camuflado.", mode: "simple-status", price: 25000, available: true },
];

async function seed() {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    // 1) categorías
    const categoryIds = {};
    for (let i = 0; i < CATEGORIES.length; i++) {
      const name = CATEGORIES[i];
      const res = await client.query(
        `INSERT INTO categories (name, sort_order) VALUES ($1, $2)
         ON CONFLICT (name) DO UPDATE SET sort_order = EXCLUDED.sort_order
         RETURNING id`,
        [name, i]
      );
      categoryIds[name] = res.rows[0].id;
    }

    // 2) productos + variantes
    for (const p of PRODUCTS) {
      await client.query(
        `INSERT INTO products
           (id, category_id, brand, name, description, mode, price, compare_price,
            talle_unico, sizes, size_stock_pending, active)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,true)
         ON CONFLICT (id) DO UPDATE SET
           category_id = EXCLUDED.category_id,
           brand = EXCLUDED.brand,
           name = EXCLUDED.name,
           description = EXCLUDED.description,
           mode = EXCLUDED.mode,
           price = EXCLUDED.price,
           compare_price = EXCLUDED.compare_price,
           talle_unico = EXCLUDED.talle_unico,
           sizes = EXCLUDED.sizes,
           size_stock_pending = EXCLUDED.size_stock_pending`,
        [
          p.id,
          categoryIds[p.category],
          p.brand || null,
          p.name,
          p.description || null,
          p.mode,
          p.price,
          p.comparePrice || null,
          p.talleUnico || null,
          p.sizes || null,
          !!p.sizeStockPending,
        ]
      );

      if (p.colors && p.colors.length) {
        // productos con variantes de color (con o sin talle pendiente)
        for (const c of p.colors) {
          await client.query(
            `INSERT INTO variants (product_id, color, color_hex, stock)
             VALUES ($1,$2,$3,$4)
             ON CONFLICT (product_id, color) WHERE color IS NOT NULL DO UPDATE SET
               color_hex = EXCLUDED.color_hex,
               stock = EXCLUDED.stock`,
            [p.id, c.name, c.hex || null, c.stock]
          );
        }
      } else {
        // producto sin color: una sola variante implícita (color = NULL)
        const stock =
          p.mode === "simple-qty" ? p.stock : p.mode === "simple-status" ? (p.available ? SIMPLE_STATUS_MAX_QTY : 0) : 0;
        await client.query(
          `INSERT INTO variants (product_id, color, color_hex, stock)
           VALUES ($1, NULL, NULL, $2)
           ON CONFLICT (product_id) WHERE color IS NULL DO UPDATE SET stock = EXCLUDED.stock`,
          [p.id, stock]
        );
      }
    }

    await client.query("COMMIT");
    console.log(`[seed] Catálogo cargado: ${CATEGORIES.length} categorías, ${PRODUCTS.length} productos.`);
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

seed()
  .then(() => pool.end())
  .catch((err) => {
    console.error("[seed] Falló la carga del catálogo:", err);
    process.exit(1);
  });
