const express = require("express");
const axios = require("axios");
const cors = require("cors");
const multer = require("multer");
const fs = require("fs");
const path = require("path");
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

/** Intervalo por defecto si no hay config/pollingInterval en Firebase (ms); 15 min recomendado */
const FLIGHT_SYNC_MS = Math.max(
  60_000,
  parseInt(process.env.FLIGHT_SYNC_MS || "", 10) || 900_000
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
 * Convierte un instante ISO de FlightAware a HH:MM en reloj de República Dominicana.
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

/**
 * Hora de llegada: actual_on > estimated_on > scheduled_on (AeroAPI; *_in equivalentes).
 * @returns {{ hora: string, fuente: "real"|"est"|"sched" }}
 */
function calcularLlegadaReal(flight) {
  const f = flight || {};
  const first = (...keys) => {
    for (const k of keys) {
      const v = f[k];
      if (v != null && String(v).trim() !== "") return v;
    }
    return null;
  };

  const actualOn = first("actual_on", "actual_in");
  if (actualOn) {
    return { hora: formatHora(actualOn), fuente: "real" };
  }

  const estOn = first("estimated_on", "estimated_in");
  if (estOn) {
    return { hora: formatHora(estOn), fuente: "est" };
  }

  const schedOn = first("scheduled_on", "scheduled_in");
  if (schedOn) {
    return { hora: formatHora(schedOn), fuente: "sched" };
  }

  return { hora: "", fuente: "sched" };
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

function mapAeroArrivalEstado(f) {
  const actIn = f.actual_on || f.actual_in;
  const estIn = f.estimated_on || f.estimated_in;
  const schedIn = f.scheduled_on || f.scheduled_in;
  const out = f.actual_out || f.actual_off;
  const enRuta = Boolean(out && !actIn);
  const st = (f.status || "")
    .toString()
    .toLowerCase()
    .replace(/\s+/g, "_");

  if (actIn || st === "arrived" || st === "landed") return "ARRIVED";
  if (enRuta || st === "en_route" || st === "active") return "EN ROUTE";
  if (st === "cancelled") return "CANCELLED";
  if (st === "diverted") return "DIVERTED";
  if (st === "delayed") return "DELAYED";
  if (estIn && schedIn && String(estIn) !== String(schedIn)) return "DELAYED";
  if (st === "scheduled" || !f.status) return undefined;
  return (f.status || "").toString().toUpperCase().replace(/_/g, " ");
}

function mapAeroDepartureEstado(f) {
  const st = (f.status || "")
    .toString()
    .toLowerCase()
    .replace(/\s+/g, "_");
  if (st === "cancelled") return "CANCELLED";
  if (st === "diverted") return "DIVERTED";
  if (st === "arrived" || st === "landed") return "DEPARTED";
  if (st === "en_route" || st === "active") return "EN ROUTE";
  if (st === "delayed") return "DELAYED";
  if (st === "scheduled" || !f.status) return undefined;
  return (f.status || "").toString().toUpperCase().replace(/_/g, " ");
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
// ✈️ AeroAPI (FlightAware): GET /flights, sync scheduler, /api/flights/refresh
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
    params: { max_pages: 3 }
  });

  const data = response.data;
  const scheduledDepartures = data.scheduled_departures || [];
  const scheduledArrivals = data.scheduled_arrivals || [];

  const airportCode = (a) => a?.code_iata || a?.code || "N/A";

  const salidas = scheduledDepartures.map((f) => {
    const id = normalizeIdent(f.ident) || (f.ident || "N/A").toString();
    return {
      vuelo: id,
      destino: airportCode(f.destination),
      salida: formatHora(
        f.actual_out || f.estimated_out || f.scheduled_out
      ),
      llegada: "",
      gate: f.gate_origin || "",
      estado: mapAeroDepartureEstado(f)
    };
  });

  const llegadas = scheduledArrivals.map((f) => {
    const schedIn = f.scheduled_on || f.scheduled_in;
    const estIn = f.estimated_on || f.estimated_in;
    const actIn = f.actual_on || f.actual_in;
    const llegadaProgramada = formatHora(schedIn);
    const llegadaEstimadaRaw = formatHora(estIn);
    const llegadaEstimada =
      llegadaEstimadaRaw === llegadaProgramada ? "" : llegadaEstimadaRaw;
    const llegadaReal = formatHora(actIn);
    const { hora: horaLlegadaPop, fuente: llegadaFuente } =
      calcularLlegadaReal(f);
    const salidaOrigen = formatHora(
      f.actual_off || f.estimated_off || f.scheduled_off ||
        f.actual_out || f.estimated_out || f.scheduled_out
    );
    const enRuta = Boolean((f.actual_out || f.actual_off) && !actIn);
    const progresoPct =
      typeof f.progress_percent === "number" ? f.progress_percent : null;
    const origen = airportCode(f.origin);
    const id = normalizeIdent(f.ident) || (f.ident || "N/A").toString();
    const dateAnchor = dateStrFromAeroIso(schedIn || f.scheduled_out);
    const retraso = retrasoMinutosDesdeHHMM(
      horaLlegadaPop,
      llegadaProgramada,
      dateAnchor
    );

    return {
      vuelo: id,
      origen,
      destino: origen,
      llegada: horaLlegadaPop,
      llegadaFuente,
      llegadaProgramada,
      llegadaEstimada,
      llegadaReal,
      salidaOrigen,
      enRuta,
      progresoPct,
      salida: "",
      gate: f.gate_destination || "",
      estado: mapAeroArrivalEstado(f),
      retraso
    };
  });

  return { salidas, llegadas };
}

