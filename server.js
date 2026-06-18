const express = require("express");
const axios = require("axios");
const cors = require("cors");
const multer = require("multer");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
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
// 🔐 FlightAware AeroAPI (vuelos MDPP/POP)
// =========================

// 🛫 Aeropuerto ICAO (Gregorio Luperón)
const AIRPORT = process.env.AIRPORT_CODE || "MDPP";

/** Intervalo por defecto si no hay config/pollingInterval en Firebase (ms); 10 min */
const FLIGHT_SYNC_MS = Math.max(
  60_000,
  parseInt(process.env.FLIGHT_SYNC_MS || "", 10) || 600_000
);

const POLLING_MIN_SEC = 600; // 10 min

const SYNC_SECRET = process.env.SYNC_SECRET || "POP_sync_2026_airport";

const AERO_API_KEY = process.env.FA_API_KEY || "";

const PANEL_JWT_SECRET =
  process.env.PANEL_JWT_SECRET || SYNC_SECRET + "_panel_jwt_2026";
const PANEL_TOKEN_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const PANEL_BOOTSTRAP_USER = (process.env.PANEL_BOOTSTRAP_USER || "").trim();
const PANEL_BOOTSTRAP_PASS = process.env.PANEL_BOOTSTRAP_PASS || "";

/** Realtime Database (REST). Misma base que index.html / panel.html. */
const RTDB_BASE_URL =
  "https://airport-board-ee661-default-rtdb.firebaseio.com".replace(/\/+$/, "");

// =========================
// 🌐 Ruta base
// =========================

app.get("/", (req, res) => {
  res.send("🔥 API aeropuerto PRO funcionando");
});

// =========================
// 🕐 Formato hora RD (America/Santo_Domingo, 24h → "14:19")
// =========================

function normalizeToHHMM(timeStr) {
  const m = String(timeStr || "")
    .trim()
    .match(/(\d{1,2}):(\d{2})/);
  if (!m) return "";
  const h = parseInt(m[1], 10);
  const min = m[2];
  if (!Number.isFinite(h) || h < 0 || h > 23) return "";
  return `${String(h).padStart(2, "0")}:${min}`;
}

/**
 * Convierte un instante ISO a HH:MM en reloj de República Dominicana.
 */
function formatHora(fecha) {
  if (!fecha) return "";

  try {
    const s = new Date(fecha).toLocaleTimeString("en-US", {
      timeZone: "America/Santo_Domingo",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false
    });
    return normalizeToHHMM(s);
  } catch {
    return "";
  }
}

/**
 * Interpreta HH:MM como hora local en RD en dateStr (YYYY-MM-DD) y devuelve el Date UTC.
 * RD usa UTC−4 todo el año (sin DST).
 */
/** HH:MM desde Firebase / input time (acepta "8:49", "08:49:00"). */
function normalizeRdHHMM(hhmmStr) {
  if (hhmmStr == null || String(hhmmStr).trim() === "") return null;
  const m = String(hhmmStr).trim().match(/^(\d{1,2}):(\d{2})/);
  if (!m) return null;
  const hh = String(parseInt(m[1], 10)).padStart(2, "0");
  const mm = String(parseInt(m[2], 10)).padStart(2, "0");
  if (parseInt(m[2], 10) > 59) return null;
  return `${hh}:${mm}`;
}

function dateStrTodayInRD() {
  return new Date().toLocaleDateString("en-CA", {
    timeZone: "America/Santo_Domingo"
  });
}

/**
 * Instante absoluto del reloj local RD (UTC−4, sin DST) en dateStr.
 * Toda la ventana ±2h se ancla en estos instantes; el "ahora" del servidor es Date.now() (mismo eje temporal).
 */
function rdWallClockToInstant(dateStr, hhmmStr) {
  const hm = normalizeRdHHMM(hhmmStr);
  if (!hm || !/^\d{4}-\d{2}-\d{2}$/.test(String(dateStr || "").trim()))
    return null;
  const [H, M] = hm.split(":");
  const iso = `${dateStr.trim()}T${H}:${M}:00-04:00`;
  const d = new Date(iso);
  return Number.isFinite(d.getTime()) ? d : null;
}

/**
 * Centro de ventana: el instante RD más tardío entre llegada real/estimada en Firebase
 * y llegada programada (evita cerrar la ventana solo porque el avión aterrizó temprano).
 */
function flightWindowCenterInstant(dateStr, row) {
  if (!row || typeof row !== "object") return null;
  const insL = rdWallClockToInstant(dateStr, row.llegada);
  const insP = rdWallClockToInstant(dateStr, row.llegadaProgramada);
  if (insL && insP) {
    return insL.getTime() >= insP.getTime() ? insL : insP;
  }
  return insL || insP || null;
}

function llegadaFieldLabel(fuente) {
  if (fuente === "real") return "llegada(real)";
  if (fuente === "est") return "llegada(est)";
  return "llegada(sched)";
}

/**
 * Diferencia en minutos entre dos HH:MM ya expresados en hora RD,
 * sobre el mismo día calendario RD (dateStr). Usa instantes locales RD, no UTC crudo.
 */
function retrasoMinutosDesdeHHMM(llegadaHHMM, progHHMM, dateStr) {
  if (!llegadaHHMM || !progHHMM || !dateStr) return null;
  const a = rdWallClockToInstant(dateStr, llegadaHHMM);
  const b = rdWallClockToInstant(dateStr, progHHMM);
  if (!a || !b) return null;
  const diff = Math.round((a.getTime() - b.getTime()) / 60000);
  return Number.isFinite(diff) ? diff : null;
}

function sameRetraso(a, b) {
  const na = a == null || a === "" ? null : Number(a);
  const nb = b == null || b === "" ? null : Number(b);
  if (na === null && nb === null) return true;
  if (na === null || nb === null) return false;
  return na === nb;
}

function formatRetrasoChangelog(mins) {
  if (mins === null || mins === undefined) return "retraso: —";
  if (mins === 0) return "retraso: 0";
  if (mins > 0) return `retraso: +${mins}min`;
  return `retraso: ${mins}min`;
}

function dateStrFromAeroIso(iso) {
  if (!iso) return new Date().toISOString().slice(0, 10);
  try {
    return new Date(iso).toLocaleDateString("en-CA", {
      timeZone: "America/Santo_Domingo"
    });
  } catch {
    return new Date().toISOString().slice(0, 10);
  }
}

