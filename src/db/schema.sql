-- =========================================================
-- GRIP MEDIAS — esquema de base de datos (PostgreSQL)
-- Fuente de verdad de catálogo, variantes, stock y pedidos.
-- =========================================================

CREATE TABLE IF NOT EXISTS categories (
  id          SERIAL PRIMARY KEY,
  name        TEXT UNIQUE NOT NULL,
  sort_order  INTEGER NOT NULL DEFAULT 0
);

-- Un producto = una publicación/tarjeta de la tienda.
-- "mode" le dice al frontend qué tipo de selector mostrar; el backend
-- no necesita interpretarlo para el control de stock.
CREATE TABLE IF NOT EXISTS products (
  id                  TEXT PRIMARY KEY,          -- slug estable, ej: 'remera-termica-calcio'
  category_id         INTEGER NOT NULL REFERENCES categories(id),
  brand               TEXT,
  name                TEXT NOT NULL,
  description         TEXT,
  mode                TEXT NOT NULL CHECK (mode IN (
                          'color-size-pending', 'color-only', 'color-qty',
                          'simple-qty', 'simple-status'
                        )),
  price               NUMERIC(12,2) NOT NULL CHECK (price >= 0),
  compare_price       NUMERIC(12,2),
  talle_unico         TEXT,                      -- ej: 'Adulto' (pantorrilleras)
  sizes               TEXT[],                     -- lista informativa de talles ofrecidos (S,M,L,XL)
  size_stock_pending  BOOLEAN NOT NULL DEFAULT false, -- true = el stock exacto por talle todavía no fue informado
  active              BOOLEAN NOT NULL DEFAULT true,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Una variante = la unidad real de stock que conocemos.
-- Para productos "color-size-pending": la variante es por COLOR (no por talle,
-- porque la distribución por talle todavía no fue informada — no se inventa).
-- Para "simple-qty"/"simple-status": una única variante con color = NULL.
CREATE TABLE IF NOT EXISTS variants (
  id          SERIAL PRIMARY KEY,
  product_id  TEXT NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  color       TEXT,               -- NULL cuando el producto no tiene dimensión de color
  color_hex   TEXT,
  stock       INTEGER NOT NULL DEFAULT 0 CHECK (stock >= 0)
);
-- Postgres no aplica UNIQUE entre múltiples filas con color IS NULL, así que
-- se usan dos índices únicos parciales: uno para variantes con color y otro
-- para el caso de "una sola variante implícita" (color NULL) por producto.
CREATE UNIQUE INDEX IF NOT EXISTS uq_variants_product_color
  ON variants (product_id, color) WHERE color IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uq_variants_product_nullcolor
  ON variants (product_id) WHERE color IS NULL;

CREATE TABLE IF NOT EXISTS orders (
  id                SERIAL PRIMARY KEY,
  order_code        TEXT UNIQUE NOT NULL,   -- código humano, ej: GM-00000001
  status            TEXT NOT NULL DEFAULT 'pending' CHECK (status IN (
                        'pending', 'payment_pending', 'paid', 'rejected',
                        'cancelled', 'preparing', 'shipped', 'completed'
                      )),
  buyer_name        TEXT NOT NULL,
  buyer_lastname    TEXT NOT NULL,
  buyer_email       TEXT,
  buyer_phone       TEXT NOT NULL,
  shipping_method   TEXT CHECK (shipping_method IN ('domicilio', 'sucursal', 'retiro')),
  shipping_cp       TEXT,
  shipping_province TEXT,
  shipping_locality TEXT,
  shipping_address  TEXT,
  shipping_cost     NUMERIC(12,2),          -- NULL = todavía a confirmar (según CP)
  shipping_notes    TEXT,
  payment_method    TEXT CHECK (payment_method IN ('mercadopago', 'transferencia')),
  subtotal          NUMERIC(12,2) NOT NULL,
  total             NUMERIC(12,2),          -- NULL mientras el envío esté "a confirmar"
  mp_preference_id  TEXT,                   -- id de la Preference de Mercado Pago generada para este pedido
  mp_payment_id     TEXT,                   -- id del pago de Mercado Pago que terminó definiendo el estado
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------
-- Columnas agregadas para la integración de Correo Argentino (MiCorreo).
-- Se agregan con ALTER TABLE ... ADD COLUMN IF NOT EXISTS para no romper
-- ni recrear la tabla "orders" si ya existe con datos reales cargados.
-- shipping_method / shipping_cp / shipping_cost / total ya existían y se
-- siguen usando tal cual (no se duplican).
-- ---------------------------------------------------------------
ALTER TABLE orders ADD COLUMN IF NOT EXISTS discount NUMERIC(12,2) NOT NULL DEFAULT 0;
-- 'D' = domicilio, 'S' = sucursal. NULL cuando shipping_method = 'retiro'.
ALTER TABLE orders ADD COLUMN IF NOT EXISTS shipping_delivered_type TEXT CHECK (shipping_delivered_type IN ('D', 'S'));
-- Tipo de producto de Correo Argentino cotizado/usado (ej: 'CP' Clásico, 'EP' Expreso).
ALTER TABLE orders ADD COLUMN IF NOT EXISTS shipping_product_type TEXT;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS shipping_product_name TEXT;

CREATE TABLE IF NOT EXISTS order_items (
  id            SERIAL PRIMARY KEY,
  order_id      INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  product_id    TEXT NOT NULL REFERENCES products(id),
  variant_id    INTEGER REFERENCES variants(id),
  product_name  TEXT NOT NULL,     -- snapshot: nombre al momento de la compra
  color         TEXT,
  size          TEXT,              -- informativo (el talle exacto no se controla como stock todavía)
  unit_price    NUMERIC(12,2) NOT NULL,  -- snapshot: precio real usado, siempre desde la DB
  quantity      INTEGER NOT NULL CHECK (quantity > 0),
  line_total    NUMERIC(12,2) NOT NULL
);

-- Auditoría de cada notificación de pago que llega desde Mercado Pago.
-- Permite procesar el webhook de forma idempotente (si MP reintenta la
-- misma notificación, no se duplica ni se reprocesa de más).
CREATE TABLE IF NOT EXISTS payments (
  id             SERIAL PRIMARY KEY,
  order_id       INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  mp_payment_id  TEXT,
  status         TEXT,             -- estado que informó Mercado Pago (approved, rejected, pending, etc.)
  status_detail  TEXT,
  raw_payload    JSONB,            -- respuesta completa de la API de pagos, por si hace falta auditar
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_payments_order ON payments(order_id);
CREATE UNIQUE INDEX IF NOT EXISTS uq_payments_mp_payment_id
  ON payments (mp_payment_id) WHERE mp_payment_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_products_category ON products(category_id);
CREATE INDEX IF NOT EXISTS idx_variants_product ON variants(product_id);
CREATE INDEX IF NOT EXISTS idx_order_items_order ON order_items(order_id);
CREATE INDEX IF NOT EXISTS idx_orders_status ON orders(status);

-- Mantiene updated_at al día en cada UPDATE de orders.
CREATE OR REPLACE FUNCTION set_updated_at() RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_orders_updated_at ON orders;
CREATE TRIGGER trg_orders_updated_at
  BEFORE UPDATE ON orders
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