app.get("/flights", async (req, res) => {
  try {
    const payload = await buildFlightsPayload();
    res.json({ salidas: payload.salidas, llegadas: payload.llegadas });
  } catch (error) {
    console.log(
      "❌ FlightAware /flights:",
      error.response?.data || error.message
    );
    res.status(500).json({
      error: "Error obteniendo vuelos (FlightAware)",
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

/** Sync incremental Firebase desde payload FlightAware (AeroAPI). */
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
    payload = await buildFlightsPayload();
  } catch (e) {
    const status = e.response?.status ?? e.status;
    const detail = e.response?.data || e.message;
    console.log("❌ Sync FlightAware:", e.message, status || "");
    return {
      ok: false,
      reason: "flightaware_error",
      error: e.message,
      status: status || null,
      detail
    };
  }

  const nArr = payload.llegadas?.length || 0;
  const nDep = payload.salidas?.length || 0;
  const nTotal = nArr + nDep;
  console.log(
    `FlightAware ✅ — ${nTotal} vuelos encontrados para MDPP`
  );

  return syncPayloadToRtdb(payload);
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
      `[${ts}] FlightAware sync: sin cambios — próximo ciclo en 15min`
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
      return { dateStr, centerInstant: null, llegada: null };
    }
    const firstKey = Object.keys(flights)[0];
    const row = flights[firstKey];
    const centerInstant = flightWindowCenterInstant(dateStr, row);
    const llegada = row?.llegada || row?.llegadaProgramada || null;
    return { dateStr, centerInstant, llegada, row };
  } catch (e) {
    return {
      dateStr: null,
      centerInstant: null,
      llegada: null,
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

    const { dateStr, centerInstant, llegada, error: winError } =
      await readFlightWindowInfo();

    if (winError || !dateStr) {
      console.log(`[${ts}] No se pudo leer ventana de vuelo: ${winError || "sin fecha"}`);
    } else if (!centerInstant) {
      console.log(
        `[${ts}] Sin hora de llegada/programada válida para ventana (${dateStr})`
      );
    } else {
      const nowMs = Date.now();
      const centerMs = centerInstant.getTime();
      const windowStartMs = centerMs - FLIGHT_WINDOW_MS;
      const windowEndMs = centerMs + FLIGHT_WINDOW_MS;

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
        `[${ts}] /api/flights/refresh (FlightAware): sin cambios — próximo ciclo en 15min`
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

/** Tablero y panel por HTTP (iframe de vista previa en panel.html). No exponer dotfiles. */
app.use(
  express.static(path.join(__dirname, "."), {
    dotfiles: "deny",
    index: false,
  })
);

app.listen(PORT, () => {
  console.log("🔥 Servidor corriendo en puerto " + PORT);
  console.log(
    "⏱ Sync vuelos (FlightAware) → Firebase: intervalo por defecto",
    Math.max(POLLING_MIN_SEC, FLIGHT_SYNC_MS / 1000),
    "s; override en RTDB config/pollingInterval (segundos, mín",
    POLLING_MIN_SEC,
    ")"
  );
  flightSyncSchedulerLoop().catch((e) =>
    console.log("❌ Flight sync scheduler:", e.message)
  );
});