function normalizeIdent(v) {
  return (v || "")
    .toString()
    .trim()
    .toUpperCase()
    .replace(/\s+/g, "");
}

/** Misma lógica que index.html: no pisar estado operativo manual desde el panel */
function isEstadoStaffLocked(estado) {
  const n = (estado || "")
    .toString()
    .toUpperCase()
    .replace(/\s+/g, "-")
    .replace(/_/g, "-");
  return ["BOARDING", "DEPARTED", "DELAYED", "CANCELLED", "DIVERTED"].includes(n);
}

function pickApiEstado(row, arr, dep) {
  const ea = arr?.estado;
  const ed = dep?.estado;
  if (ea && ed && ea !== ed) {
    const hasL = Boolean((row.llegada || "").toString().trim());
    const hasS = Boolean((row.salida || "").toString().trim());
    if (hasL && !hasS) return ea;
    if (hasS && !hasL) return ed;
    return ea;
  }
  return ea || ed || null;
}

// =========================
// ✈️ FlightAware: GET /flights, sync scheduler, /api/flights/refresh
// =========================

function splitBoardVuelo(raw) {
  const s = String(raw || "").trim();
  if (!s.includes("/")) return { arr: s, dep: s };
  const legs = s.split("/").map((x) => x.trim()).filter(Boolean);
  const arr = legs[0] || s;
  const m = arr.match(/^([A-Za-z0-9]+\s+)/);
  const prefix = m ? m[1].trim() : "";
  const depLeg = legs[1] || "";
  const dep =
    prefix && depLeg && !/[A-Za-z]/.test(depLeg)
      ? `${prefix}${depLeg}`.replace(/\s+/g, " ").trim()
      : depLeg || arr;
  return { arr, dep };
}

/** Tablero Firebase → mismo formato que GET /flights (fallback si API externa falla) */
async function buildFlightsPayloadFromFirebase() {
  let dateStr = dateStrTodayInRD();
  try {
    const cfg = await rtdbGet("config/selectedDate");
    if (typeof cfg === "string" && cfg.trim()) dateStr = cfg.trim();
  } catch (_) {}

  let flights = {};
  try {
    flights = (await rtdbGet(`flightsByDate/${dateStr}`)) || {};
  } catch (_) {
    return { salidas: [], llegadas: [], source: "firebase", date: dateStr };
  }

  const llegadas = [];
  const salidas = [];

  for (const row of Object.values(flights)) {
    if (!row || typeof row !== "object") continue;
    const { arr, dep } = splitBoardVuelo(row.vuelo);
    const dest = String(row.destino || row.origen || "").trim();
    const gate = row.gate || "";
    const estado = row.estado || "ON";
    const parts = dest.split("-").map((s) => s.trim());

    if (row.llegada || row.llegadaProgramada || row.llegadaEstimada) {
      llegadas.push({
        vuelo: normalizeIdent(arr) || arr,
        origen: parts[0] || dest,
        destino: dest,
        llegada: row.llegada || "",
        llegadaProgramada: row.llegadaProgramada || "",
        llegadaEstimada: row.llegadaEstimada || "",
        llegadaReal: row.llegadaReal || "",
        salidaOrigen: row.salidaOrigen || "",
        salida: "",
        gate,
        estado,
        retraso: row.retraso ?? null,
        aerolinea: row.aerolinea || "",
        source: "firebase"
      });
    }

    if (row.salida) {
      salidas.push({
        vuelo: normalizeIdent(dep) || dep,
        destino: parts[1] || parts[0] || dest,
        salida: row.salida || "",
        gate,
        estado,
        aerolinea: row.aerolinea || "",
        source: "firebase"
      });
    }
  }

  return { salidas, llegadas, source: "firebase", date: dateStr };
}

async function aeroApiGet(url, config) {
  const maxAttempts = 3;
  let backoffMs = 2000;
  let lastErr;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await axios.get(url, config);
    } catch (e) {
      lastErr = e;
      const status = e.response?.status;
      const retryable =
        status === 429 ||
        (status >= 500 && status < 600) ||
        e.code === "ECONNRESET" ||
        e.code === "ETIMEDOUT";
      if (!retryable || attempt === maxAttempts) throw e;
      await new Promise((r) => setTimeout(r, backoffMs));
      backoffMs = Math.min(backoffMs * 2, 60_000);
    }
  }
  throw lastErr;
}

function calcularLlegadaAero(flight) {
  const f = flight || {};
  const first = (...keys) => {
    for (const k of keys) {
      const v = f[k];
      if (v != null && String(v).trim() !== "") return v;
    }
    return null;
  };
  const actualOn = first("actual_on", "actual_in");
  if (actualOn) return { hora: formatHora(actualOn), fuente: "real" };
  const estOn = first("estimated_on", "estimated_in");
  if (estOn) return { hora: formatHora(estOn), fuente: "est" };
  const schedOn = first("scheduled_on", "scheduled_in");
  if (schedOn) return { hora: formatHora(schedOn), fuente: "sched" };
  return { hora: "", fuente: "sched" };
}

function mapAeroArrivalEstado(f) {
  const actIn = f.actual_on || f.actual_in;
  const st = (f.status || "").toString().toLowerCase().replace(/\s+/g, "_");
  if (actIn || st === "arrived" || st === "landed") return "ARRIVED";
  if (st === "cancelled") return "CANCELLED";
  if (st === "diverted") return "DIVERTED";
  if (st === "delayed") return "DELAYED";
  if (st === "en_route" || st === "active") return "EN ROUTE";
  return undefined;
}

function mapAeroDepartureEstado(f) {
  const st = (f.status || "").toString().toLowerCase().replace(/\s+/g, "_");
  if (st === "cancelled") return "CANCELLED";
  if (st === "arrived" || st === "landed") return "DEPARTED";
  if (st === "en_route" || st === "active") return "EN ROUTE";
  if (st === "delayed") return "DELAYED";
  return undefined;
}

