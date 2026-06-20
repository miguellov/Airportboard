(function () {
  function isMobileBrowser() {
    return /Android|iPhone|iPad|iPod|Mobile|SamsungBrowser/i.test(
      navigator.userAgent || ""
    );
  }

  function isSamsungGalaxyA36() {
    var ua = navigator.userAgent || "";
    return /SM-A366/i.test(ua) || (/Samsung/i.test(ua) && window.innerWidth <= 430);
  }

  function isNativeAppContext() {
    try {
      var q = new URLSearchParams(location.search);
      if (q.get("app") === "1" || q.get("mobile") === "1") return true;
    } catch (_) {}
    var ua = navigator.userAgent || "";
    if (ua.indexOf("POPFIDSPanel") !== -1) return true;
    if (isMobileBrowser() && window.innerWidth < 960) return true;
    return false;
  }

  if (!isNativeAppContext()) return;

  document.documentElement.classList.add("panel-native-root");
  if (isSamsungGalaxyA36()) {
    document.documentElement.classList.add("panel-galaxy-a36");
  }

  var NAV_ITEMS = [
    { tab: "flightsTab", icon: "🛫", label: "Vuelos" },
    { tab: "positionsTab", icon: "👨‍✈️", label: "Posiciones" },
    { tab: "anunciosTab", icon: "📢", label: "Anuncios" },
    { tab: "configTab", icon: "⚙️", label: "Ajustes" }
  ];

  var CONFIG_NAV = [
    { id: "tv", icon: "📺", label: "TV" },
    { id: "general", icon: "⚙️", label: "General" },
    { id: "empleados", icon: "👥", label: "Equipo" },
    { id: "users", icon: "🔐", label: "Usuarios" }
  ];

  function scrollPanelTop() {
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

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

  function getActiveConfigSectionId() {
    var el = document.querySelector(
      ".config-section.is-active[data-config-section]"
    );
    return el ? el.getAttribute("data-config-section") : "tv";
  }

  function syncMobileConfigNav(sectionId) {
    var nav = document.getElementById("panelMobileConfigNav");
    if (!nav) return;
    nav.querySelectorAll("[data-config-section]").forEach(function (btn) {
      var id = btn.getAttribute("data-config-section");
      var hidden = btn.hasAttribute("hidden");
      btn.classList.toggle("is-active", !hidden && id === sectionId);
    });
  }

  function buildMobileConfigNav() {
    if (document.getElementById("panelMobileConfigNav")) return;
    var configTab = document.getElementById("configTab");
    if (!configTab) return;
    var head = configTab.querySelector(".config-page-head");
    if (!head) return;

    var nav = document.createElement("div");
    nav.id = "panelMobileConfigNav";
    nav.className = "panel-mobile-config-nav";
    nav.setAttribute("role", "tablist");
    nav.setAttribute("aria-label", "Secciones de configuración");

    CONFIG_NAV.forEach(function (item) {
      var btn = document.createElement("button");
      btn.type = "button";
      btn.className = "panel-mobile-config-nav__btn";
      btn.setAttribute("data-config-section", item.id);
      btn.setAttribute("role", "tab");
      if (item.id === "users") {
        var usersMenu = document.getElementById("configMenuUsers");
        if (usersMenu && usersMenu.hidden) btn.hidden = true;
      }
      btn.innerHTML =
        '<span class="panel-mobile-config-nav__icon" aria-hidden="true">' +
        item.icon +
        '</span><span class="panel-mobile-config-nav__label">' +
        item.label +
        "</span>";
      btn.addEventListener("click", function () {
        if (typeof window.showConfigSection === "function") {
          window.showConfigSection(item.id);
        }
      });
      nav.appendChild(btn);
    });

    head.insertAdjacentElement("afterend", nav);
    syncMobileConfigNav("tv");
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
        if (item.tab === "configTab") {
          if (typeof window.showConfigSection === "function") {
            window.showConfigSection("tv");
          } else if (typeof window.showTab === "function") {
            window.showTab("configTab");
          }
        } else if (typeof window.showTab === "function") {
          window.showTab(item.tab);
        }
        scrollPanelTop();
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

  function patchPanelHooks() {
    if (typeof window.showTab === "function" && !window.__panelNativeShowTab) {
      var origShowTab = window.showTab;
      window.showTab = function (tab) {
        origShowTab(tab);
        syncBottomNav(tab);
        if (tab === "configTab") syncMobileConfigNav(getActiveConfigSectionId());
        scrollPanelTop();
      };
      window.__panelNativeShowTab = true;
    }

    if (typeof window.showConfigSection === "function" && !window.__panelNativeConfig) {
      var origConfig = window.showConfigSection;
      window.showConfigSection = function (sectionId) {
        origConfig(sectionId);
        syncMobileConfigNav(sectionId);
        scrollPanelTop();
      };
      window.__panelNativeConfig = true;
    }

    if (typeof window.unlockPanelApp === "function" && !window.__panelNativeUnlock) {
      var origUnlock = window.unlockPanelApp;
      window.unlockPanelApp = function (user) {
        origUnlock(user);
        var nav = document.getElementById("panelBottomNav");
        var fab = document.getElementById("panelFabAdd");
        if (nav) nav.hidden = false;
        if (fab) fab.hidden = false;
        buildMobileConfigNav();
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

    if (typeof window.toggleConfigMenu === "function" && !window.__panelNativeMenu) {
      var origMenu = window.toggleConfigMenu;
      window.toggleConfigMenu = function () {
        origMenu();
        document.body.classList.toggle(
          "panel-config-drawer-open",
          document.getElementById("configMenuDrawer") &&
            !document.getElementById("configMenuDrawer").hidden
        );
      };
      window.__panelNativeMenu = true;
    }

    if (typeof window.closeConfigMenu === "function" && !window.__panelNativeCloseMenu) {
      var origClose = window.closeConfigMenu;
      window.closeConfigMenu = function () {
        origClose();
        document.body.classList.remove("panel-config-drawer-open");
      };
      window.__panelNativeCloseMenu = true;
    }
  }

  function observeUsersMenuVisibility() {
    var usersMenu = document.getElementById("configMenuUsers");
    var mobileUsers = document.querySelector(
      '#panelMobileConfigNav [data-config-section="users"]'
    );
    if (!usersMenu || !mobileUsers) return;
    var obs = new MutationObserver(function () {
      mobileUsers.hidden = usersMenu.hidden;
    });
    obs.observe(usersMenu, { attributes: true, attributeFilter: ["hidden"] });
  }

  function enableNativeAppUi() {
    document.body.classList.add("panel-native-app");
    buildNativeChrome();
    setupMobileTicker();
    buildMobileConfigNav();
    patchPanelHooks();
    observeUsersMenuVisibility();

    var nav = document.getElementById("panelBottomNav");
    var fab = document.getElementById("panelFabAdd");
    if (nav) nav.hidden = false;
    if (fab) fab.hidden = false;
    syncBottomNav(document.body.dataset.activeTab || "flightsTab");

    window.addEventListener("orientationchange", function () {
      setTimeout(function () {
        if (typeof window.fitBoardPreview === "function") window.fitBoardPreview();
      }, 120);
    });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", enableNativeAppUi);
  } else {
    enableNativeAppUi();
  }
})();
