/* =========================================================
   GRIP MEDIAS — cliente de la API de MiCorreo (Correo Argentino)
   =========================================================
   - Obtiene y reutiliza un JWT en memoria del backend (nunca en Postgres).
   - Expone getShippingRates(...) para cotizar envíos.
   - Las credenciales SOLO salen de variables de entorno. Nunca se
     hardcodean, nunca se loguean completas, nunca se exponen al frontend.
   ========================================================= */

const { SHIPPING_ORIGIN, DEFAULT_PACKAGE_DIMENSIONS } = require("./config/shipping");

/* Error "de dominio" para que las rutas puedan devolver al frontend un
   mensaje claro sin filtrar detalles internos (credenciales, stack, etc.) */
class ShippingError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status; // código HTTP a devolver al frontend
    this.code = code; // código corto para debug/logs
  }
}

// --- Token en memoria del proceso (se pierde al reiniciar, y se vuelve a pedir) ---
let cachedToken = null; // { value, expiresAt(ms epoch) }

function getBaseUrl() {
  const base = process.env.CORREO_ARGENTINO_BASE_URL;
  if (!base) {
    throw new ShippingError(500, "CONFIG_MISSING", "Falta configurar CORREO_ARGENTINO_BASE_URL en el backend");
  }
  return base.replace(/\/+$/, "");
}

function getCredentials() {
  const username = process.env.CORREO_ARGENTINO_USERNAME;
  const password = process.env.CORREO_ARGENTINO_PASSWORD;
  if (!username || !password) {
    throw new ShippingError(
      500,
      "CONFIG_MISSING",
      "Faltan credenciales de Correo Argentino en las variables de entorno del backend"
    );
  }
  return { username, password };
}

async function fetchWithTimeout(url, options, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } catch (err) {
    if (err.name === "AbortError") {
      throw new ShippingError(504, "TIMEOUT", "Correo Argentino no respondió a tiempo");
    }
    throw new ShippingError(502, "NETWORK_ERROR", "No se pudo conectar con Correo Argentino");
  } finally {
    clearTimeout(timer);
  }
}

/* Devuelve un JWT válido, reutilizando el que ya está en memoria si todavía
   no venció. Si no hay token o está por vencer, pide uno nuevo con Basic Auth. */
async function getValidToken() {
  const now = Date.now();
  // Margen de 30s para evitar usar un token que vence justo durante la llamada.
  if (cachedToken && cachedToken.expiresAt - 30_000 > now) {
    return cachedToken.value;
  }

  const { username, password } = getCredentials();
  const basicAuth = Buffer.from(`${username}:${password}`).toString("base64");

  let res;
  try {
    res = await fetchWithTimeout(
      `${getBaseUrl()}/token`,
      {
        method: "POST",
        headers: { Authorization: `Basic ${basicAuth}`, "Content-Type": "application/json" },
      },
      8000
    );
  } catch (err) {
    if (err instanceof ShippingError) throw err;
    throw new ShippingError(502, "NETWORK_ERROR", "No se pudo conectar con Correo Argentino");
  }

  if (res.status === 401 || res.status === 403) {
    throw new ShippingError(502, "AUTH_FAILED", "Credenciales de Correo Argentino rechazadas");
  }
  if (!res.ok) {
    throw new ShippingError(502, "AUTH_ERROR", "Error autenticando contra Correo Argentino");
  }

  let data;
  try {
    data = await res.json();
  } catch {
    throw new ShippingError(502, "AUTH_ERROR", "Respuesta de autenticación inválida de Correo Argentino");
  }

  // La API puede devolver el token bajo distintas claves según el endpoint;
  // se contemplan las variantes más comunes sin asumir una forma fija.
  const token = data.token || data.access_token || data.accessToken || data.jwt;
  if (!token) {
    throw new ShippingError(502, "AUTH_ERROR", "Correo Argentino no devolvió un token válido");
  }

  // expiresIn en segundos si viene informado; si no, se asume una vigencia
  // conservadora de 10 minutos para forzar renovación periódica igual.
  const expiresInSeconds = Number(data.expiresIn || data.expires_in) || 600;
  cachedToken = { value: token, expiresAt: now + expiresInSeconds * 1000 };

  return token;
}