async function buildFlightsPayloadFlightAware() {
  if (!AERO_API_KEY) {
    const err = new Error("FA_API_KEY no configurada");
    err.code = "NO_API_KEY";
    throw err;
  }
  const url = `https://aeroapi.flightaware.com/aeroapi/airports/${AIRPORT}/flights`;
  const response = await aeroApiGet(url, {
    headers: { "x-apikey": AERO_API_KEY },
    params: { max_pages: 3 },
    timeout: 60_000
  });
  const data = response.data || {};
  const airportCode = (a) => a?.code_iata || a?.code || "N/A";

  const arrMap = new Map();
  const depMap = new Map();

  const mapAeroSalida = (f) => ({
    vuelo: normalizeIdent(f.ident) || String(f.ident || "N/A"),
    destino: airportCode(f.destination),
    salida: formatHora(f.actual_out || f.estimated_out || f.scheduled_out),
    llegada: "",
    gate: f.gate_origin || "",
    estado: mapAeroDepartureEstado(f),
    source: "flightaware"
  });

  const mapAeroLlegada = (f) => {
    const schedIn = f.scheduled_on || f.scheduled_in;
    const { hora: horaLlegadaPop, fuente: llegadaFuente } = calcularLlegadaAero(f);
    const llegadaProgramada = formatHora(schedIn);
    const dateAnchor = dateStrFromAeroIso(schedIn || f.scheduled_out);
    return {
      vuelo: normalizeIdent(f.ident) || String(f.ident || "N/A"),
      origen: airportCode(f.origin),
      destino: airportCode(f.origin),
      llegada: horaLlegadaPop,
      llegadaFuente,
      llegadaProgramada,
      llegadaEstimada: "",
      llegadaReal: formatHora(f.actual_on || f.actual_in),
      salidaOrigen: formatHora(
        f.actual_off || f.estimated_off || f.scheduled_off ||
          f.actual_out || f.estimated_out || f.scheduled_out
      ),
      salida: "",
      gate: f.gate_destination || "",
      estado: mapAeroArrivalEstado(f),
      retraso: retrasoMinutosDesdeHHMM(
        horaLlegadaPop,
        llegadaProgramada,
        dateAnchor
      ),
      source: "flightaware"
    };
  };

  const ingestAeroList = (list, mapFn, bucket) => {
    for (const f of list || []) {
      const id = normalizeIdent(f.ident);
      if (!id || id === "N/A") continue;
      bucket.set(id, mapFn(f));
    }
  };

  ingestAeroList(data.scheduled_arrivals, mapAeroLlegada, arrMap);
  ingestAeroList(data.scheduled_departures, mapAeroSalida, depMap);
  ingestAeroList(data.arrivals, mapAeroLlegada, arrMap);
  ingestAeroList(data.departures, mapAeroSalida, depMap);

  const salidas = [...depMap.values()];
  const llegadas = [...arrMap.values()];

  return { salidas, llegadas };
}

/** Solo APIs en vivo (para sync → Firebase) */
async function buildFlightsPayloadLive() {
  const p = await buildFlightsPayloadFlightAware();
  return { ...p, source: "flightaware" };
}

/** GET /flights: API en vivo, o Firebase si la API falla */
async function buildFlightsPayload() {
  try {
    return await buildFlightsPayloadLive();
  } catch (e) {
    console.log("⚠️ API en vivo no disponible, usando Firebase:", e.message);
    const fb = await buildFlightsPayloadFromFirebase();
    if (fb.llegadas.length || fb.salidas.length) {
      return { ...fb, fallback: true, apiError: e.message };
    }
    throw e;
  }
}

function mapAeroEstadoToFirebase(est) {
  if (est === "ARRIVED") return "ARRIVED";
  if (est === "EN ROUTE") return "ON";
  if (est === "CANCELLED") return "CANCELLED";
  if (est === "DI" || est === "DIVERTED") return "DIVERTED";
  return "ON";
}

function mapFlightAwareToSuggestRow(f, tipo) {
  const isArrival = tipo === "llegada";
  const destino = isArrival ? f.origen : f.destino;
  const hora = isArrival ? f.llegada : f.salida;
  return {
    vuelo: f.vuelo,
    destino: destino || "",
    aerolinea: "",
    llegada: isArrival ? (f.llegada || "") : "",
    llegadaProgramada: isArrival ? (f.llegadaProgramada || "") : "",
    salida: !isArrival ? (f.salida || "") : "",
    gate: f.gate || "",
    estado: mapAeroEstadoToFirebase(f.estado),
    source: "flightaware",
    tipo,
    label: `${f.vuelo} · ${destino || "POP"} · ${tipo}${hora ? ` · ${hora}` : ""}`
  };
}

function flightAwareMatchesQuery(vuelo, q) {
  const compact = q.trim().toUpperCase().replace(/\s+/g, "");
  const qLower = q.trim().toLowerCase();
  const digits = q.replace(/\D/g, "");
  const vn = normalizeIdent(vuelo);
  if (!vn) return false;
  if (compact.length >= 2 && vn.includes(compact)) return true;
  if (digits.length >= 2 && vn.replace(/\D/g, "").includes(digits)) return true;
  return vn.toLowerCase().includes(qLower);
}

async function searchFlightAwareSuggest(q) {
  if (!AERO_API_KEY || AERO_API_KEY.length < 8) return [];
  try {
    const payload = await buildFlightsPayloadFlightAware();
    const out = [];
    const seen = new Set();
    for (const f of payload.llegadas || []) {
      if (!flightAwareMatchesQuery(f.vuelo, q)) continue;
      const id = normalizeIdent(f.vuelo);
      if (!id || seen.has(id)) continue;
      seen.add(id);
      out.push(mapFlightAwareToSuggestRow(f, "llegada"));
    }
    for (const f of payload.salidas || []) {
      if (!flightAwareMatchesQuery(f.vuelo, q)) continue;
      const id = normalizeIdent(f.vuelo);
      if (!id || seen.has(id)) continue;
      seen.add(id);
      out.push(mapFlightAwareToSuggestRow(f, "salida"));
    }
    return out.slice(0, 10);
  } catch {
    return [];
  }
}

