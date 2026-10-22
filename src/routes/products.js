const express = require("express");
const { pool } = require("../db/pool");

const router = express.Router();

/* Arma la forma de "producto" que consume el frontend a partir de las filas
   de products + variants. Se hace acá (no en SQL) para que quede clara la
   transformación y sea fácil de ajustar. */
function shapeProduct(productRow, variantRows) {
  const hasColorDimension = variantRows.some((v) => v.color !== null);

  const base = {
    id: productRow.id,
    category: productRow.category_name,
    brand: productRow.brand,
    name: productRow.name,
    description: productRow.description,
    mode: productRow.mode,
    price: Number(productRow.price),
    comparePrice: productRow.compare_price !== null ? Number(productRow.compare_price) : null,
    active: productRow.active,
  };

  if (productRow.mode === "color-size-pending" || productRow.mode === "color-only" || productRow.mode === "color-qty") {
    base.sizes = productRow.sizes || [];
    base.sizeStockPending = productRow.size_stock_pending;
    base.talle = productRow.talle_unico || undefined;
    base.colors = variantRows
      .filter((v) => v.color !== null)
      .map((v) => ({ name: v.color, hex: v.color_hex, stockTotal: v.stock, variantId: v.id }));
  } else if (productRow.mode === "simple-qty") {
    const v = variantRows.find((r) => r.color === null);
    base.stockTotal = v ? v.stock : 0;
    base.variantId = v ? v.id : null;
  } else if (productRow.mode === "simple-status") {
    const v = variantRows.find((r) => r.color === null);
    base.available = !!v && v.stock > 0;
    base.variantId = v ? v.id : null;
  }

  return base;
}

async function fetchAllProducts() {
  const productsRes = await pool.query(
    `SELECT p.*, c.name AS category_name
     FROM products p
     JOIN categories c ON c.id = p.category_id
     WHERE p.active = true
     ORDER BY c.sort_order, p.name`
  );
  const variantsRes = await pool.query(`SELECT * FROM variants`);
  const variantsByProduct = {};
  for (const v of variantsRes.rows) {
    (variantsByProduct[v.product_id] = variantsByProduct[v.product_id] || []).push(v);
  }
  return productsRes.rows.map((p) => shapeProduct(p, variantsByProduct[p.id] || []));
}

// GET /products
router.get("/products", async (req, res) => {
  try {
    const products = await fetchAllProducts();
    res.json({ products });
  } catch (err) {
    console.error("[GET /products]", err);
    res.status(500).json({ error: "No se pudieron obtener los productos" });
  }
});

// GET /products/:id
router.get("/products/:id", async (req, res) => {
  try {
    const productRes = await pool.query(
      `SELECT p.*, c.name AS category_name
       FROM products p JOIN categories c ON c.id = p.category_id
       WHERE p.id = $1 AND p.active = true`,
      [req.params.id]
    );
    if (productRes.rows.length === 0) {
      return res.status(404).json({ error: "Producto no encontrado" });
    }
    const variantsRes = await pool.query(`SELECT * FROM variants WHERE product_id = $1`, [req.params.id]);
    res.json({ product: shapeProduct(productRes.rows[0], variantsRes.rows) });
  } catch (err) {
    console.error("[GET /products/:id]", err);
    res.status(500).json({ error: "No se pudo obtener el producto" });
  }
});

// GET /categories
router.get("/categories", async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT c.name, COUNT(p.id)::int AS product_count
       FROM categories c
       LEFT JOIN products p ON p.category_id = c.id AND p.active = true
       GROUP BY c.id, c.name, c.sort_order
       ORDER BY c.sort_order`
    );
    res.json({ categories: result.rows.map((r) => ({ name: r.name, productCount: r.product_count })) });
  } catch (err) {
    console.error("[GET /categories]", err);
    res.status(500).json({ error: "No se pudieron obtener las categorías" });
  }
});

module.exports = router;
