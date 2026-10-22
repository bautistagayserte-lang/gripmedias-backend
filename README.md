# GRIP MEDIAS — Backend (Etapa 1)

API en Node.js + Express, con PostgreSQL como fuente de verdad del catálogo,
las variantes, el stock y los pedidos. Todavía NO incluye Mercado Pago ni
Correo Argentino (etapa 2).

## Estructura

```
backend/
├── package.json
├── .env.example
├── src/
│   ├── server.js            → arma la app Express y levanta el servidor
│   ├── mercadopago.js        → cliente SDK de Mercado Pago (lazy init)
│   ├── correoargentino.js    → cliente de MiCorreo (token en memoria + cotización)
│   ├── config/
│   │   └── shipping.js       → origen y paquete provisorio (peso/dimensiones) centralizados
│   ├── db/
│   │   ├── pool.js           → conexión a Postgres (pg.Pool)
│   │   ├── schema.sql        → CREATE TABLE / ALTER TABLE de todo el esquema (no destructivo)
│   │   ├── migrate.js        → corre schema.sql contra la DB
│   │   └── seed.js           → carga el catálogo real (NO ejecutar: ver aviso abajo)
│   └── routes/
│       ├── products.js       → GET /products, GET /products/:id, GET /categories
│       ├── orders.js         → POST /orders, GET /orders/:id
│       ├── payments.js       → POST /orders/:id/preference, webhook de Mercado Pago
│       └── shipping.js       → POST /shipping/rates (cotización con Correo Argentino)
```

> **⚠️ No ejecutes `npm run db:seed` sobre tu base real.** Ya tenés stock
> real cargado en Postgres/Neon; `seed.js` hace upsert del catálogo de
> fábrica y lo pisaría. Quedó en el proyecto solo como referencia de cómo se
> cargó originalmente el catálogo.

## 1) Requisitos

- Node.js 18 o superior.
- Una base de datos PostgreSQL (14+) accesible por conexión string.

## 2) Instalar dependencias

```bash
cd backend
npm install
```

## 3) Configurar variables de entorno

```bash
cp .env.example .env
```

Editá `.env` y completá `DATABASE_URL` con los datos reales de tu Postgres.

## 4) Levantar PostgreSQL

Tenés dos caminos:

**A) Un hosting de Postgres en la nube (recomendado para no instalar nada localmente).**
Opciones con capa gratuita/económica: Railway, Render, Supabase o Neon. En
cualquiera de ellas creás una base nueva y te dan una cadena de conexión
(`postgres://usuario:password@host:puerto/basededatos`) — esa es la que va en
`DATABASE_URL`. Si el proveedor exige SSL, dejá `PGSSL=true` en `.env`.

**B) PostgreSQL local (para desarrollo en tu máquina).**
```bash
# Opción con Docker (la más simple si ya tenés Docker):
docker run --name gripmedias-db -e POSTGRES_PASSWORD=gripmedias \
  -e POSTGRES_DB=gripmedias -p 5432:5432 -d postgres:16

# DATABASE_URL quedaría:
# postgres://postgres:gripmedias@localhost:5432/gripmedias
# y PGSSL=false
```

## 5) Ejecutar las migraciones (crear las tablas)

```bash
npm run db:migrate
```

Esto corre `src/db/schema.sql` contra la base indicada en `DATABASE_URL`
(crea `categories`, `products`, `variants`, `orders`, `order_items`).

## 6) Cargar el catálogo inicial

```bash
npm run db:seed
```

Carga las 8 categorías y los 22 productos/modelos actuales, con sus precios y
stock reales (podés correrlo de nuevo sin miedo: hace upsert, no duplica).

## 7) Levantar el backend

```bash
npm start
```

Por defecto queda escuchando en `http://localhost:3001` (configurable con
`PORT` en `.env`).

## 8) Probar que la API funciona

```bash
# chequeo de salud (verifica conexión a la DB)
curl http://localhost:3001/health

# catálogo completo
curl http://localhost:3001/products

# un producto puntual
curl http://localhost:3001/products/medias-pro

# categorías
curl http://localhost:3001/categories

# crear un pedido de prueba
curl -X POST http://localhost:3001/orders \
  -H "Content-Type: application/json" \
  -d '{
    "items": [{ "productId": "remera-termica-calcio", "color": "Negro", "qty": 1 }],
    "buyer": { "nombre": "Juana", "apellido": "Pérez", "telefono": "3411234567", "email": "juana@test.com" },
    "shipping": { "method": "retiro" },
    "payment": { "method": "transferencia" }
  }'

# consultar el pedido creado (con el orderCode que devolvió el POST anterior)
curl http://localhost:3001/orders/GM-XXXXXXXX
```

