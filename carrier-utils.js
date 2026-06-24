/**
 * JetBlue + WestJet — detección unificada, búsqueda multi-formato y orden por llegada.
 * Usado por server.js (Node) y panel/index (navegador).
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) {
    module.exports = api;
  }
  if (root) {
    root.CarrierUtils = api;
  }
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  const CARRIER_PREFIXES_JB = ["B6", "JBU"];
  const CARRIER_PREFIXES_WJ = ["WS", "WJA", "WEN"];
  const ALL_PREFIXES = [...CARRIER_PREFIXES_JB, ...CARRIER_PREFIXES_WJ];

  function normFlightIdent(x) {
    return String(x || "")
      .toUpperCase()
      .replace(/\s+/g, "");
  }

  function airlinePrefixVariants(prefix) {
    const p = String(prefix || "")
      .toUpperCase()
      .replace(/\s+/g, "");
    const set = new Set([p]);
    if (p === "B6") set.add("JBU");
    if (p === "JBU") set.add("B6");
    if (p === "WS" || p === "WJA" || p === "WEN") {
      set.add("WS");
      set.add("WJA");
      set.add("WEN");
    }
    return [...set];
  }

  function getFlightIdentPrefix(vuelo) {
    const split = splitIdentPrefixDigits(vuelo);
    return split ? split.prefix : "";
  }

  function getFlightIdentDigits(vuelo) {
    const split = splitIdentPrefixDigits(vuelo);
    return split ? split.num : "";
  }

  function detectCarrierFromPrefix(prefix) {
    const p = String(prefix || "")
      .toUpperCase()
      .replace(/\s+/g, "");
    const vars = airlinePrefixVariants(p);
    if (CARRIER_PREFIXES_JB.some((x) => vars.includes(x) || p.startsWith(x))) {
      return "jetblue";
    }
    if (CARRIER_PREFIXES_WJ.some((x) => vars.includes(x) || p.startsWith(x))) {
      return "westjet";
    }
    return null;
  }

  function detectCarrierFromRaw(raw) {
    const s = String(raw || "").trim();
    if (!s) return null;
    const compact = normFlightIdent(s);
    const prefix = getFlightIdentPrefix(compact);
    const fromPrefix = detectCarrierFromPrefix(prefix);
    if (fromPrefix) return fromPrefix;
    const low = s.toLowerCase();
    if (/jet\s*blue|\bjbu\b|\bb6\b/.test(low)) return "jetblue";
    if (/west\s*jet|\bwja\b|\bwen\b|\bws\b/.test(low)) return "westjet";
    return null;
  }

  function isAllowedCarrierIdent(vn) {
    const id = normFlightIdent(vn);
    if (!id) return false;
    const split = splitIdentPrefixDigits(id);
    if (split && detectCarrierFromPrefix(split.prefix)) return true;
    const prefix = getFlightIdentPrefix(id);
    const vars = airlinePrefixVariants(prefix);
    if (CARRIER_PREFIXES_JB.some((p) => vars.includes(p) || id.startsWith(p))) {
      return true;
    }
    if (CARRIER_PREFIXES_WJ.some((p) => vars.includes(p) || id.startsWith(p))) {
      return true;
    }
    return false;
  }

  function isAllowedCarrierFlight(f) {
    const vuelo = typeof f === "string" ? f : f && f.vuelo;
    if (isAllowedCarrierIdent(vuelo)) return true;
    const al = String((typeof f === "object" && f && f.aerolinea) || "").toLowerCase();
    if (/jetblue|\bjbu\b|\bb6\b/.test(al)) return true;
    if (/westjet|\bwja\b|\bws\b|\bwen\b/.test(al)) return true;
    if (typeof f === "object" && f && f.destino) {
      return Boolean(detectCarrierFromRaw(f.vuelo || ""));
    }
    return false;
  }

  function isAllowedCarrierBoardRow(row) {
    if (!row || typeof row !== "object") return false;
    if (isAllowedCarrierIdent(row.vuelo)) return true;
    if (row.vueloLlegada && isAllowedCarrierIdent(row.vueloLlegada)) return true;
    return Boolean(detectCarrierFromRaw(row.vuelo || ""));
  }

  function extractVueloSearchNeedles(raw) {
    const s = String(raw || "").trim();
    if (!s) return [];
    const out = new Set();
    out.add(s.toLowerCase());
    const compactNoSpace = s.replace(/\s+/g, "");
    if (compactNoSpace) out.add(compactNoSpace.toLowerCase());
    const upperCompact = s.toUpperCase().replace(/\s+/g, "");
    if (upperCompact) out.add(upperCompact.toLowerCase());
    s.split("/").forEach((p) => {
      const c = p.replace(/\s+/g, "").toLowerCase();
      if (c) out.add(c);
      const d = p.replace(/\D/g, "");
      if (d.length >= 2) out.add(d);
    });
    (s.match(/\d+/g) || []).forEach((d) => out.add(d));
    return [...out];
  }

  function candidatesForPrefixAndNum(prefix, num) {
    return airlinePrefixVariants(prefix).map((p) => `${p}${num}`);
  }

  /**
   * Parsea vuelo del tablero: 1, 2 o 3 números con prefijo JB/WS.
   * Ej: B6 627 | B6 627/1528 | WS 2908/2909 | WS 2506/2507/2508
   */
  function splitIdentPrefixDigits(raw) {
    const id = normFlightIdent(raw);
    if (!id) return null;
    const sorted = [...ALL_PREFIXES].sort((a, b) => b.length - a.length);
    for (const p of sorted) {
      if (id.startsWith(p) && id.length > p.length) {
        const num = id.slice(p.length);
        if (/^\d+$/.test(num)) return { prefix: p, num };
      }
    }
    const m = id.match(/^([A-Z]{2,3})(\d+)$/);
    if (m) return { prefix: m[1], num: m[2] };
    return null;
  }

  function parseBoardVueloField(raw) {
    const s0 = String(raw || "").trim();
    const empty = {
      carrier: detectCarrierFromRaw(s0),
      legCount: 0,
      arrCandidates: [],
      depCandidates: [],
      midCandidates: [],
      allCandidates: [],
      fallbackNeedles: extractVueloSearchNeedles(s0)
    };
    if (!s0) return empty;

    const slashIdx = s0.indexOf("/");
    if (slashIdx === -1) {
      const digitsOnly = s0.replace(/\s+/g, "");
      if (/^\d{2,5}$/.test(digitsOnly)) {
        const cands = ALL_PREFIXES.map((p) => `${p}${digitsOnly}`);
        return {
          carrier: null,
          legCount: 1,
          arrCandidates: cands,
          depCandidates: [],
          midCandidates: [],
          allCandidates: cands,
          fallbackNeedles: [digitsOnly],
          digitSearch: digitsOnly
        };
      }
      const compact = normFlightIdent(s0);
      const split = splitIdentPrefixDigits(compact);
      if (split) {
        const cands = candidatesForPrefixAndNum(split.prefix, split.num);
        return {
          carrier: detectCarrierFromPrefix(split.prefix),
          legCount: 1,
          arrCandidates: cands,
          depCandidates: [],
          midCandidates: [],
          allCandidates: cands,
          fallbackNeedles: extractVueloSearchNeedles(s0)
        };
      }
      return { ...empty, legCount: 0 };
    }

    const segments = s0.split("/").map((x) => x.trim()).filter(Boolean);
    const first = segments[0];
    const lm = first.match(/^(.+?)\s+(\d+)\s*$/);
    if (!lm) return { ...empty, legCount: segments.length };

    const prefix = lm[1].replace(/\s+/g, "").toUpperCase();
    const nums = [lm[2]];
    for (let i = 1; i < segments.length; i++) {
      const seg = segments[i];
      const dm = seg.match(/^(\d+)\s*$/);
      if (dm) nums.push(dm[1]);
      else {
        const sm = seg.match(/^(.+?)\s+(\d+)\s*$/);
        if (sm) nums.push(sm[2]);
      }
    }

    const allCandidates = [];
    nums.forEach((n) => {
      candidatesForPrefixAndNum(prefix, n).forEach((c) => allCandidates.push(c));
    });

    const arrCandidates = candidatesForPrefixAndNum(prefix, nums[0]);
    const depCandidates =
      nums.length >= 2
        ? candidatesForPrefixAndNum(prefix, nums[nums.length - 1])
        : [];
    const midCandidates =
      nums.length >= 3
        ? nums
            .slice(1, -1)
            .flatMap((n) => candidatesForPrefixAndNum(prefix, n))
        : [];

    return {
      carrier: detectCarrierFromPrefix(prefix),
      legCount: nums.length,
      arrCandidates,
      depCandidates,
      midCandidates,
      allCandidates,
      fallbackNeedles: extractVueloSearchNeedles(s0)
    };
  }

  function flightRowMatchesApiIdent(apiVuelo, candidates) {
    const fn = normFlightIdent(apiVuelo);
    if (!fn) return false;
    return (candidates || []).some((c) => {
      const cn = normFlightIdent(c);
      if (!cn) return false;
      if (fn === cn || fn.includes(cn) || cn.includes(fn)) return true;
      const dn = getFlightIdentDigits(fn);
      const dt = getFlightIdentDigits(cn);
      if (dn && dt && dn === dt) {
        const ln = fn.slice(0, fn.length - dn.length);
        const lt = cn.slice(0, cn.length - dt.length);
        if (!ln || !lt) return true;
        if (ln.includes(lt) || lt.includes(ln)) return true;
        const vLn = airlinePrefixVariants(ln);
        const vLt = airlinePrefixVariants(lt);
        if (vLn.some((v) => vLt.includes(v))) return true;
      }
      return false;
    });
  }

  function arrivalMinutesFromRow(row) {
    const raw =
      (row && (row.llegada || row.llegadaEstimada || row.llegadaProgramada)) ||
      "";
    const m = String(raw).trim().match(/^(\d{1,2}):(\d{2})/);
    if (!m) return 99999;
    return parseInt(m[1], 10) * 60 + parseInt(m[2], 10);
  }

  function sortFlightsByArrival(list) {
    return [...(list || [])].sort(
      (a, b) => arrivalMinutesFromRow(a) - arrivalMinutesFromRow(b)
    );
  }

  function restrictToAllowedCarriers(list) {
    return sortFlightsByArrival((list || []).filter(isAllowedCarrierFlight));
  }

  function filterCarrierFlightsByQuery(flights, query, legMode) {
    const raw = String(query || "").trim();
    if (!raw) return [];
    const list = restrictToAllowedCarriers(flights);
    if (!list.length) return [];

    const prefixFilter = (() => {
      const s = raw.toUpperCase().replace(/\s+/g, "");
      if (/^(B6|JBU|WS|WJA|WEN)$/.test(s)) return airlinePrefixVariants(s);
      return null;
    })();

    if (prefixFilter) {
      return list.filter((f) => {
        const p = getFlightIdentPrefix(f.vuelo);
        const vars = airlinePrefixVariants(p);
        return prefixFilter.some((pf) => vars.includes(pf) || normFlightIdent(f.vuelo).startsWith(pf));
      });
    }

    const parsed = parseBoardVueloField(raw);

    if (legMode === "arr" && parsed.arrCandidates.length) {
      const hits = list.filter((f) =>
        flightRowMatchesApiIdent(f.vuelo, parsed.arrCandidates)
      );
      if (hits.length) return hits;
    }
    if (legMode === "dep" && parsed.depCandidates.length) {
      const hits = list.filter((f) =>
        flightRowMatchesApiIdent(f.vuelo, parsed.depCandidates)
      );
      if (hits.length) return hits;
    }
    if (!legMode && parsed.allCandidates.length) {
      const hits = list.filter((f) =>
        flightRowMatchesApiIdent(f.vuelo, parsed.allCandidates)
      );
      if (hits.length) return hits;
    }

    if (parsed.digitSearch) {
      const hits = list.filter(
        (f) => getFlightIdentDigits(f.vuelo) === parsed.digitSearch
      );
      if (hits.length) return hits;
    }
    if (parsed.allCandidates.length) {
      const hits = list.filter((f) =>
        flightRowMatchesApiIdent(f.vuelo, parsed.allCandidates)
      );
      if (hits.length) return hits;
    }

    const fallbackNeedles = parsed.fallbackNeedles;
    if (fallbackNeedles.length) {
      const hits = list.filter((f) => {
        const fv = normFlightIdent(f.vuelo);
        const fd = getFlightIdentDigits(f.vuelo);
        return fallbackNeedles.some((n) => {
          if (!n) return false;
          const nn = String(n).toLowerCase();
          if (/^\d+$/.test(nn) && fd === nn) return true;
          return fv.toLowerCase().includes(nn);
        });
      });
      if (hits.length) return hits;
    }

    const q = normFlightIdent(raw).toLowerCase();
    if (!q) return [];
    return list.filter((f) => normFlightIdent(f.vuelo).toLowerCase().includes(q));
  }

  function carrierLabel(carrier) {
    if (carrier === "jetblue") return "JetBlue";
    if (carrier === "westjet") return "WestJet";
    return "";
  }

  function inferBoardVueloLabel(raw, arrApi, depApi) {
    const s = String(raw || "").trim();
    const parsed = parseBoardVueloField(s);
    const carrier = parsed.carrier || detectCarrierFromRaw(s);
    if (parsed.legCount >= 2 && s.includes("/")) {
      const segments = s.split("/").map((x) => x.trim()).filter(Boolean);
      const fm = segments[0].match(/^(.+?)\s+(\d+)\s*$/);
      if (fm) {
        const prefix =
          carrier === "westjet" ? "WS" : carrier === "jetblue" ? "B6" : fm[1].trim();
        const nums = [
          fm[2],
          ...segments.slice(1).map((seg) => {
            const dm = seg.match(/^(\d+)\s*$/);
            return dm ? dm[1] : getFlightIdentDigits(seg) || seg;
          })
        ];
        return `${prefix} ${nums.join("/")}`;
      }
    }
    if (arrApi && arrApi.vuelo) return String(arrApi.vuelo);
    return s;
  }

  return {
    CARRIER_PREFIXES_JB,
    CARRIER_PREFIXES_WJ,
    normFlightIdent,
    airlinePrefixVariants,
    getFlightIdentPrefix,
    getFlightIdentDigits,
    detectCarrierFromPrefix,
    detectCarrierFromRaw,
    isAllowedCarrierIdent,
    isAllowedCarrierFlight,
    isAllowedCarrierBoardRow,
    extractVueloSearchNeedles,
    parseBoardVueloField,
    flightRowMatchesApiIdent,
    arrivalMinutesFromRow,
    sortFlightsByArrival,
    restrictToAllowedCarriers,
    filterCarrierFlightsByQuery,
    carrierLabel,
    inferBoardVueloLabel
  };
});
