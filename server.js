const express = require("express");
const axios = require("axios");
const cors = require("cors");
const multer = require("multer");
const fs = require("fs");
require("dotenv").config();

const app = express();
app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ limit: '50mb', extended: true }));

let anuncios = [];
let anunciosActivos = true;

// 📥 GUARDAR ANUNCIO
app.post("/anuncios", (req, res) => {
  const { tipo, texto, media, duracion } = req.body;

  const nuevo = {
    id: Date.now(),
    tipo,
    texto,
    media,
    duracion: duracion || 10
  };

  anuncios.push(nuevo);

  res.json({ ok: true, anuncio: nuevo });
});

// 📤 OBTENER ANUNCIOS
app.get("/anuncios", (req, res) => {
  if (!anunciosActivos) return res.json([]);
  res.json(anuncios);
});

app.get("/anuncios/estado", (req, res) => {
  res.json({ activos: anunciosActivos });
});

// 🔴 ENCENDER / APAGAR ANUNCIOS
app.post("/anuncios/toggle", (req, res) => {
  anunciosActivos = !anunciosActivos;
  res.json({ activos: anunciosActivos });
});

// =========================
// 📂 CONFIG ARCHIVOS (ANUNCIOS)
// =========================

if (!fs.existsSync("uploads")) {
  fs.mkdirSync("uploads");
}

app.use("/uploads", express.static("uploads"));

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, "uploads"),
  filename: (req, file, cb) => {
    const unique = Date.now() + "-" + file.originalname;
    cb(null, unique);
  }
});

const upload = multer({ storage, limits: { fileSize: 50 * 1024 * 1024 } });

// =========================
// 📦 BASE DE DATOS ANUNCIOS
// =========================

const DB_FILE = "anuncios.json";

function leerAnuncios() {
  if (!fs.existsSync(DB_FILE)) return [];
  return JSON.parse(fs.readFileSync(DB_FILE));
}

function guardarAnuncios(data) {
  fs.writeFileSync(DB_FILE, JSON.stringify(data, null, 2));
}

// =========================
// 🔐 API KEY desde Render
// =========================

const API_KEY = process.env.API_KEY;

// 🛫 Aeropuerto
const AIRPORT = "POP";

// =========================
// 🌐 Ruta base
// =========================

app.get("/", (req, res) => {
  res.send("🔥 API aeropuerto PRO funcionando");
});

// =========================
// 🕐 Formato hora RD
// =========================

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

// =========================
// ✈️ ENDPOINT VUELOS
// =========================

app.get("/flights", async (req, res) => {
  try {

    const url = `https://aeroapi.flightaware.com/aeroapi/airports/${AIRPORT}/flights`;

    const response = await axios.get(url, {
      headers: { "x-apikey": API_KEY }
    });

    const data = response.data;

    // ✈️ SALIDAS
    const salidas = (data.departures || []).slice(0, 10).map(f => ({
      vuelo: f.ident || "N/A",
      destino: f.destination?.code || "N/A",
      salida: formatHora(f.actual_out || f.estimated_out || f.scheduled_out),
      llegada: "",
      estado: (f.status || "UNKNOWN").replaceAll("_", " ")
    }));

    // 🛬 LLEGADAS
    const llegadas = (data.arrivals || []).slice(0, 10).map(f => {

      let hora = "";
      let estado = (f.status || "UNKNOWN").replaceAll("_", " ");

      if (!f.actual_out) {
        hora = formatHora(f.scheduled_in);

      } else if (f.actual_out && !f.actual_in) {
        hora = formatHora(f.estimated_in ?? f.scheduled_in);

      } else if (f.actual_in) {
        hora = formatHora(f.actual_in);
        estado = "ARRIVED";
      }

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
        destino: f.origin?.code || "N/A",
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

// =========================
// 📢 ENDPOINT ANUNCIOS (NUEVO)
// =========================

app.post("/anuncios/upload", upload.single("media"), (req, res) => {
  const anuncios = leerAnuncios();

  const nuevo = {
    id: Date.now(),
    tipo: req.body.tipo,
    texto: req.body.texto || "",
    media: req.file ? `/uploads/${req.file.filename}` : null,
    duracion: parseInt(req.body.duracion) || 10
  };

  anuncios.push(nuevo);
  guardarAnuncios(anuncios);

  res.json({ ok: true });
});

app.get("/anuncios/list", (req, res) => {
  res.json(leerAnuncios());
});

// =========================
// 🌐 PUERTO PARA RENDER
// =========================

const PORT = process.env.PORT || 4000;

app.listen(PORT, () => {
  console.log("🔥 Servidor corriendo en puerto " + PORT);
});

let asignaciones = {};

// 📥 GUARDAR
app.post("/asignaciones", (req, res) => {
  const { vuelo, posicion, nombre } = req.body;

  if (!asignaciones[vuelo]) {
    asignaciones[vuelo] = {};
  }

  asignaciones[vuelo][posicion] = nombre;

  res.json({ ok: true });
});

// 📤 OBTENER
app.get("/asignaciones", (req, res) => {
  res.json(asignaciones);
});
