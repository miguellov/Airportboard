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
// 🔐 AeroAPI (FlightAware): FA_API_KEY preferida, API_KEY por compatibilidad
// =========================

const AERO_API_KEY = process.env.FA_API_KEY || process.env.API_KEY;

// 🛫 Aeropuerto (ICAO preferido por AeroAPI; MDPP = Gregorio Luperón, IATA POP)
const AIRPORT = process.env.AIRPORT_CODE || "MDPP";

/** Intervalo por defecto si no hay config/pollingInterval en Firebase (ms) */
const FLIGHT_SYNC_MS = Math.max(
  60_000,
  parseInt(process.env.FLIGHT_SYNC_MS || "", 10) || 60_000
);

const POLLING_MIN_SEC = 900; // 15 min

const SYNC_SECRET = process.env.SYNC_SECRET || "";

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
// ✈️ AeroAPI (compartido GET /flights + sync Firebase)
// =========================

async function aeroApiGet(url, config) {
  const maxAttempts = 5;
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
      const ra = parseInt(e.response?.headers["retry-after"], 10);
      const waitMs =
        !Number.isNaN(ra) && ra > 0
          ? Math.min(ra * 1000, 300_000)
          : Math.min(backoffMs, 120_000);
      console.log(
        `⚠️ AeroAPI reintento ${attempt}/${maxAttempts} (${status || e.code}), esperando ${waitMs / 1000}s`
      );
      await new Promise((r) => setTimeout(r, waitMs));
      backoffMs = Math.min(backoffMs * 2, 120_000);
    }
  }
  throw lastErr;
}