async function searchFirebaseSuggest(q) {
  const qLower = q.trim().toLowerCase();
  if (qLower.length < 2) return [];

  let selectedDate = dateStrTodayInRD();
  try {
    const cfg = await rtdbGet("config/selectedDate");
    if (typeof cfg === "string" && cfg) selectedDate = cfg;
  } catch {
    /* ignore */
  }

  let flightsData = {};
  try {
    flightsData = (await rtdbGet(`flightsByDate/${selectedDate}`)) || {};
  } catch {
    return [];
  }

  const out = [];
  for (const [key, raw] of Object.entries(flightsData)) {
    const f = raw || {};
    const vuelo = String(f.vuelo || key);
    const haystack = [vuelo, f.destino, f.aerolinea, key]
      .filter(Boolean)
      .join(" ")
      .toLowerCase();
    if (!haystack.includes(qLower)) continue;
    out.push({
      vuelo,
      destino: f.destino || "",
      aerolinea: f.aerolinea || "",
      llegada: f.llegada || "",
      llegadaProgramada: f.llegadaProgramada || "",
      salida: f.salida || "",
      gate: f.gate || "",
      estado: f.estado || "ON",
      source: "firebase",
      tipo: "tablero",
      label: `${vuelo} · ${f.aerolinea || "—"} · ${f.destino || "POP"} · tablero`
    });
  }
  return out.slice(0, 8);
}

app.get("/flights/suggest", async (req, res) => {
  const q = String(req.query.q || "").trim();
  if (q.length < 2) {
    return res.json({ suggestions: [] });
  }

  try {
    const [firebaseRows, apiRows] = await Promise.all([
      searchFirebaseSuggest(q),
      searchFlightAwareSuggest(q)
    ]);

    const seen = new Set();
    const merged = [];
    for (const row of [...firebaseRows, ...apiRows]) {
      const id = normalizeIdent(row.vuelo);
      if (!id || seen.has(id)) continue;
      seen.add(id);
      merged.push(row);
    }

    res.json({ suggestions: merged.slice(0, 12) });
  } catch (error) {
    console.log("❌ /flights/suggest:", error.message);
    res.status(500).json({
      error: "Error buscando sugerencias",
      detalle: error.message
    });
  }
});

app.get("/flights", async (req, res) => {
  try {
    const payload = await buildFlightsPayload();
    res.json({
      salidas: payload.salidas,
      llegadas: payload.llegadas,
      source: payload.source || "live",
      fallback: Boolean(payload.fallback),
      date: payload.date || null
    });
  } catch (error) {
    console.log(
      "❌ /flights:",
      error.response?.data || error.message
    );
    res.status(503).json({
      error: "API de vuelos no disponible",
      detalle: error.response?.data || error.message,
      hint:
        "Configura FA_API_KEY (FlightAware AeroAPI) en .env o edita vuelos en Firebase."
    });
  }
});

app.get("/api/health", async (req, res) => {
  let firebaseCount = 0;
  try {
    const fb = await buildFlightsPayloadFromFirebase();
    firebaseCount = (fb.llegadas?.length || 0) + (fb.salidas?.length || 0);
  } catch (_) {}
  res.json({
    ok: true,
    airport: AIRPORT,
    flightaware: Boolean(AERO_API_KEY && AERO_API_KEY.length > 8),
    primarySource: "flightaware",
    syncSecret: Boolean(SYNC_SECRET),
    syncEnabled: flightSyncEnabled,
    pollingSec: await readPollingIntervalSec(),
    firebaseFlights: firebaseCount
  });
});

