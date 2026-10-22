require("dotenv").config();
const { MercadoPagoConfig, Preference, Payment } = require("mercadopago");

let mpClient = null;

/* Se inicializa "lazy" (recién cuando hace falta) para que el servidor
   pueda levantar igual (catálogo, pedidos, health-check) aunque todavía
   no exista MERCADOPAGO_ACCESS_TOKEN configurado. */
function getClient() {
  if (!process.env.MERCADOPAGO_ACCESS_TOKEN) {
    throw new Error(
      "Falta MERCADOPAGO_ACCESS_TOKEN en las variables de entorno. Completalo en backend/.env para poder usar Mercado Pago."
    );
  }
  if (!mpClient) {
    mpClient = new MercadoPagoConfig({
      accessToken: process.env.MERCADOPAGO_ACCESS_TOKEN,
      options: { timeout: 8000 },
    });
  }
  return mpClient;
}

function getPreferenceClient() {
  return new Preference(getClient());
}

function getPaymentClient() {
  return new Payment(getClient());
}

module.exports = { getPreferenceClient, getPaymentClient };
