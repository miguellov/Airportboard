const express = require("express");
const axios = require("axios");
const cors = require("cors");

const app = express();
app.use(cors());

const API_KEY = "682Ig06UPs4lBuHJVLWrY1EiA9DO90DA";
const AIRPORT = "POP";

app.get("/", (req, res) => {
  res.send("🔥 API ETA PRO funcionando");
});

// 🕐 hora RD
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

app.get("/flights", async (req, res) => {
  try {

    const url = `https://aeroapi.flightaware.com/aeroapi/airports/${AIRPORT}/flights`;

    const response = await axios.get(url, {
      headers: { "x-apikey": API_KEY }
    });

    const data = response.data;

    // ✈️ SALIDAS (push real)
    const salidas = (data.departures || []).slice(0, 10).map(f => ({
      vuelo: f.ident || "N/A",
      destino: f.destination?.code || "N/A",

      salida: formatHora(
        f.actual_out || f.estimated_out || f.scheduled_out
      ),

      llegada: "",

      estado: (f.status || "UNKNOWN").replaceAll("_", " ")
    }));

    // 🛬 LLEGADAS (ETA REAL)
    const llegadas = (data.arrivals || []).slice(0, 10).map(f => {

  let hora = "";
  let estado = (f.status || "UNKNOWN").replaceAll("_", " ");

  // 🧠 LÓGICA REAL DE LLEGADAS
  if(!f.actual_out){
    // ⏳ NO HA SALIDO DEL ORIGEN
    hora = formatHora(f.scheduled_in);

  } else if(f.actual_out && !f.actual_in){
    // ✈️ EN VUELO
    hora = formatHora(
      f.estimated_in ?? f.scheduled_in
    );

  } else if(f.actual_in){
    // 🛬 YA LLEGÓ
    hora = formatHora(f.actual_in);
    estado = "ARRIVED";
  }

  // 🔴 DETECTAR DELAY
  if(
    f.estimated_in &&
    f.scheduled_in &&
    f.estimated_in !== f.scheduled_in
  ){
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
    console.log("❌ ERROR API:", error.response?.data || error.message);

    res.status(500).json({
      error: "Error obteniendo vuelos",
      detalle: error.response?.data || error.message
    });
  }
});

app.listen(4000, () => {
  console.log("🔥 Servidor corriendo en http://localhost:4000");
});