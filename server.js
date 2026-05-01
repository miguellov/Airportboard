const express = require("express");
const axios = require("axios");
const cors = require("cors");
const multer = require("multer");
const fs = require("fs");
require("dotenv").config();

const app = express();
app.use(cors());
app.use(express.json({ limit: "50mb" }));
app.use(express.urlencoded({ limit: "50mb", extended: true }));

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

// 🛫 Aeropuerto (ICAO preferido por AeroAPI; MDPP = Gregorio Luperón, IATA POP)
const AIRPORT = process.env.AIRPORT_CODE || "MDPP";

const FLIGHT_SYNC_MS = Math.max(
  60_000,
  parseInt(process.env.FLIGHT_SYNC_MS || "", 10) || 5 * 60_000
);

const SYNC_SECRET = process.env.SYNC_SECRET || "";

const FIREBASE_DATABASE_URL =
  process.env.FIREBASE_DATABASE_URL ||
  "https://airport-board-ee661-default-rtdb.firebaseio.com";

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
      hour12: false,
      hourCycle: "h23",
      timeZone: "America/Santo_Domingo"
    });
  } catch {
    return "";
  }
}

function normalizeIdent(v) {
  return (v || "")
    .toString()
    .trim()
    .toUpperCase()
    .replace(/\s+/g, "");
}

// =========================
// ✈️ AeroAPI (compartido GET /flights + sync Firebase)
// =========================

async function buildFlightsPayload() {
  if (!API_KEY) {
    const err = new Error("API_KEY no configurada");
    err.code = "NO_API_KEY";
    throw err;
  }

  const url = `https://aeroapi.flightaware.com/aeroapi/airports/${AIRPORT}/flights`;

  const response = await axios.get(url, {
    headers: { "x-apikey": API_KEY },
    params: { max_pages: 2 }
  });

  const data = response.data;
  const scheduledDepartures = data.scheduled_departures || [];
  const scheduledArrivals = data.scheduled_arrivals || [];

  const airportCode = (a) => a?.code_iata || a?.code || "N/A";

  const salidas = scheduledDepartures.slice(0, 15).map((f) => ({
    vuelo: f.ident || "N/A",
    destino: airportCode(f.destination),
    salida: formatHora(f.actual_out || f.estimated_out || f.scheduled_out),
    llegada: "",
    gate: f.gate_origin || "",
    estado: (f.status || "UNKNOWN").replaceAll("_", " ")
  }));

  const llegadas = scheduledArrivals.slice(0, 15).map((f) => {
    let estado = (f.status || "UNKNOWN").replaceAll("_", " ");
    const horaLlegadaPop = formatHora(
      f.actual_in || f.estimated_in || f.scheduled_in
    );
    const salidaOrigen = formatHora(
      f.actual_out || f.estimated_out || f.scheduled_out
    );
    const enRuta = Boolean(f.actual_out && !f.actual_in);
    const progresoPct =
      typeof f.progress_percent === "number" ? f.progress_percent : null;

    if (f.actual_in) {
      estado = "ARRIVED";
    } else if (enRuta) {
      estado = "EN ROUTE";
    } else if (
      f.estimated_in &&
      f.scheduled_in &&
      f.estimated_in !== f.scheduled_in
    ) {
      estado = "DELAYED";
    }

    const origen = airportCode(f.origin);
    return {
      vuelo: f.ident || "N/A",
      origen,
      destino: origen,
      llegada: horaLlegadaPop,
      salidaOrigen,
      enRuta,
      progresoPct,
      salida: "",
      gate: f.gate_destination || "",
      estado
    };
  });

  return { salidas, llegadas };
}

app.get("/flights", async (req, res) => {
  try {
    const { salidas, llegadas } = await buildFlightsPayload();
    res.json({ salidas, llegadas });
  } catch (error) {
    if (error.code === "NO_API_KEY") {
      return res.status(500).json({
        error: "API_KEY no configurada",
        detalle: "Define API_KEY en el entorno (clave x-apikey de FlightAware AeroAPI)."
      });
    }
    console.log("❌ ERROR:", error.response?.data || error.message);

    res.status(500).json({
      error: "Error obteniendo vuelos",
      detalle: error.response?.data || error.message
    });
  }
});

// =========================
// 🔁 Sync horas → Firebase RTDB
// =========================

let firebaseDb = null;
let firebaseInitAttempted = false;

function getFirebaseDb() {
  if (firebaseDb) return firebaseDb;
  if (firebaseInitAttempted) return null;

  const b64 = process.env.FIREBASE_SERVICE_ACCOUNT_B64;
  const raw = process.env.FIREBASE_SERVICE_ACCOUNT;
  let jsonStr = null;
  if (b64) {
    try {
      jsonStr = Buffer.from(b64, "base64").toString("utf8");
    } catch {
      jsonStr = null;
    }
  } else if (raw) {
    jsonStr = raw;
  }

  if (!jsonStr) {
    firebaseInitAttempted = true;
    return null;
  }

  try {
    const { initializeApp, cert, getApps } = require("firebase-admin/app");
    const { getDatabase } = require("firebase-admin/database");
    const sa = JSON.parse(jsonStr);
    if (!getApps().length) {
      initializeApp({
        credential: cert(sa),
        databaseURL: FIREBASE_DATABASE_URL
      });
    }
    firebaseDb = getDatabase();
    firebaseInitAttempted = true;
    return firebaseDb;
  } catch (e) {
    console.log("❌ Firebase Admin:", e.message);
    firebaseInitAttempted = true;
    return null;
  }
}

