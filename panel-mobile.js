(function () {
  function isNativeAppContext() {
    try {
      var q = new URLSearchParams(location.search);
      if (q.get("app") === "1" || q.get("mobile") === "1") return true;
    } catch (_) {}
    var ua = navigator.userAgent || "";
    return ua.indexOf("POPFIDSPanel") !== -1;
  }

  if (!isNativeAppContext()) return;

  document.documentElement.classList.add("panel-native-root");

  var NAV_ITEMS = [
    { tab: "flightsTab", icon: "🛫", label: "Vuelos" },
    { tab: "positionsTab", icon: "👨‍✈️", label: "Posiciones" },
    { tab: "anunciosTab", icon: "📢", label: "Anuncios" },
    { tab: "configTab", icon: "⚙️", label: "Ajustes" }
  ];

  function syncBottomNav(activeTab) {
    document.body.setAttribute("data-active-tab", activeTab || "flightsTab");
    var nav = document.getElementById("panelBottomNav");
    if (!nav) return;
    nav.querySelectorAll("[data-tab]").forEach(function (btn) {
      btn.classList.toggle(
        "is-active",
        btn.getAttribute("data-tab") === activeTab
      );
    });
  }

  function buildNativeChrome() {
    if (document.getElementById("panelBottomNav")) return;

    var nav = document.createElement("nav");
    nav.id = "panelBottomNav";
    nav.className = "panel-bottom-nav";
    nav.setAttribute("aria-label", "Menú principal");
    nav.hidden = true;

    NAV_ITEMS.forEach(function (item) {
      var btn = document.createElement("button");
      btn.type = "button";
      btn.className = "panel-bottom-nav__btn";
      btn.setAttribute("data-tab", item.tab);
      btn.innerHTML =
        '<span class="panel-bottom-nav__icon" aria-hidden="true">' +
        item.icon +
        '</span><span class="panel-bottom-nav__label">' +
        item.label +
        "</span>";
      btn.addEventListener("click", function () {
        if (typeof window.showTab === "function") window.showTab(item.tab);
      });
      nav.appendChild(btn);
    });

    var fab = document.createElement("button");
    fab.type = "button";
    fab.id = "panelFabAdd";
    fab.className = "panel-fab";
    fab.hidden = true;
    fab.setAttribute("aria-label", "Agregar vuelo");
    fab.textContent = "+";
    fab.addEventListener("click", function () {
      if (typeof window.addFlight === "function") window.addFlight();
    });

    document.body.appendChild(nav);
    document.body.appendChild(fab);
  }

  function enableNativeAppUi() {
    document.body.classList.add("panel-native-app");
    buildNativeChrome();
    var nav = document.getElementById("panelBottomNav");
    var fab = document.getElementById("panelFabAdd");
    if (nav) nav.hidden = false;
    if (fab) fab.hidden = false;
    syncBottomNav("flightsTab");

    if (typeof window.showTab === "function" && !window.__panelNativeShowTab) {
      var orig = window.showTab;
      window.showTab = function (tab) {
        orig(tab);
        syncBottomNav(tab);
      };
      window.__panelNativeShowTab = true;
    }

    if (typeof window.unlockPanelApp === "function" && !window.__panelNativeUnlock) {
      var origUnlock = window.unlockPanelApp;
      window.unlockPanelApp = function (user) {
        origUnlock(user);
        var nav = document.getElementById("panelBottomNav");
        var fab = document.getElementById("panelFabAdd");
        if (nav) nav.hidden = false;
        if (fab) fab.hidden = false;
      };
      window.__panelNativeUnlock = true;
    }

    if (typeof window.lockPanelApp === "function" && !window.__panelNativeLock) {
      var origLock = window.lockPanelApp;
      window.lockPanelApp = function () {
        origLock();
        var nav = document.getElementById("panelBottomNav");
        var fab = document.getElementById("panelFabAdd");
        if (nav) nav.hidden = true;
        if (fab) fab.hidden = true;
      };
      window.__panelNativeLock = true;
    }
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", enableNativeAppUi);
  } else {
    enableNativeAppUi();
  }
})();