## 9) Conectar el frontend

En el archivo `index.html` de la tienda, cerca del principio del script
principal, hay una constante:

```js
const API_BASE_URL = "";
```

Mientras esté vacía, la tienda sigue funcionando exactamente igual que ahora
(catálogo local, pedidos guardados solo en el navegador). Cuando el backend
esté desplegado en una URL pública, poné esa URL ahí, por ejemplo:

```js
const API_BASE_URL = "https://api.gripmedias.com.ar";
```

**Importante sobre CORS:** en `.env` del backend, `CORS_ORIGINS` tiene que
incluir el dominio exacto donde esté publicado el `index.html` (por ejemplo
`https://gripmedias.com.ar`), separado por comas si hay más de uno.

**Importante sobre el entorno de vista previa de Claude (Artifacts):** una
página publicada como Artifact de claude.ai no puede hacer `fetch` a ningún
dominio externo por política de seguridad del entorno. Es decir: esta
conexión real frontend↔backend solo va a funcionar cuando el `index.html` se
aloje afuera de claude.ai (su hosting propio, Vercel, Netlify, GitHub Pages,
etc.), apuntando al backend. Adentro de la vista previa de Claude, la tienda
sigue mostrando el catálogo local como demo — no está roto, es una limitación
del entorno de prueba.

## Endpoints implementados

| Método | Ruta             | Descripción                                             |
|--------|------------------|----------------------------------------------------------|
| GET    | /health          | Chequeo de salud del servidor y la conexión a la DB       |
| GET    | /products        | Catálogo completo (productos + variantes + stock)         |
| GET    | /products/:id    | Un producto puntual                                        |
| GET    | /categories      | Categorías con cantidad de productos activos               |
| POST   | /orders          | Crea un pedido (valida stock, precio y envío contra la DB/Correo Argentino) |
| GET    | /orders/:id      | Consulta un pedido por id numérico o por order_code         |
| POST   | /orders/:id/preference | Genera la Preference de Mercado Pago para un pedido ya creado |
| POST/GET | /webhooks/mercadopago | Notificaciones de Mercado Pago (actualiza el estado del pedido) |
| POST   | /shipping/rates  | Cotiza el envío con Correo Argentino (domicilio) para mostrarlo en el checkout |

## Cómo funciona el control de stock (lo más importante de esta etapa)

`POST /orders` abre una transacción de Postgres y, para cada ítem del
pedido, hace `SELECT ... FOR UPDATE` sobre la fila de `variants`
correspondiente. Eso bloquea esa fila hasta que la transacción termina
(`COMMIT` o `ROLLBACK`): si dos personas intentan comprar la última unidad al
mismo tiempo, la segunda transacción queda esperando a que termine la
primera, y cuando le toca el turno ve el stock ya actualizado — si ya no
alcanza, se cancela con un error 409 y **no se descuenta nada**. El precio
que se usa para calcular el total siempre se lee de `products.price` en ese
mismo momento; el precio que mande el frontend (si mandara alguno) se
ignora por completo.

## Próxima etapa (todavía no implementada)

- Panel de administración para editar catálogo/pedidos sin tocar código.
- Cotización a sucursal (`deliveredType: "S"`): la cotización a domicilio ya
  funciona con la API real; sucursal queda preparada en el código pero
  deshabilitada (responde 501) hasta tener `/agencies` u otra forma de
  obtener sucursales reales — no se inventaron sucursales ni direcciones.

---

## Mercado Pago (Checkout Pro) — cómo probarlo

### 1) Instalar la dependencia nueva

```bash
cd backend
npm install
```

(Esto instala el paquete `mercadopago` que se agregó a `package.json`; no hace falta ningún otro comando.)

### 2) Completar variables de entorno

En tu `backend/.env` (no en `.env.example`) agregá, además de lo que ya tenías:

```
MERCADOPAGO_ACCESS_TOKEN=TEST-xxxxxxxx...   # ya lo tenés cargado
MERCADOPAGO_WEBHOOK_SECRET=                  # opcional, ver más abajo
BACKEND_PUBLIC_URL=                          # ver "túnel HTTPS" más abajo
FRONTEND_PUBLIC_URL=http://127.0.0.1:8081    # la URL donde corre tu http-server
```

### 3) Reiniciar el backend

```bash
npm start
```

### 4) Probar el flujo completo por API (sin todavía tocar el frontend)

