const express = require("express");
const axios = require("axios");
const cors = require("cors");

const app = express();
app.use(cors());

// 🔐 API KEY desde Render
const API_KEY = process.env.API_KEY;

// 🛫 Aeropuerto
const AIRPORT = "POP";

// 🌐 Ruta base
app.get("/", (req, res) => {
  res.send("🔥 API aeropuerto PRO funcionando");
});

// 🕐 Formato hora RD
function formatHora(fecha) {
  if (!fecha) return "";

  try {
    return new Date(fecha).toLocaleTimeString("es-DO", {
      hour: "2-digit",
      minute: "2-digit",
      hour12: true,
      timeZone: "America/Santo_Domingo"
    });
  } catch {
    return "";
  }
}

// ✈️ Endpoint principal
app.get("/flights", async (req, res) => {
  try {

    const url = `https://aeroapi.flightaware.com/aeroapi/airports/${AIRPORT}/flights`;

    const response = await axios.get(url, {
      headers: { "x-apikey": API_KEY }
    });

    const data = response.data;

    // =========================
    // ✈️ SALIDAS (LO DEJAMOS IGUAL)
    // =========================
    const salidas = (data.departures || []).slice(0, 10).map(f => ({
      vuelo: f.ident || "N/A",
      destino: f.destination?.code || "N/A",

      salida: formatHora(
        f.actual_out || f.estimated_out || f.scheduled_out
      ),

      llegada: "",

      estado: (f.status || "UNKNOWN").replaceAll("_", " ")
    }));

    // =========================
    // 🛬 LLEGADAS (LÓGICA REAL)
    // =========================
    const llegadas = (data.arrivals || []).slice(0, 10).map(f => {

      let hora = "";
      let estado = (f.status || "UNKNOWN").replaceAll("_", " ");

      // ⏳ NO HA SALIDO DEL ORIGEN
      if (!f.actual_out) {
        hora = formatHora(f.scheduled_in);

      // ✈️ EN VUELO
      } else if (f.actual_out && !f.actual_in) {
        hora = formatHora(
          f.estimated_in ?? f.scheduled_in
        );

      // 🛬 YA LLEGÓ
      } else if (f.actual_in) {
        hora = formatHora(f.actual_in);
        estado = "ARRIVED";
      }

      // 🔴 DETECTAR DELAY
      if (
        f.estimated_in &&
        f.scheduled_in &&
        f.estimated_in !== f.scheduled_in
      ) {
        estado = "DELAYED";
      }

      return {
        vuelo: f.ident || "N/A",
        origen: f.origin?.code || "N/A",

        llegada: hora,
        salida: "",

        estado
      };
    });

    res.json({ salidas, llegadas });

  } catch (error) {
    console.log("❌ ERROR:", error.response?.data || error.message);

    res.status(500).json({
      error: "Error obteniendo vuelos",
      detalle: error.response?.data || error.message
    });
  }
});

// 🌐 PUERTO PARA RENDER
const PORT = process.env.PORT || 4000;

app.listen(PORT, () => {
  console.log("🔥 Servidor corriendo en puerto " + PORT);
});