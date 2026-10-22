const express = require("express");
const { ShippingError, getShippingRates } = require("../correoargentino");

const router = express.Router();

// POST /shipping/rates — cotiza el envío con Correo Argentino para mostrar
// opciones en el checkout. El precio final se vuelve a validar en POST /orders.
router.post("/shipping/rates", async (req, res) => {
  try {
    const { postalCodeDestination, deliveredType } = req.body || {};

    if (deliveredType === "S") {
      // No se inventan sucursales/direcciones: por ahora la cotización a
      // sucursal queda preparada pero no habilitada hasta tener /agencies.
      return res.status(501).json({
        error: "La cotización a sucursal todavía no está disponible. Usá envío a domicilio o retiro por cuenta propia.",
      });
    }

    const rates = await getShippingRates({
      postalCodeDestination,
      deliveredType: deliveredType || "D",
      // dimensions: no se recibe del frontend — se usa la config centralizada provisoria.
    });

    res.json({ rates });
  } catch (err) {
    if (err instanceof ShippingError) {
      return res.status(err.status).json({ error: err.message });
    }
    console.error("[POST /shipping/rates]", err);
    res.status(500).json({ error: "No se pudo cotizar el envío" });
  }
});

module.exports = router;