async function buildFlightsPayload() {
  if (!AERO_API_KEY) {
    const err = new Error("FA_API_KEY / API_KEY no configurada");
    err.code = "NO_API_KEY";
    throw err;
  }

  const url = `https://aeroapi.flightaware.com/aeroapi/airports/${AIRPORT}/flights`;

  const response = await aeroApiGet(url, {
    headers: { "x-apikey": AERO_API_KEY },
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
    const llegadaProgramada = formatHora(f.scheduled_in);
    const llegadaEstimada = formatHora(f.estimated_in);
    const llegadaReal = formatHora(f.actual_in);
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
      llegadaProgramada,
      llegadaEstimada: llegadaEstimada === llegadaProgramada ? "" : llegadaEstimada,
      llegadaReal,
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
        error: "Clave AeroAPI no configurada",
        detalle:
          "Define FA_API_KEY (recomendado) o API_KEY: clave x-apikey de FlightAware AeroAPI."
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

async function syncFlightTimesToRtdb() {
  if (!AERO_API_KEY) return { ok: false, reason: "no_api_key" };

  let payload;
  try {
    payload = await buildFlightsPayload();
  } catch (e) {
    const status = e.response?.status;
    const detail = e.response?.data || e.message;
    console.log("❌ Sync AeroAPI:", e.message, status || "");
    return {
      ok: false,
      reason: "aeroapi_error",
      error: e.message,
      status: status || null,
      detail
    };
  }

  const arrByIdent = {};
  for (const l of payload.llegadas) {
    const id = normalizeIdent(l.vuelo);
    if (!id || id === "N/A") continue;
    arrByIdent[id] = {
      llegada: l.llegada || "",
      llegadaProgramada: l.llegadaProgramada || "",
      llegadaEstimada: l.llegadaEstimada || "",
      llegadaReal: l.llegadaReal || "",
      gateArr: l.gate || "",
      salidaOrigen: l.salidaOrigen || "",
      estado: l.estado || ""
    };
  }
  const depByIdent = {};
  for (const s of payload.salidas) {
    const id = normalizeIdent(s.vuelo);
    if (!id || id === "N/A") continue;
    depByIdent[id] = {
      salida: s.salida || "",
      gateDep: s.gate || "",
      estado: s.estado || ""
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

      const merged = { ...row };
      let rowChanged = false;
      const fields = [];

      if (arr?.llegada && arr.llegada !== (row.llegada || "")) {
        merged.llegada = arr.llegada;
        rowChanged = true;
        fields.push("llegada");
      }
      const patchLlegProg = (k, val) => {
        if (val != null && String(val) !== String(row[k] || "")) {
          merged[k] = val;
          rowChanged = true;
          fields.push(k);
        }
      };
      patchLlegProg("llegadaProgramada", arr?.llegadaProgramada);
      patchLlegProg("llegadaEstimada", arr?.llegadaEstimada);
      patchLlegProg("llegadaReal", arr?.llegadaReal);
      if (
        arr?.salidaOrigen &&
        arr.salidaOrigen !== (row.salidaOrigen || "")
      ) {
        merged.salidaOrigen = arr.salidaOrigen;
        rowChanged = true;
        fields.push("salidaOrigen");
      }
      if (dep?.salida && dep.salida !== (row.salida || "")) {
        merged.salida = dep.salida;
        rowChanged = true;
        fields.push("salida");
      }
      const g = dep?.gateDep || arr?.gateArr;
      if (g && g !== (row.gate || "")) {
        merged.gate = g;
        rowChanged = true;
        fields.push("gate");
      }

      const apiEstado = pickApiEstado(row, arr, dep);
      if (apiEstado && !isEstadoStaffLocked(row.estado)) {
        const curEst = (row.estado || "").toString();
        if (apiEstado !== curEst) {
          merged.estado = apiEstado;
          rowChanged = true;
          fields.push("estado");
        }
      }

      if (rowChanged) {
        const patch = {};
        for (const f of fields) {
          patch[f] = merged[f];
        }
        rowPatches.push({ key, patch });
        updatedRows++;
        changeLines.push(`${key}: ${fields.join(", ")}`);
      }
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

let syncFlightTimesInFlight = false;

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
  if (result?.skipped) {
    console.log(
      `[${ts}] Flight sync omitido (ya había una ejecución en curso) próximo ciclo ~${pollingSec}s`
    );
    return;
  }
  if (!result?.ok) {
    console.log(
      `[${ts}] Flight sync falló: ${result?.reason || "unknown"}${result?.error ? ` — ${result.error}` : ""}`
    );
    return;
  }
  if (result.note) {
    console.log(`[${ts}] Flight sync: ${result.note} (intervalo ~${pollingSec}s)`);
    return;
  }
  if (result.changed) {
    console.log(
      `[${ts}] Flight sync: datos actualizados — ${result.updated} fila(s), fecha ${result.date}. Detalle: ${result.changeSummary}`
    );
  } else {
    console.log(
      `[${ts}] Flight sync: sin cambios (AeroAPI alineado con Firebase) fecha ${result.date} — próximo ciclo ~${pollingSec}s`
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

/** Convierte HH:MM (hora de Santo Domingo, UTC-4 fijo) + fecha YYYY-MM-DD → Date UTC */
function hhmmToUTC(hhmmStr, dateStr) {
  const m = (hhmmStr || "").match(/^(\d{1,2}):(\d{2})$/);
  if (!m || !dateStr) return null;
  const [y, mo, d] = dateStr.split("-").map(Number);
  return new Date(Date.UTC(y, mo - 1, d, parseInt(m[1], 10) + 4, parseInt(m[2], 10)));
}

async function readFlightWindowInfo() {
  try {
    const selectedDate = await rtdbGet("config/selectedDate");
    const dateStr = selectedDate || new Date().toISOString().slice(0, 10);
    const flights = await rtdbGet("flightsByDate/" + dateStr);
    if (!flights || typeof flights !== "object" || !Object.keys(flights).length) {
      return { dateStr, llegada: null };
    }
    const firstKey = Object.keys(flights)[0];
    const llegada = flights[firstKey]?.llegada || null;
    return { dateStr, llegada };
  } catch (e) {
    return { dateStr: null, llegada: null, error: e.message };
  }
}

const FLIGHT_WINDOW_MS = 2 * 60 * 60 * 1000; // ±2 h alrededor de la llegada

async function flightSyncSchedulerLoop() {
  const fmtSDQ = (d) =>
    d.toLocaleTimeString("es-DO", {
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
      hourCycle: "h23",
      timeZone: "America/Santo_Domingo"
    });

  for (;;) {
    let pollingSec = await readPollingIntervalSec();
    const ts = new Date().toISOString();

    const { dateStr, llegada, error: winError } = await readFlightWindowInfo();

    if (winError || !dateStr) {
      console.log(`[${ts}] No se pudo leer ventana de vuelo: ${winError || "sin fecha"}`);
    } else if (!llegada) {
      console.log(`[${ts}] Sin vuelo cargado para hoy (${dateStr})`);
    } else {
      const arrivalUtc = hhmmToUTC(llegada, dateStr);
      if (!arrivalUtc) {
        console.log(`[${ts}] Hora de llegada inválida: "${llegada}"`);
      } else {
        const now = new Date();
        const windowStart = new Date(arrivalUtc.getTime() - FLIGHT_WINDOW_MS);
        const windowEnd = new Date(arrivalUtc.getTime() + FLIGHT_WINDOW_MS);

        if (now < windowStart) {
          console.log(
            `[${ts}] Fuera de ventana de vuelo — sync pausado hasta las ${fmtSDQ(windowStart)} (llegada ${llegada})`
          );
        } else if (now > windowEnd) {
          console.log(
            `[${ts}] Ventana de vuelo cerrada para ${dateStr} (llegada ${llegada})`
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

/** Forzar sincronización AeroAPI → Firebase (mismo auth que /sync-flights) */
app.get("/api/flights/refresh", async (req, res) => {
  if (!authorizeSync(req)) {
    return res.status(401).json({ error: "No autorizado" });
  }
  try {
    const result = await syncFlightTimesToRtdbSafe();
    const ts = new Date().toISOString();
    if (result.skipped) {
      console.log(`[${ts}] /api/flights/refresh: omitido (sync en curso)`);
    } else if (!result.ok) {
      console.log(`[${ts}] /api/flights/refresh: error — ${result.reason}`, result.error || "");
    } else if (result.note) {
      console.log(`[${ts}] /api/flights/refresh: ${result.note}`);
    } else if (result.changed) {
      console.log(`[${ts}] /api/flights/refresh: actualizado — ${result.changeSummary || ""}`);
    } else {
      console.log(
        `[${ts}] /api/flights/refresh: sin cambios${result.date ? ` (${result.date})` : ""}`
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
    "⏱ Sync vuelos → Firebase: intervalo por defecto",
    Math.max(POLLING_MIN_SEC, FLIGHT_SYNC_MS / 1000),
    "s; override en RTDB config/pollingInterval (segundos, mín",
    POLLING_MIN_SEC,
    ")"
  );
  flightSyncSchedulerLoop().catch((e) =>
    console.log("❌ Flight sync scheduler:", e.message)
  );
});