**a) Crear un pedido con Mercado Pago como medio de pago:**
```bash
curl -X POST http://localhost:3001/orders \
  -H "Content-Type: application/json" \
  -d '{
    "items": [{ "productId": "medias-classic", "color": "Negro", "qty": 1 }],
    "buyer": { "nombre": "Juana", "apellido": "Pérez", "telefono": "3411234567", "email": "juana@test.com" },
    "shipping": { "method": "retiro" },
    "payment": { "method": "mercadopago" }
  }'
```
Anotá el `orderCode` que devuelve (ej: `GM-12345678`). El pedido queda con `status: "pending"` y el stock ya se descontó (igual que antes).

**b) Generar la Preference para ese pedido:**
```bash
curl -X POST http://localhost:3001/orders/GM-12345678/preference
```
Devuelve `preferenceId`, `initPoint` y `sandboxInitPoint`.

**c) Abrir el checkout de Mercado Pago:**
Copiá el valor de `sandboxInitPoint` (o `initPoint`, con credenciales TEST ambos llevan a un checkout de prueba) y abrilo en el navegador. Vas a ver el Checkout Pro real de Mercado Pago, en modo sandbox.

**d) Pagar con una tarjeta de prueba:**
Mercado Pago Argentina publica tarjetas de prueba en su documentación (Developers → Tus integraciones → tu app → Cuentas de prueba / Tarjetas de prueba). Vas a necesitar además un **usuario comprador de prueba** (se crea desde el mismo panel, "Cuentas de prueba"): iniciá sesión con ese usuario de prueba en el checkout (o pagá como invitado con la tarjeta de prueba, según cómo lo tengas configurado) para que el pago se procese en sandbox y no te pida datos reales.

**e) Verificar el resultado:**
```bash
curl http://localhost:3001/orders/GM-12345678
```
Si configuraste el webhook (paso 5) vas a ver `"status": "paid"` automáticamente. Si no, el estado va a seguir en `"pending"` hasta que el webhook llegue (ver abajo por qué en localhost no llega solo).

### 5) Webhook en desarrollo local: necesitás un túnel HTTPS

`http://localhost:3001` no es alcanzable desde los servidores de Mercado Pago, así que mientras `BACKEND_PUBLIC_URL` esté vacío, **no se manda `notification_url`** y el webhook simplemente no va a llegar (vas a tener que consultar `GET /orders/:id` para ver si cambió, y en desarrollo puede quedarse en `pending` salvo que uses un túnel).

Para probarlo de punta a punta necesitás **un túnel HTTPS que apunte a tu `localhost:3001`**. La herramienta más usada es **ngrok**:

1. Instalar ngrok (https://ngrok.com/download) y crear una cuenta gratuita.
2. Correr: `ngrok http 3001`
3. Ngrok te da una URL pública tipo `https://algo-random.ngrok-free.app`.
4. Poner esa URL en `backend/.env`:
   ```
   BACKEND_PUBLIC_URL=https://algo-random.ngrok-free.app
   ```
5. Reiniciar el backend (`npm start`) y volver a generar la Preference (paso 4b) — ahora sí va a incluir `notification_url` apuntando a ngrok.
6. En el panel de Mercado Pago Developers de tu aplicación, en "Webhooks", podés (opcional pero recomendado) configurar esa misma URL + evento "Pagos" y copiar la "clave secreta" que te genera, para completar `MERCADOPAGO_WEBHOOK_SECRET` y que el backend valide que la notificación es realmente de Mercado Pago.
7. Repetí el pago de prueba (paso 4c/4d). Esta vez Mercado Pago sí va a poder llamar a `POST https://algo-random.ngrok-free.app/webhooks/mercadopago`, vas a ver el log `[webhook] Pedido GM-... → "approved" → orden queda en "paid"` en la consola del backend, y `GET /orders/GM-12345678` va a mostrar `"status": "paid"`.

No inventé ninguna URL: hasta que no corras ngrok (o despliegues el backend con una URL pública real), esa variable queda vacía a propósito.

### Sobre `back_urls` y `auto_return`

Con `FRONTEND_PUBLIC_URL=http://127.0.0.1:8081` (http, no https), los `back_urls` se arman igual (para que el checkout tenga a dónde volver), pero **`auto_return` queda deshabilitado** porque Mercado Pago exige HTTPS para usarlo — vas a tener que cerrar el checkout manualmente o volver a la tienda vos mismo en la prueba local. Cuando publiques el frontend con HTTPS real, `auto_return` se activa solo (no hace falta tocar código, es automático según el prefijo de la URL).

### Qué falta para pasar a producción (sin rehacer nada)

Cuando llegue el momento: cambiar `MERCADOPAGO_ACCESS_TOKEN` por el de producción, poner `BACKEND_PUBLIC_URL` y `FRONTEND_PUBLIC_URL` con los dominios reales (HTTPS), y configurar el webhook con esa URL real en el panel de Mercado Pago. Ningún archivo de código necesita cambiar.

---

## Correo Argentino (MiCorreo) — cálculo real de envíos

### 1) Variables de entorno

En tu `backend/.env` agregá (los nombres ya están en `.env.example`, sin valores):

```
CORREO_ARGENTINO_BASE_URL=https://api.correoargentino.com.ar/micorreo/v1
CORREO_ARGENTINO_USERNAME=              # tu usuario de MiCorreo
CORREO_ARGENTINO_PASSWORD=              # tu contraseña de MiCorreo
CORREO_ARGENTINO_CUSTOMER_ID=0001543748
CORREO_ARGENTINO_ORIGIN_POSTAL_CODE=2000
```

No hace falta que me pases usuario/contraseña: los cargás directamente en tu `.env`, que nunca sale de tu máquina/servidor (está en `.gitignore`).

### 2) Cómo funciona (de punta a punta)

```
cliente elige "domicilio" + CP
        ↓
frontend → POST /shipping/rates { postalCodeDestination, deliveredType: "D" }
        ↓
backend: reutiliza el JWT en memoria si sigue vigente, si no pide uno nuevo con POST /token (Basic Auth)
        ↓
backend → POST /rates a Correo Argentino (con el paquete provisorio centralizado en src/config/shipping.js)
        ↓
backend devuelve al frontend solo { productType, productName, price, deliveryTimeMin, deliveryTimeMax } — nunca credenciales ni el JWT
        ↓
cliente elige una opción (ej: "CP" Clásico) → el checkout guarda productType elegido
        ↓
al confirmar el pedido, el frontend manda shipping: { method:"domicilio", cp, productType }
        ↓
POST /orders VUELVE A cotizar con Correo Argentino y usa ESE precio (nunca un shipping_cost que mande el navegador)
        ↓
si pagás con Mercado Pago: la Preference incluye productos + envío como ítems separados
si pagás por transferencia: el 10% de descuento se calcula sobre (productos + envío)
```

"Retiro por cuenta propia" nunca llama a Correo Argentino: cuesta $0 siempre. "Sucursal" todavía no está habilitado (ver más abajo).

### 3) Probarlo por API

**a) Cotizar un envío a domicilio:**
```bash
curl -X POST http://localhost:3001/shipping/rates \
  -H "Content-Type: application/json" \
  -d '{ "postalCodeDestination": "1000", "deliveredType": "D" }'
```
Debería devolver algo como:
```json
{ "rates": [
  { "deliveredType": "D", "productType": "CP", "productName": "Correo Argentino Clasico", "price": 10227, "deliveryTimeMin": "2", "deliveryTimeMax": "5" },
  { "deliveredType": "D", "productType": "EP", "productName": "Correo Argentino Expreso", "price": 14059, "deliveryTimeMin": "1", "deliveryTimeMax": "3" }
] }
```

**b) Crear un pedido con envío a domicilio (el backend vuelve a cotizar y guarda el costo real):**
```bash
curl -X POST http://localhost:3001/orders \
  -H "Content-Type: application/json" \
  -d '{
    "items": [{ "productId": "medias-classic", "color": "Negro", "qty": 1 }],
    "buyer": { "nombre": "Juana", "apellido": "Pérez", "telefono": "3411234567", "email": "juana@test.com" },
    "shipping": { "method": "domicilio", "cp": "1000", "productType": "CP" },
    "payment": { "method": "transferencia" }
  }'
```
La respuesta trae `shipping.cost`, `discount` (10% sobre productos+envío) y `total` ya calculados y guardados en la base.

**c) Pedido con retiro (sin Correo Argentino, costo $0):**
```bash
curl -X POST http://localhost:3001/orders \
  -H "Content-Type: application/json" \
  -d '{
    "items": [{ "productId": "medias-classic", "color": "Negro", "qty": 1 }],
    "buyer": { "nombre": "Juana", "apellido": "Pérez", "telefono": "3411234567" },
    "shipping": { "method": "retiro" },
    "payment": { "method": "mercadopago" }
  }'
```

**d) Verificar que quedó todo guardado:**
```bash
curl http://localhost:3001/orders/GM-XXXXXXXX
```
Vas a ver `shipping.cost`, `shipping.productType`, `discount` y `total` en la respuesta.

