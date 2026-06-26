/**
 * Información de vuelo — PAX llegando / PAX saliendo (panel + tablero TV).
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) {
    module.exports = api;
  }
  if (root) {
    root.FlightInfoUtils = api;
  }
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  /** Mismas rutas que el desplegable «Ruta frecuente» en Vuelos. */
  const FLIGHT_INFO_PRESETS = [
    { vuelo: "B6 627/1528", destino: "JFK-JFK (New York)" },
    { vuelo: "WS 2740/2741", destino: "YYZ-YYZ (Toronto)" },
    { vuelo: "WS 2506/2507", destino: "YYZ-YYZ (Toronto)" },
    { vuelo: "WS 2908/2909", destino: "YUL-YUL (Montréal)" }
  ];

  const PAX_IN_FIELDS = [
    { key: "pax", label: "Total PAX", wide: true, dynamicLabel: true },
    { key: "bags", label: "Bags" },
    { key: "wchr", label: "WCHR" },
    { key: "chd", label: "CHD" },
    { key: "inf", label: "INF" },
    { key: "ssss", label: "SSSS" },
    { key: "blind", label: "BLIND" },
    { key: "alerg", label: "ALERG" },
    { key: "petc", label: "PETC" },
    { key: "avih", label: "AVIH" },
    { key: "mosaic", label: "MOSAIC" }
  ];

  const PAX_OUT_FIELDS = [
    { key: "pax", label: "Total PAX", wide: true, dynamicLabel: true },
    { key: "bags", label: "Bags" },
    { key: "wchr", label: "WCHR" },
    { key: "chd", label: "CHD" },
    { key: "inf", label: "INF" },
    { key: "ssss", label: "SSSS" },
    { key: "nogo", label: "NOGO" },
    { key: "blind", label: "BLIND" },
    { key: "alerg", label: "ALERG" },
    { key: "petc", label: "PETC" },
    { key: "avih", label: "AVIH" }
  ];

  function normalizePrefixDisplay(prefixRaw) {
    const p = String(prefixRaw || "")
      .trim()
      .toUpperCase()
      .replace(/\s+/g, "");
    if (p === "JBU" || p === "B6") return "B6";
    if (p === "WJA" || p === "WEN" || p === "WS") return "WS";
    return p;
  }

  function buildRouteLegMeta(vueloRoute) {
    const route = String(vueloRoute || "").trim();
    const base = {
      route,
      vueloLlegada: route,
      vueloSalida: route,
      destino: "",
      titleLlegada: "Vuelo llegando · PAX",
      titleSalida: "Vuelo saliendo · PAX",
      labelPaxLlegada: "Total PAX llegando",
      labelPaxSalida: "Total PAX saliendo",
      subtitleLlegada: "Llegada a POP",
      subtitleSalida: "Salida de POP"
    };
    if (!route) return base;

    const slash = route.indexOf("/");
    if (slash === -1) {
      return {
        ...base,
        vueloLlegada: route,
        vueloSalida: route,
        titleLlegada: `Vuelo ${route} · PAX llegando`,
        titleSalida: `Vuelo ${route} · PAX saliendo`,
        labelPaxLlegada: `Total PAX · ${route}`,
        labelPaxSalida: `Total PAX · ${route}`
      };
    }

    const segments = route.split("/").map((x) => x.trim()).filter(Boolean);
    const first = segments[0];
    const lm = first.match(/^(.+?)\s+(\d+)\s*$/);
    if (!lm) return base;

    const prefixDisplay = normalizePrefixDisplay(lm[1]);
    const nums = [lm[2]];
    for (let i = 1; i < segments.length; i++) {
      const dm = segments[i].match(/^(\d+)$/);
      if (dm) nums.push(dm[1]);
      else {
        const sm = segments[i].match(/^(.+?)\s+(\d+)\s*$/);
        if (sm) nums.push(sm[2]);
      }
    }

    const vueloLlegada = `${prefixDisplay} ${nums[0]}`;
    const vueloSalida = `${prefixDisplay} ${nums[nums.length - 1]}`;

    return {
      ...base,
      vueloLlegada,
      vueloSalida,
      titleLlegada: `Vuelo ${vueloLlegada} · PAX llegando`,
      titleSalida: `Vuelo ${vueloSalida} · PAX saliendo`,
      labelPaxLlegada: `Total PAX · ${vueloLlegada}`,
      labelPaxSalida: `Total PAX · ${vueloSalida}`,
      subtitleLlegada: `Llegada ${vueloLlegada} a POP`,
      subtitleSalida: `Salida ${vueloSalida} de POP`
    };
  }

  function routeKey(vueloRoute) {
    return String(vueloRoute || "")
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "");
  }

  function presetByKey(key) {
    return FLIGHT_INFO_PRESETS.find((p) => routeKey(p.vuelo) === key) || null;
  }

  function carrierThemeFromRoute(vueloRoute) {
    const v = String(vueloRoute || "").toUpperCase();
    if (/\b(B6|JBU)\b/.test(v) || v.startsWith("B6") || v.startsWith("JBU")) {
      return "jetblue";
    }
    if (/\b(WS|WJA|WEN)\b/.test(v) || v.startsWith("WS") || v.startsWith("WJA")) {
      return "westjet";
    }
    return "extra";
  }

  function emptySection(fields) {
    const o = {};
    fields.forEach((f) => {
      o[f.key] = "";
    });
    return o;
  }

  function emptyRecord(preset) {
    const rec = {
      vuelo: preset?.vuelo || "",
      destino: preset?.destino || "",
      paxIn: emptySection(PAX_IN_FIELDS),
      paxOut: emptySection(PAX_OUT_FIELDS),
      updatedAt: ""
    };
    if (preset?.vuelo) {
      const legs = buildRouteLegMeta(preset.vuelo);
      rec.vueloLlegada = legs.vueloLlegada;
      rec.vueloSalida = legs.vueloSalida;
    }
    return rec;
  }

  function normalizeRecord(raw) {
    const vuelo = String(raw?.vuelo || "").trim();
    const preset = FLIGHT_INFO_PRESETS.find((p) => p.vuelo === vuelo);
    const base = emptyRecord(preset || (vuelo ? { vuelo, destino: raw?.destino || "" } : null));
    if (!raw || typeof raw !== "object") return base;

    base.vuelo = vuelo || base.vuelo;
    base.destino = String(raw.destino || base.destino || "").trim();
    const legs = buildRouteLegMeta(base.vuelo);
    base.vueloLlegada = String(raw.vueloLlegada || legs.vueloLlegada || "").trim();
    base.vueloSalida = String(raw.vueloSalida || legs.vueloSalida || "").trim();

    PAX_IN_FIELDS.forEach((f) => {
      if (raw.paxIn && raw.paxIn[f.key] != null && raw.paxIn[f.key] !== "") {
        base.paxIn[f.key] = String(raw.paxIn[f.key]).trim();
      }
    });
    PAX_OUT_FIELDS.forEach((f) => {
      if (raw.paxOut && raw.paxOut[f.key] != null && raw.paxOut[f.key] !== "") {
        base.paxOut[f.key] = String(raw.paxOut[f.key]).trim();
      }
    });
    base.updatedAt = raw.updatedAt || "";
    return base;
  }

  function sectionHasData(section, fields) {
    if (!section || typeof section !== "object") return false;
    return fields.some((f) => String(section[f.key] || "").trim() !== "");
  }

  function recordHasData(record) {
    const r = normalizeRecord(record);
    return (
      sectionHasData(r.paxIn, PAX_IN_FIELDS) ||
      sectionHasData(r.paxOut, PAX_OUT_FIELDS)
    );
  }

  function fieldHasValue(section, key) {
    return String(section && section[key] != null ? section[key] : "").trim() !== "";
  }

  function sectionHasDisplayData(section, fields) {
    if (!section || typeof section !== "object") return false;
    return fields.some((f) => fieldHasValue(section, f.key));
  }

  function displayVal(v) {
    const s = String(v ?? "").trim();
    return s === "" ? "—" : s;
  }

  function themeMeta(theme) {
    if (theme === "jetblue") {
      return { badge: "🔵 JETBLUE", themeClass: "fi-slide--jetblue" };
    }
    if (theme === "westjet") {
      return { badge: "🟢 WESTJET", themeClass: "fi-slide--westjet" };
    }
    return { badge: "✈️ VUELO", themeClass: "fi-slide--extra" };
  }

  function fieldLabel(f, legMeta, section) {
    if (f.dynamicLabel && f.key === "pax") {
      return section === "in" ? legMeta.labelPaxLlegada : legMeta.labelPaxSalida;
    }
    return f.label;
  }

  function renderSectionRows(section, fields, legMeta, sectionId, escapeHtml) {
    const esc = escapeHtml || ((s) => String(s ?? ""));
    return fields
      .filter((f) => fieldHasValue(section, f.key))
      .map((f) => {
        const val = displayVal(section && section[f.key]);
        const cls = f.wide ? " fi-stat--wide" : "";
        return `<div class="fi-stat${cls}">
          <span class="fi-stat__label">${esc(fieldLabel(f, legMeta, sectionId))}</span>
          <span class="fi-stat__value">${esc(val)}</span>
        </div>`;
      })
      .join("");
  }

  function renderPanelSection(section, fields, legMeta, sectionId, panelClass, escapeHtml) {
    const esc = escapeHtml || ((s) => String(s ?? ""));
    if (!sectionHasDisplayData(section, fields)) return "";
    const rows = renderSectionRows(section, fields, legMeta, sectionId, esc);
    if (!rows) return "";
    const title = sectionId === "in" ? legMeta.titleLlegada : legMeta.titleSalida;
    const sub = sectionId === "in" ? legMeta.subtitleLlegada : legMeta.subtitleSalida;
    return `
          <section class="fi-panel ${panelClass}">
            <h2 class="fi-panel__title">${esc(title)}</h2>
            <p class="fi-panel__sub">${esc(sub)}</p>
            <div class="fi-stats">${rows}</div>
          </section>`;
  }

  function renderSlideHtml(slide, escapeHtml) {
    const esc = escapeHtml || ((s) => String(s ?? ""));
    const rec = normalizeRecord(slide.record);
    const legMeta = slide.legMeta || buildRouteLegMeta(rec.vuelo || slide.vuelo);
    const inPanel = renderPanelSection(rec.paxIn, PAX_IN_FIELDS, legMeta, "in", "fi-panel--in", esc);
    const outPanel = renderPanelSection(rec.paxOut, PAX_OUT_FIELDS, legMeta, "out", "fi-panel--out", esc);
    return `
      <div class="fi-slide ${esc(slide.themeClass || "")}">
        <div class="fi-slide-bg"></div>
        <header class="fi-slide-header">
          <span class="fi-slide-badge">${esc(slide.badge || "")}</span>
          <h1 class="fi-slide-title">${esc(slide.title || "INFORMACIÓN DE VUELO")}</h1>
          ${slide.destino ? `<p class="fi-slide-destino">${esc(slide.destino)}</p>` : ""}
          <div class="fi-slide-line"></div>
        </header>
        <div class="fi-slide-body">
          ${inPanel}${outPanel}
        </div>
        <footer class="fi-slide-footer">LONGPORT · AEROPUERTO PUERTO PLATA</footer>
      </div>`;
  }

  function buildSlideFromPreset(preset, record, opts) {
    const o = opts || {};
    const legs = buildRouteLegMeta(preset.vuelo);
    const theme = carrierThemeFromRoute(preset.vuelo);
    const meta = themeMeta(theme);
    const key = routeKey(preset.vuelo);
    const titleKey = "flightInfo_" + key;
    const customTitle = o.titles && o.titles[titleKey];
    const defaultTitle = `${legs.vueloLlegada} / ${legs.vueloSalida}`;
    return {
      id: key,
      vuelo: preset.vuelo,
      destino: preset.destino,
      legMeta: legs,
      themeClass: meta.themeClass,
      badge: meta.badge,
      title: customTitle || defaultTitle,
      duration: o.duration || 15,
      record: normalizeRecord({ ...record, vuelo: preset.vuelo, destino: preset.destino }),
      durKey: key
    };
  }

  return {
    FLIGHT_INFO_PRESETS,
    PAX_IN_FIELDS,
    PAX_OUT_FIELDS,
    buildRouteLegMeta,
    routeKey,
    presetByKey,
    carrierThemeFromRoute,
    emptyRecord,
    normalizeRecord,
    sectionHasData,
    sectionHasDisplayData,
    fieldHasValue,
    recordHasData,
    displayVal,
    themeMeta,
    fieldLabel,
    renderSlideHtml,
    buildSlideFromPreset
  };
});