/* Si el token guardado resulta rechazado por /rates (p.ej. revocado desde el
   panel de Correo Argentino), se descarta y se reintenta una sola vez con
   un token nuevo, en vez de fallar directamente. */
async function withTokenRetry(fn) {
  let token = await getValidToken();
  try {
    return await fn(token);
  } catch (err) {
    if (err instanceof ShippingError && err.code === "AUTH_FAILED") {
      cachedToken = null;
      token = await getValidToken();
      return await fn(token);
    }
    throw err;
  }
}

function validateRatesInput({ postalCodeDestination, deliveredType }) {
  if (!postalCodeDestination || !/^\d{3,5}$/.test(String(postalCodeDestination).trim())) {
    throw new ShippingError(400, "INVALID_POSTAL_CODE", "El código postal de destino no es válido");
  }
  if (!["D", "S"].includes(deliveredType)) {
    throw new ShippingError(400, "INVALID_DELIVERY_TYPE", "La modalidad de entrega debe ser 'D' (domicilio) o 'S' (sucursal)");
  }
}

/* Cotiza el envío contra /rates. `dimensions` es opcional: si no se pasa,
   se usa el paquete provisorio centralizado (ver src/config/shipping.js). */
async function getShippingRates({ postalCodeDestination, deliveredType, dimensions }) {
  validateRatesInput({ postalCodeDestination, deliveredType });

  const dims = dimensions || DEFAULT_PACKAGE_DIMENSIONS;
  if (
    !dims ||
    !(Number(dims.weight) > 0) ||
    !(Number(dims.height) > 0) ||
    !(Number(dims.width) > 0) ||
    !(Number(dims.length) > 0)
  ) {
    throw new ShippingError(500, "INVALID_DIMENSIONS", "La configuración de peso/dimensiones del paquete es inválida");
  }

  const customerId = process.env.CORREO_ARGENTINO_CUSTOMER_ID;
  if (!customerId) {
    throw new ShippingError(500, "CONFIG_MISSING", "Falta configurar CORREO_ARGENTINO_CUSTOMER_ID en el backend");
  }

  const body = {
    customerId,
    postalCodeOrigin: SHIPPING_ORIGIN.postalCode,
    postalCodeDestination: String(postalCodeDestination).trim(),
    deliveredType,
    dimensions: {
      weight: Number(dims.weight),
      height: Number(dims.height),
      width: Number(dims.width),
      length: Number(dims.length),
    },
  };

  const data = await withTokenRetry(async (token) => {
    let res;
    try {
      res = await fetchWithTimeout(
        `${getBaseUrl()}/rates`,
        {
          method: "POST",
          headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
          body: JSON.stringify(body),
        },
        8000
      );
    } catch (err) {
      if (err instanceof ShippingError) throw err;
      throw new ShippingError(502, "NETWORK_ERROR", "No se pudo conectar con Correo Argentino");
    }

    if (res.status === 401 || res.status === 403) {
      throw new ShippingError(401, "AUTH_FAILED", "Token de Correo Argentino rechazado");
    }
    if (res.status === 400) {
      throw new ShippingError(400, "INVALID_REQUEST", "Correo Argentino rechazó los datos de la cotización (CP/dimensiones)");
    }
    if (res.status >= 500) {
      throw new ShippingError(502, "PROVIDER_DOWN", "El servicio de Correo Argentino no está disponible en este momento");
    }
    if (!res.ok) {
      throw new ShippingError(502, "PROVIDER_ERROR", "Correo Argentino devolvió un error inesperado");
    }

    try {
      return await res.json();
    } catch {
      throw new ShippingError(502, "PROVIDER_ERROR", "Respuesta inválida de Correo Argentino");
    }
  });

  const rates = Array.isArray(data.rates) ? data.rates : [];
  if (rates.length === 0) {
    throw new ShippingError(409, "NO_RATES", "Correo Argentino no devolvió tarifas disponibles para ese destino");
  }

  return rates.map((r) => ({
    deliveredType: r.deliveredType,
    productType: r.productType,
    productName: r.productName,
    price: Number(r.price),
    deliveryTimeMin: r.deliveryTimeMin,
    deliveryTimeMax: r.deliveryTimeMax,
  }));
}

module.exports = { ShippingError, getShippingRates };