async function syncFlightTimesToRtdb() {
  const db = getFirebaseDb();
  if (!db) return { ok: false, reason: "firebase_no_config" };
  if (!API_KEY) return { ok: false, reason: "no_api_key" };

  let payload;
  try {
    payload = await buildFlightsPayload();
  } catch (e) {
    console.log("❌ Sync AeroAPI:", e.message);
    return { ok: false, reason: "aeroapi_error", error: e.message };
  }

  const arrByIdent = {};
  for (const l of payload.llegadas) {
    const id = normalizeIdent(l.vuelo);
    if (!id || id === "N/A") continue;
    arrByIdent[id] = {
      llegada: l.llegada || "",
      gateArr: l.gate || "",
      salidaOrigen: l.salidaOrigen || ""
    };
  }
  const depByIdent = {};
  for (const s of payload.salidas) {
    const id = normalizeIdent(s.vuelo);
    if (!id || id === "N/A") continue;
    depByIdent[id] = { salida: s.salida || "", gateDep: s.gate || "" };
  }

  const dateSnap = await db.ref("config/selectedDate").once("value");
  const dateStr =
    dateSnap.val() || new Date().toISOString().slice(0, 10);

  const flightsSnap = await db.ref("flightsByDate/" + dateStr).once("value");
  const flights = flightsSnap.val();
  if (!flights || typeof flights !== "object") {
    return { ok: true, updated: 0, note: "sin vuelos en RTDB para esa fecha" };
  }

  const next = { ...flights };
  let updatedRows = 0;

  for (const key of Object.keys(flights)) {
    const row = flights[key];
    if (!row || typeof row !== "object") continue;
    if (row.noApiSync === true) continue;

    const idDep = normalizeIdent(row.vuelo);
    const idArr = normalizeIdent(row.vueloLlegada || row.vuelo);
    const arr = idArr ? arrByIdent[idArr] : null;
    const dep = idDep ? depByIdent[idDep] : null;
    if (!arr && !dep) continue;

    const merged = { ...row };
    let rowChanged = false;

    if (arr?.llegada && arr.llegada !== (row.llegada || "")) {
      merged.llegada = arr.llegada;
      rowChanged = true;
    }
    if (
      arr?.salidaOrigen &&
      arr.salidaOrigen !== (row.salidaOrigen || "")
    ) {
      merged.salidaOrigen = arr.salidaOrigen;
      rowChanged = true;
    }
    if (dep?.salida && dep.salida !== (row.salida || "")) {
      merged.salida = dep.salida;
      rowChanged = true;
    }
    const g = dep?.gateDep || arr?.gateArr;
    if (g && g !== (row.gate || "")) {
      merged.gate = g;
      rowChanged = true;
    }

    if (rowChanged) {
      next[key] = merged;
      updatedRows++;
    }
  }

  if (updatedRows === 0) {
    return { ok: true, updated: 0 };
  }

  await db.ref("flightsByDate/" + dateStr).set(next);
  await db.ref("flights").set(next);
  console.log("✅ Sync Firebase:", updatedRows, "vuelo(s)", dateStr);
  return { ok: true, updated: updatedRows, date: dateStr };
}

function authorizeSync(req) {
  if (!SYNC_SECRET) return false;
  const h = req.get("authorization") || "";
  const token = h.startsWith("Bearer ") ? h.slice(7) : "";
  const q = req.query.secret;
  return token === SYNC_SECRET || q === SYNC_SECRET;
}

app.post("/sync-flights", async (req, res) => {
  if (!authorizeSync(req)) {
    return res.status(401).json({ error: "No autorizado" });
  }
  try {
    const result = await syncFlightTimesToRtdb();
    res.json(result);
  } catch (e) {
    console.log("❌ sync-flights:", e);
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.get("/sync-flights", async (req, res) => {
  if (!authorizeSync(req)) {
    return res.status(401).json({ error: "No autorizado" });
  }
  try {
    const result = await syncFlightTimesToRtdb();
    res.json(result);
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

setInterval(() => {
  syncFlightTimesToRtdb().catch((e) => console.log("❌ Sync interval:", e.message));
}, FLIGHT_SYNC_MS);

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

let asignaciones = {};

app.post("/asignaciones", (req, res) => {
  const { vuelo, posicion, nombre } = req.body;

  if (!asignaciones[vuelo]) {
    asignaciones[vuelo] = {};
  }

  asignaciones[vuelo][posicion] = nombre;

  res.json({ ok: true });
});

app.get("/asignaciones", (req, res) => {
  res.json(asignaciones);
});

// =========================
// 🌐 PUERTO PARA RENDER
// =========================

const PORT = process.env.PORT || 4000;

app.listen(PORT, () => {
  console.log("🔥 Servidor corriendo en puerto " + PORT);
  console.log(
    "⏱ Sync vuelos → Firebase cada",
    FLIGHT_SYNC_MS / 1000,
    "s (si hay credenciales Admin)"
  );
  syncFlightTimesToRtdb().catch(() => {});
});