app.get("/api/flights/sync-state", async (_req, res) => {
  try {
    const pollingSec = await readPollingIntervalSec();
    res.json({ enabled: flightSyncEnabled, pollingSec });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post("/api/flights/sync-state", async (req, res) => {
  if (!authorizeSync(req)) {
    return res.status(401).json({ error: "No autorizado" });
  }
  const raw =
    req.body?.enabled ??
    req.query.enabled ??
    (req.query.action === "pause"
      ? false
      : req.query.action === "play"
        ? true
        : undefined);
  if (raw === undefined) {
    return res.status(400).json({ error: "Falta enabled (true/false) o action (pause/play)" });
  }
  const enabled =
    raw === true ||
    raw === "true" ||
    raw === 1 ||
    raw === "1";
  const next = await setFlightSyncEnabled(enabled);
  const ts = new Date().toISOString();
  console.log(
    `[${ts}] Sync automático ${next ? "REANUDADO" : "PAUSADO"} desde panel`
  );
  res.json({
    ok: true,
    enabled: next,
    pollingSec: await readPollingIntervalSec()
  });
});

// =========================
// 🔁 Firebase RTDB (solo fetch REST, sin Admin SDK)
// =========================

function rtdbJsonUrl(path) {
  const p = String(path || "")
    .replace(/^\/+/, "")
    .replace(/\/+$/, "");
  return `${RTDB_BASE_URL}/${p}.json`;
}

async function rtdbGet(path) {
  const res = await fetch(rtdbJsonUrl(path));
  if (!res.ok) {
    const err = new Error(`RTDB GET ${res.status}`);
    err.status = res.status;
    throw err;
  }
  return res.json();
}

async function rtdbPatch(path, body) {
  const res = await fetch(rtdbJsonUrl(path), {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });
  if (!res.ok) {
    const err = new Error(`RTDB PATCH ${res.status}`);
    err.status = res.status;
    throw err;
  }
  if (res.status === 204) return null;
  const text = await res.text();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

// =========================
// 🔐 Panel — usuarios y claves
// =========================

function normalizePanelUsername(raw) {
  return String(raw || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]/g, "");
}

function hashPanelPassword(password, saltHex) {
  const salt = Buffer.from(saltHex, "hex");
  return crypto.scryptSync(String(password), salt, 64).toString("hex");
}

function createPanelPasswordRecord(password) {
  const salt = crypto.randomBytes(16).toString("hex");
  const hash = hashPanelPassword(password, salt);
  return { salt, hash };
}

function verifyPanelPassword(password, record) {
  if (!record?.salt || !record?.hash) return false;
  const hash = hashPanelPassword(password, record.salt);
  try {
    return crypto.timingSafeEqual(
      Buffer.from(hash, "hex"),
      Buffer.from(record.hash, "hex")
    );
  } catch {
    return false;
  }
}

function panelTokenB64url(obj) {
  return Buffer.from(JSON.stringify(obj)).toString("base64url");
}

function signPanelToken(payload) {
  const header = panelTokenB64url({ alg: "HS256", typ: "PANEL" });
  const body = panelTokenB64url({
    ...payload,
    exp: Date.now() + PANEL_TOKEN_TTL_MS
  });
  const sig = crypto
    .createHmac("sha256", PANEL_JWT_SECRET)
    .update(`${header}.${body}`)
    .digest("base64url");
  return `${header}.${body}.${sig}`;
}

function verifyPanelToken(token) {
  if (!token || typeof token !== "string") return null;
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const [header, body, sig] = parts;
  const expected = crypto
    .createHmac("sha256", PANEL_JWT_SECRET)
    .update(`${header}.${body}`)
    .digest("base64url");
  try {
    if (!crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) {
      return null;
    }
  } catch {
    return null;
  }
  try {
    const data = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
    if (!data?.sub || !data?.exp || Date.now() > data.exp) return null;
    return data;
  } catch {
    return null;
  }
}

function readPanelBearer(req) {
  const h = req.get("authorization") || "";
  return h.startsWith("Bearer ") ? h.slice(7).trim() : "";
}

async function rtdbDelete(path) {
  const res = await fetch(rtdbJsonUrl(path), { method: "DELETE" });
  if (!res.ok) {
    const err = new Error(`RTDB DELETE ${res.status}`);
    err.status = res.status;
    throw err;
  }
}

async function listPanelUsers() {
  const raw = await rtdbGet("config/panelUsers");
  if (!raw || typeof raw !== "object") return {};
  return raw;
}

async function getPanelUserRecord(username) {
  const key = normalizePanelUsername(username);
  if (!key) return null;
  const users = await listPanelUsers();
  return users[key] || null;
}

async function savePanelUserRecord(username, record) {
  const key = normalizePanelUsername(username);
  if (!key) throw new Error("usuario_invalido");
  await rtdbPatch(`config/panelUsers/${key}`, record);
  return key;
}

async function createPanelUser(username, password, role = "editor") {
  const key = normalizePanelUsername(username);
  if (!key || key.length < 2) throw new Error("usuario_invalido");
  if (!password || String(password).length < 4) throw new Error("clave_corta");
  const existing = await getPanelUserRecord(key);
  if (existing) throw new Error("usuario_existe");
  const creds = createPanelPasswordRecord(password);
  await savePanelUserRecord(key, {
    username: key,
    role: role === "admin" ? "admin" : "editor",
    salt: creds.salt,
    hash: creds.hash,
    createdAt: new Date().toISOString()
  });
  return key;
}

async function ensureBootstrapPanelUser() {
  if (!PANEL_BOOTSTRAP_USER || !PANEL_BOOTSTRAP_PASS) return null;
  const key = normalizePanelUsername(PANEL_BOOTSTRAP_USER);
  if (!key) return null;
  try {
    const existing = await getPanelUserRecord(key);
    const creds = createPanelPasswordRecord(PANEL_BOOTSTRAP_PASS);
    if (existing) {
      await savePanelUserRecord(key, {
        ...existing,
        username: key,
        role: "admin",
        salt: creds.salt,
        hash: creds.hash,
        updatedAt: new Date().toISOString()
      });
      console.log(`✓ Clave panel sincronizada: ${key}`);
      return key;
    }
    const keyCreated = await createPanelUser(
      PANEL_BOOTSTRAP_USER,
      PANEL_BOOTSTRAP_PASS,
      "admin"
    );
    console.log(`✓ Usuario panel creado: ${keyCreated} (admin)`);
    return keyCreated;
  } catch (e) {
    console.log("⚠️ Bootstrap panel user:", e.message);
    return null;
  }
}

function requirePanelAuth(req, res, { adminOnly = false } = {}) {
  const token = readPanelBearer(req);
  const data = verifyPanelToken(token);
  if (!data) {
    res.status(401).json({ error: "No autorizado" });
    return null;
  }
  if (adminOnly && data.role !== "admin") {
    res.status(403).json({ error: "Solo administradores" });
    return null;
  }
  return data;
}

app.post("/api/panel/login", async (req, res) => {
  try {
    await ensureBootstrapPanelUser();
    const username = normalizePanelUsername(req.body?.username);
    const password = String(req.body?.password || "");
    if (!username || !password) {
      return res.status(400).json({ error: "Faltan usuario o clave" });
    }
    const record = await getPanelUserRecord(username);
    if (!record || !verifyPanelPassword(password, record)) {
      return res.status(401).json({ error: "Usuario o clave incorrectos" });
    }
    const token = signPanelToken({
      sub: record.username || username,
      role: record.role || "editor"
    });
    res.json({
      ok: true,
      token,
      user: {
        username: record.username || username,
        role: record.role || "editor"
      },
      expiresInDays: 7
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get("/api/panel/me", (req, res) => {
  const data = requirePanelAuth(req, res);
  if (!data) return;
  res.json({
    ok: true,
    user: { username: data.sub, role: data.role || "editor" }
  });
});

app.get("/api/panel/users", async (req, res) => {
  const data = requirePanelAuth(req, res, { adminOnly: true });
  if (!data) return;
  try {
    const users = await listPanelUsers();
    const list = Object.values(users || {})
      .filter((u) => u && u.username)
      .map((u) => ({
        username: u.username,
        role: u.role || "editor",
        createdAt: u.createdAt || null
      }))
      .sort((a, b) => a.username.localeCompare(b.username));
    res.json({ ok: true, users: list });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post("/api/panel/users", async (req, res) => {
  const data = requirePanelAuth(req, res, { adminOnly: true });
  if (!data) return;
  try {
    const username = req.body?.username;
    const password = String(req.body?.password || "");
    const role = req.body?.role === "admin" ? "admin" : "editor";
    const key = await createPanelUser(username, password, role);
    res.json({ ok: true, username: key, role });
  } catch (e) {
    const code =
      e.message === "usuario_existe"
        ? 409
        : e.message === "usuario_invalido" || e.message === "clave_corta"
          ? 400
          : 500;
    res.status(code).json({ error: e.message });
  }
});

app.delete("/api/panel/users/:username", async (req, res) => {
  const data = requirePanelAuth(req, res, { adminOnly: true });
  if (!data) return;
  try {
    const key = normalizePanelUsername(req.params.username);
    if (!key) return res.status(400).json({ error: "usuario_invalido" });
    if (key === data.sub) {
      return res.status(400).json({ error: "no_puedes_borrarte" });
    }
    const record = await getPanelUserRecord(key);
    if (!record) return res.status(404).json({ error: "no_encontrado" });
    await rtdbDelete(`config/panelUsers/${key}`);
    res.json({ ok: true, username: key });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.patch("/api/panel/users/:username/password", async (req, res) => {
  const auth = requirePanelAuth(req, res);
  if (!auth) return;
  try {
    const key = normalizePanelUsername(req.params.username);
    const password = String(req.body?.password || "");
    if (!key || password.length < 4) {
      return res.status(400).json({ error: "clave_corta" });
    }
    if (auth.role !== "admin" && auth.sub !== key) {
      return res.status(403).json({ error: "Solo administradores" });
    }
    const record = await getPanelUserRecord(key);
    if (!record) return res.status(404).json({ error: "no_encontrado" });
    const creds = createPanelPasswordRecord(password);
    await savePanelUserRecord(key, {
      ...record,
      salt: creds.salt,
      hash: creds.hash,
      updatedAt: new Date().toISOString()
    });
    res.json({ ok: true, username: key });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/** Sync incremental Firebase desde payload FlightAware. */
async function syncPayloadToRtdb(payload) {
  const arrByIdent = {};
  for (const l of payload.llegadas) {
    const id = normalizeIdent(l.vuelo);
    if (!id || id === "N/A") continue;
    arrByIdent[id] = {
      llegada: l.llegada || "",
      llegadaFuente: l.llegadaFuente || "sched",
      llegadaProgramada: l.llegadaProgramada || "",
      llegadaEstimada: l.llegadaEstimada || "",
      llegadaReal: l.llegadaReal || "",
      gateArr: l.gate || "",
      salidaOrigen: l.salidaOrigen || "",
      estado:
        l.estado !== undefined && l.estado !== null && l.estado !== ""
          ? l.estado
          : undefined
    };
  }
  const depByIdent = {};
  for (const s of payload.salidas) {
    const id = normalizeIdent(s.vuelo);
    if (!id || id === "N/A") continue;
    depByIdent[id] = {
      salida: s.salida || "",
      gateDep: s.gate || "",
      estado:
        s.estado !== undefined && s.estado !== null && s.estado !== ""
          ? s.estado
          : undefined
    };
  }

  try {
    const selectedDateVal = await rtdbGet("config/selectedDate");
    const dateStr =
      selectedDateVal || new Date().toISOString().slice(0, 10);

    const flights = await rtdbGet("flightsByDate/" + dateStr);
    if (!flights || typeof flights !== "object") {
      return {
        ok: true,
        updated: 0,
        changed: false,
        date: dateStr,
        note: "sin vuelos en RTDB para esa fecha"
      };
    }

    let updatedRows = 0;
    const changeLines = [];
    const rowPatches = [];

    for (const key of Object.keys(flights)) {
      const row = flights[key];
      if (!row || typeof row !== "object") continue;
      if (row.noApiSync === true) continue;

      const idDep = normalizeIdent(row.vuelo);
      const idArr = normalizeIdent(row.vueloLlegada || row.vuelo);
      const arr = idArr ? arrByIdent[idArr] : null;
      const dep = idDep ? depByIdent[idDep] : null;
      if (!arr && !dep) continue;

      const patch = {};
      const changelog = [];

      if (arr?.llegada && arr.llegada !== (row.llegada || "")) {
        patch.llegada = arr.llegada;
        changelog.push(llegadaFieldLabel(arr.llegadaFuente));
      }

      const rowProgStored = (row.llegadaProgramada || "").toString().trim();
      if (!rowProgStored && arr?.llegadaProgramada) {
        const v = arr.llegadaProgramada;
        if (String(v) !== String(row.llegadaProgramada || "")) {
          patch.llegadaProgramada = v;
          changelog.push("llegadaProgramada");
        }
      }

      if (
        arr?.llegadaEstimada != null &&
        String(arr.llegadaEstimada) !== String(row.llegadaEstimada || "")
      ) {
        patch.llegadaEstimada = arr.llegadaEstimada;
        changelog.push("llegadaEstimada");
      }
      if (
        arr?.llegadaReal != null &&
        String(arr.llegadaReal) !== String(row.llegadaReal || "")
      ) {
        patch.llegadaReal = arr.llegadaReal;
        changelog.push("llegadaReal");
      }

      if (
        arr?.salidaOrigen &&
        arr.salidaOrigen !== (row.salidaOrigen || "")
      ) {
        patch.salidaOrigen = arr.salidaOrigen;
        changelog.push("salidaOrigen");
      }
      if (dep?.salida && dep.salida !== (row.salida || "")) {
        patch.salida = dep.salida;
        changelog.push("salida");
      }
      const g = dep?.gateDep || arr?.gateArr;
      if (g && g !== (row.gate || "")) {
        patch.gate = g;
        changelog.push("gate");
      }

      const apiEstado = pickApiEstado(row, arr, dep);
      if (apiEstado && !isEstadoStaffLocked(row.estado)) {
        const curEst = (row.estado || "").toString();
        if (apiEstado !== curEst) {
          patch.estado = apiEstado;
          changelog.push("estado");
        }
      }

      const mergedLlegada =
        patch.llegada !== undefined ? patch.llegada : row.llegada;
      const mergedProg =
        patch.llegadaProgramada !== undefined
          ? patch.llegadaProgramada
          : row.llegadaProgramada;
      const progEff =
        (mergedProg && String(mergedProg).trim()) ||
        (arr?.llegadaProgramada && String(arr.llegadaProgramada).trim()) ||
        "";
      const llegEff = (mergedLlegada && String(mergedLlegada).trim()) || "";
      let nuevoRetraso = null;
      if (llegEff && progEff) {
        nuevoRetraso = retrasoMinutosDesdeHHMM(llegEff, progEff, dateStr);
      }
      if (!sameRetraso(nuevoRetraso, row.retraso)) {
        patch.retraso = nuevoRetraso;
        changelog.push(formatRetrasoChangelog(nuevoRetraso));
      }

      if (Object.keys(patch).length === 0) continue;

      rowPatches.push({ key, patch });
      updatedRows++;
      const identLabel =
        (row.vuelo && String(row.vuelo).trim()) ||
        (row.vueloLlegada && String(row.vueloLlegada).trim()) ||
        key;
      changeLines.push(`${identLabel}: ${changelog.join(", ")}`);
    }

    if (updatedRows === 0) {
      return { ok: true, updated: 0, changed: false, date: dateStr };
    }

    for (const { key, patch } of rowPatches) {
      await rtdbPatch(`flightsByDate/${dateStr}/${key}`, patch);
      await rtdbPatch(`flights/${key}`, patch);
    }

    return {
      ok: true,
      updated: updatedRows,
      changed: true,
      date: dateStr,
      changeSummary: changeLines.join(" | ")
    };
  } catch (e) {
    const status = e.status ?? e.response?.status;
    const hint =
      status === 401 || status === 403
        ? " Revisa reglas de Realtime Database (lectura/escritura sin token)."
        : "";
    console.log("❌ Firebase RTDB:", e.message, status || "", hint);
    return {
      ok: false,
      reason: "firebase_rtdb_error",
      error: e.message,
      status: status || null
    };
  }
}

async function syncFlightTimesToRtdb() {
  let payload;
  try {
    payload = await buildFlightsPayloadLive();
  } catch (e) {
    const status = e.response?.status ?? e.status;
    const detail = e.detail || e.response?.data || e.message;
    const quota = status === 429;
    console.log("❌ Sync API:", e.message, status || "");
    return {
      ok: false,
      reason: quota ? "flightaware_quota" : "api_error",
      error: e.message,
      status: status || null,
      detail,
      hint: quota
        ? "Límite de peticiones FlightAware (429). Espera o revisa tu plan AeroAPI."
        : "Revisa FA_API_KEY en .env"
    };
  }

  const nArr = payload.llegadas?.length || 0;
  const nDep = payload.salidas?.length || 0;
  const nTotal = nArr + nDep;
  console.log(
    `FlightAware ✅ — ${nTotal} vuelos (${nArr} llegadas, ${nDep} salidas) para ${AIRPORT}`
  );

  return syncPayloadToRtdb(payload);
}

let syncFlightTimesInFlight = false;
let flightSyncEnabled = true;

const SYNC_STATE_FILE = path.join(__dirname, "sync-state.json");

function readSyncEnabledLocal() {
  try {
    if (fs.existsSync(SYNC_STATE_FILE)) {
      const j = JSON.parse(fs.readFileSync(SYNC_STATE_FILE, "utf8"));
      if (j && j.enabled === false) return false;
      if (j && j.enabled === true) return true;
    }
  } catch (_) {}
  return null;
}

function writeSyncEnabledLocal(enabled) {
  try {
    fs.writeFileSync(
      SYNC_STATE_FILE,
      JSON.stringify({ enabled: Boolean(enabled) }, null, 2)
    );
  } catch (e) {
    console.log("⚠️ No se pudo guardar sync-state.json:", e.message);
  }
}

async function readSyncEnabledFromRtdb() {
  try {
    const val = await rtdbGet("config/syncEnabled");
    if (val === false || val === "false" || val === 0) return false;
    if (val === true || val === "true" || val === 1) return true;
  } catch (_) {}
  const local = readSyncEnabledLocal();
  if (local !== null) return local;
  return true;
}

async function setFlightSyncEnabled(enabled) {
  flightSyncEnabled = Boolean(enabled);
  writeSyncEnabledLocal(flightSyncEnabled);
  try {
    await rtdbPatch("config/syncEnabled", flightSyncEnabled);
  } catch (e) {
    console.log("⚠️ No se pudo guardar config/syncEnabled:", e.message);
  }
  return flightSyncEnabled;
}

async function syncFlightTimesToRtdbSafe() {
  if (syncFlightTimesInFlight) {
    return { ok: false, skipped: true, reason: "sync_in_progress" };
  }
  syncFlightTimesInFlight = true;
  try {
    return await syncFlightTimesToRtdb();
  } finally {
    syncFlightTimesInFlight = false;
  }
}

function logFlightSyncOutcome(result, pollingSec) {
  const ts = new Date().toISOString();
  const mins = Math.max(1, Math.round(pollingSec / 60));
  if (result?.skipped) {
    console.log(
      `[${ts}] FlightAware sync omitido (sync en curso) — próximo ciclo en ${mins}min`
    );
    return;
  }
  if (!result?.ok) {
    console.log(
      `[${ts}] FlightAware sync falló: ${result?.reason || "unknown"}${result?.error ? ` — ${result.error}` : ""}`
    );
    return;
  }
  if (result.note) {
    console.log(
      `[${ts}] FlightAware sync: ${result.note} — próximo ciclo en ${mins}min`
    );
    return;
  }
  if (result.changed) {
    console.log(
      `[${ts}] FlightAware sync: ${result.updated} cambios — ${result.changeSummary || ""}`
    );
  } else {
    console.log(
      `[${ts}] FlightAware sync: sin cambios — próximo ciclo en ${mins}min`
    );
  }
}

async function readPollingIntervalSec() {
  let sec = Math.max(POLLING_MIN_SEC, Math.floor(FLIGHT_SYNC_MS / 1000));
  try {
    const val = await rtdbGet("config/pollingInterval");
    const v = parseInt(val, 10);
    if (!Number.isNaN(v) && v > 0) {
      sec = Math.max(POLLING_MIN_SEC, v);
    }
  } catch (_) {}
  return sec;
}

async function readFlightWindowInfo() {
  try {
    const selectedDate = await rtdbGet("config/selectedDate");
    const dateStr = (selectedDate && String(selectedDate).trim()) || dateStrTodayInRD();
    const flights = await rtdbGet("flightsByDate/" + dateStr);
    if (!flights || typeof flights !== "object" || !Object.keys(flights).length) {
      return { dateStr, centerInstant: null, llegada: null, pendingArrivals: 0 };
    }

    let centerInstant = null;
    let llegada = null;
    let pendingArrivals = 0;

    for (const row of Object.values(flights)) {
      if (!row || typeof row !== "object") continue;
      const st = (row.estado || "").toString().toUpperCase().replace(/\s+/g, " ");
      const hasArrival =
        Boolean(row.llegada || row.llegadaProgramada || row.vueloLlegada) ||
        String(row.vuelo || "").includes("/");
      if (hasArrival && !["ARRIVED", "CANCELLED", "DIVERTED"].includes(st)) {
        pendingArrivals++;
      }
      const ins = flightWindowCenterInstant(dateStr, row);
      if (!ins) continue;
      if (!centerInstant || ins.getTime() > centerInstant.getTime()) {
        centerInstant = ins;
        llegada = row.llegada || row.llegadaProgramada || null;
      }
    }

    return { dateStr, centerInstant, llegada, pendingArrivals };
  } catch (e) {
    return {
      dateStr: null,
      centerInstant: null,
      llegada: null,
      pendingArrivals: 0,
      error: e.message
    };
  }
}

const FLIGHT_WINDOW_MS = 2 * 60 * 60 * 1000; // ±2 h alrededor de la llegada

async function flightSyncSchedulerLoop() {
  const fmtSDQ = (d) =>
    normalizeToHHMM(
      d.toLocaleTimeString("en-US", {
        timeZone: "America/Santo_Domingo",
        hour: "2-digit",
        minute: "2-digit",
        hour12: false
      })
    );

  for (;;) {
    let pollingSec = await readPollingIntervalSec();
    const ts = new Date().toISOString();

    const { dateStr, centerInstant, llegada, pendingArrivals, error: winError } =
      await readFlightWindowInfo();

    if (!flightSyncEnabled) {
      console.log(`[${ts}] Sync automático PAUSADO — próximo chequeo en ${Math.max(1, Math.round(pollingSec / 60))}min`);
    } else if (winError || !dateStr) {
      console.log(`[${ts}] No se pudo leer ventana de vuelo: ${winError || "sin fecha"}`);
    } else if (!centerInstant) {
      console.log(
        `[${ts}] Sin hora de llegada/programada válida para ventana (${dateStr})`
      );
    } else {
      const nowMs = Date.now();
      const centerMs = centerInstant.getTime();
      const windowStartMs = centerMs - FLIGHT_WINDOW_MS;
      let windowEndMs = centerMs + FLIGHT_WINDOW_MS;
      if (pendingArrivals > 0) {
        windowEndMs = Math.max(windowEndMs, nowMs + 30 * 60 * 1000);
      }

      if (nowMs < windowStartMs) {
        console.log(
          `[${ts}] Fuera de ventana de vuelo — sync pausado hasta las ${fmtSDQ(new Date(windowStartMs))} RD (referencia ${normalizeRdHHMM(llegada) || "—"}, fecha ${dateStr})`
        );
      } else if (nowMs > windowEndMs) {
        console.log(
          `[${ts}] Ventana de vuelo cerrada para ${dateStr} (±2h RD desde referencia ${normalizeRdHHMM(llegada) || "—"})`
        );
      } else {
        try {
          const result = await syncFlightTimesToRtdbSafe();
          logFlightSyncOutcome(result, pollingSec);
        } catch (e) {
          console.log(`[${ts}] Flight sync excepción no controlada:`, e.message);
        }
      }
    }

    pollingSec = await readPollingIntervalSec();
    await new Promise((r) => setTimeout(r, pollingSec * 1000));
  }
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
    const result = await syncFlightTimesToRtdbSafe();
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
    const result = await syncFlightTimesToRtdbSafe();
    res.json(result);
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

/** Forzar sincronización FlightAware → Firebase (mismo auth que /sync-flights) */
app.get("/api/flights/refresh", async (req, res) => {
  if (!authorizeSync(req)) {
    return res.status(401).json({ error: "No autorizado" });
  }
  try {
    const result = await syncFlightTimesToRtdbSafe();
    const ts = new Date().toISOString();
    if (result.skipped) {
      console.log(
        `[${ts}] /api/flights/refresh (FlightAware): omitido (sync en curso)`
      );
    } else if (!result.ok) {
      console.log(
        `[${ts}] /api/flights/refresh (FlightAware): error — ${result.reason}`,
        result.error || ""
      );
    } else if (result.note) {
      console.log(
        `[${ts}] /api/flights/refresh (FlightAware): ${result.note}`
      );
    } else if (result.changed) {
      console.log(
        `[${ts}] /api/flights/refresh (FlightAware): ${result.updated} cambios — ${result.changeSummary || ""}`
      );
    } else {
      console.log(
        `[${ts}] /api/flights/refresh (FlightAware): sin cambios`
      );
    }
    res.json(result);
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
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

  const mediaPath = nuevo.media;
  const port = process.env.PORT || 4000;
  res.json({
    ok: true,
    media: mediaPath,
    url: mediaPath ? `http://localhost:${port}${mediaPath}` : null
  });
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

/** Tablero y panel por HTTP (iframe de vista previa en panel.html). No exponer dotfiles. */
app.use(
  express.static(path.join(__dirname, "."), {
    dotfiles: "deny",
    index: false,
  })
);

app.listen(PORT, () => {
  console.log("🔥 Servidor corriendo en puerto " + PORT);
  const base = (process.env.RENDER_EXTERNAL_URL || `http://localhost:${PORT}`).replace(/\/+$/, "");
  console.log("📱 Panel:  " + base + "/panel.html");
  console.log("📺 Tablero: " + base + "/index.html");
  console.log("🔌 API:    " + base + "/api/health");
  if (!AERO_API_KEY || AERO_API_KEY.length < 8) {
    console.log(
      "⚠️ FlightAware NO configurada: define FA_API_KEY en .env"
    );
  } else {
    console.log("✓ FlightAware AeroAPI — aeropuerto", AIRPORT);
  }
  if (!SYNC_SECRET) {
    console.log("⚠️ SYNC_SECRET vacío: /api/flights/refresh rechazará peticiones");
  } else {
    console.log("✓ Sync manual: GET /api/flights/refresh?secret=***");
  }
  console.log(
    "⏱ Sync vuelos (FlightAware) → Firebase: intervalo por defecto",
    Math.max(POLLING_MIN_SEC, FLIGHT_SYNC_MS / 1000),
    "s; override en RTDB config/pollingInterval (segundos, mín",
    POLLING_MIN_SEC,
    ")"
  );
  void (async () => {
    await ensureBootstrapPanelUser();
    flightSyncEnabled = await readSyncEnabledFromRtdb();
    console.log(
      flightSyncEnabled
        ? "▶ Sync automático ACTIVO"
        : "⏸ Sync automático PAUSADO (reanuda desde panel)"
    );
    flightSyncSchedulerLoop().catch((e) =>
      console.log("❌ Flight sync scheduler:", e.message)
    );
  })();
});
