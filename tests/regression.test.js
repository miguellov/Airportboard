const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const test = require("node:test");

const panelHtml = readFileSync("panel.html", "utf8");
const serverJs = readFileSync("server.js", "utf8");

test("panel uses the Santo Domingo calendar for today's flight board date", () => {
  assert.match(
    panelHtml,
    /function dateTodayInPop\(\)\{\s*return new Date\(\)\.toLocaleDateString\("en-CA", \{ timeZone: "America\/Santo_Domingo" \}\);\s*\}/
  );
  assert.match(panelHtml, /let selectedDate = dateTodayInPop\(\);/);
  assert.match(
    panelHtml,
    /window\.goToTodayFlights = \(\) => \{\s*const today = dateTodayInPop\(\);\s*changeDateFlights\(today\);\s*\};/
  );
  assert.doesNotMatch(
    panelHtml,
    /selectedDate = new Date\(\)\.toISOString\(\)\.slice\(0, 10\)/
  );
});

test("FlightAware-linked arrivals clear manual noApiSync pause flags", () => {
  assert.match(
    panelHtml,
    /function enableFlightAwareLiveSync\(row\)\{\s*if\(!row \|\| typeof row !== "object"\) return;\s*row\.manual = false;\s*row\.noApiSync = false;\s*delete row\.apiSyncPausedAt;\s*\}/
  );
  assert.match(
    panelHtml,
    /if \(arr\) \{[\s\S]*enableFlightAwareLiveSync\(rows\[index\]\);[\s\S]*\}\s*if \(dep\) \{/m
  );
  assert.match(
    panelHtml,
    /window\.seleccionarLlegadaApi = \(index, el\) => \{[\s\S]*enableFlightAwareLiveSync\(arr\[index\]\);[\s\S]*saveFlightsForSelectedDate\(toObj\(arr\)\);/m
  );
});

test("server recovers stale linked rows without resuming auto-paused terminal rows", () => {
  assert.match(
    serverJs,
    /function isApiSyncPausedForRow\(row\) \{\s*if \(!row \|\| typeof row !== "object" \|\| row\.noApiSync !== true\) return false;\s*return !\(row\.manual === false && !row\.apiSyncPausedAt\);\s*\}/
  );
  assert.match(serverJs, /if \(isApiSyncPausedForRow\(row\)\) return false;/);
  assert.match(serverJs, /if \(isApiSyncPausedForRow\(row\)\) continue;/);
  assert.doesNotMatch(serverJs, /if \(row\.noApiSync === true\) continue;/);
});

test("bootstrap panel user does not overwrite an existing password hash", () => {
  const ensureStart = serverJs.indexOf("async function ensureBootstrapPanelUser()");
  const loginStart = serverJs.indexOf("function requirePanelAuth", ensureStart);
  assert.notEqual(ensureStart, -1);
  assert.notEqual(loginStart, -1);
  const ensureBootstrap = serverJs.slice(ensureStart, loginStart);

  const existingStart = ensureBootstrap.indexOf("if (existing) {");
  const createStart = ensureBootstrap.indexOf("const keyCreated = await createPanelUser");
  assert.notEqual(existingStart, -1);
  assert.notEqual(createStart, -1);
  const existingBlock = ensureBootstrap.slice(existingStart, createStart);

  assert.doesNotMatch(existingBlock, /salt\s*:/);
  assert.doesNotMatch(existingBlock, /hash\s*:/);
  assert.match(ensureBootstrap, /const keyCreated = await createPanelUser\(/);
});