### 4) Peso y dimensiones — importante

`src/config/shipping.js` tiene un paquete **provisorio** (500 g, 10×20×30 cm) usado para TODO pedido, bien marcado en el código como provisional. No representa el embalaje real de GRIP MEDIAS. Cuando definan el embalaje real, alcanza con editar esos 4 números ahí — no hay que tocar ningún otro archivo.

### 5) Qué NO está implementado todavía (a propósito)

- **Sucursal (`S`)**: `POST /shipping/rates` con `deliveredType: "S"` responde `501` explicando que todavía no está disponible. No se inventaron sucursales, direcciones ni códigos — falta integrar `/agencies` (u otro mecanismo real) antes de habilitarlo.
- Nada de esto cambió el catálogo, el stock, las imágenes ni el diseño del frontend.

### 6) Base de datos — qué se agregó (no destructivo)

`schema.sql` ahora incluye, además de lo que ya existía, estas líneas con `ALTER TABLE ... ADD COLUMN IF NOT EXISTS` (no borran ni recrean nada):

```sql
discount                 NUMERIC(12,2) DEFAULT 0
shipping_delivered_type  TEXT  -- 'D' o 'S'
shipping_product_type    TEXT  -- 'CP', 'EP', etc.
shipping_product_name    TEXT
```

Las columnas que ya existían (`shipping_method`, `shipping_cp`, `shipping_cost`, `total`, etc.) se siguen usando tal cual, sin duplicarlas. Corré `npm run db:migrate` de nuevo para aplicar estas columnas nuevas — es seguro, no toca filas existentes.

### 7) Seguridad — qué se garantiza

- El usuario/contraseña de MiCorreo y el JWT obtenido viven únicamente en variables de entorno y en memoria del proceso del backend — nunca se guardan en Postgres ni se mandan al frontend.
- El JWT se reutiliza mientras no venza (no se pide uno nuevo en cada cotización); si el servidor se reinicia, se vuelve a autenticar solo.
- El costo de envío que paga el cliente **siempre** se recalcula en el backend al crear el pedido: un valor manipulado desde el navegador se ignora.

### 8) Qué validé en este entorno (sin acceso a Postgres real ni a la red)

No tengo acceso a tu Postgres/Neon real ni a internet desde este entorno, así que no pude correr esto contra la API real de Correo Argentino ni contra tu base. Lo que sí hice: construí una base en memoria y un `fetch` simulado que devuelven exactamente las respuestas que vos ya comprobaste manualmente (incluida la respuesta real de `/rates` que me pasaste), y corrí el código REAL de `src/routes/*.js` y `src/correoargentino.js` contra eso. Se verificaron 21 casos, entre ellos:

- cotización exitosa con las dos tarifas reales (Clásico/Expreso),
- reutilización del JWT entre cotizaciones (no pide uno nuevo de más),
- renovación automática si el token es rechazado a mitad de camino,
- CP sin tarifas disponibles, CP rechazado por la API, formato de CP inválido,
- sucursal rechazada sin inventar datos,
- un `shipping_cost` manipulado desde el frontend es ignorado y se recalcula,
- Mercado Pago cobra productos + envío (ítems separados),
- transferencia descuenta 10% sobre productos + envío, con el ejemplo exacto que diste ($50.000 + $10.000 → descuento $6.000 → total $54.000),
- retiro cuesta $0 y no llama a Correo Argentino,
- **concurrencia real**: dos pedidos simultáneos por la última unidad de stock → uno se confirma, el otro recibe 409, el stock final nunca queda negativo.

Lo que no pude verificar acá (y vale la pena que confirmes vos): la forma exacta de la respuesta de `/token` de tu cuenta real (el código contempla `token`/`access_token`/`accessToken`/`jwt` como nombres posibles de campo — si tu cuenta devuelve algo distinto, avisame) y el comportamiento real de Postgres con las columnas nuevas (la migración es no-destructiva, pero correla vos en tu base cuando quieras).

### Arreglo adicional que encontré de paso

Al armar las pruebas con pedidos simultáneos detecté que `orderCode` se generaba como `"GM-" + Date.now().toString().slice(-8)`, que puede repetirse si dos pedidos se crean en el mismo milisegundo (con tráfico real es poco probable, pero `order_code` es `UNIQUE` en la base, así que una colisión real haría fallar ese pedido con un 500 innecesario). Lo cambié a un código con parte de tiempo + parte aleatoria, y agregué un reintento automático ante colisión (`src/routes/orders.js`). No afecta el formato visible (`GM-XXXXXXXXX`) ni nada del frontend.

