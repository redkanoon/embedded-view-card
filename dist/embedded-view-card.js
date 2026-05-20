// Embedded View Card for Home Assistant
// Allows embedding another view into a card

import { VERSION } from "./version.js";
import { t as i18n } from "./i18n/index.js";


// ── Shared utilities (used by both card and editor) ──────────────────────────

function _getHuiRoot() {
  return document
    .querySelector("home-assistant")?.shadowRoot
    ?.querySelector("home-assistant-main")?.shadowRoot
    ?.querySelector("ha-panel-lovelace")?.shadowRoot
    ?.querySelector("hui-root");
}

function _isViewVisibleToUser(view, hass) {
  const uid = hass?.user?.id || null;
  if (!uid || !view) return true;

  const raw =
    (Array.isArray(view.visible) && view.visible.length ? view.visible : null) ||
    (Array.isArray(view.visibility) && view.visibility.length ? view.visibility : null) ||
    (Array.isArray(view.users) && view.users.length ? view.users : null);

  if (!raw) return true;

  for (const r of raw) {
    if (typeof r === "string" && r === uid) return true;
    if (r && typeof r === "object") {
      if (typeof r.user === "string" && r.user === uid) return true;
      if (Array.isArray(r.user) && r.user.includes(uid)) return true;
      if (Array.isArray(r.users) && r.users.includes(uid)) return true;
    }
  }

  return false;
}

function _escapeHtml(str) {
  if (typeof str !== "string") return String(str ?? "");
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

// parse a combined "dashboard/view" string into { dashboard, view }.
// accepts: "dashboard/view", "/dashboard/view", "current/view", "view", "/view"
function _parseDashboardViewString(value, currentDashboard) {
  if (typeof value !== "string") return null;
  const parts = value.trim().replace(/^\//, "").split("/").filter(Boolean);
  if (parts.length === 0) return null;
  if (parts.length === 1) return { dashboard: currentDashboard, view: parts[0] };
  if (parts.length === 2) {
    const [dash, view] = parts;
    return { dashboard: dash === "current" ? currentDashboard : dash, view };
  }
  return null;
}

class EmbeddedViewCard extends HTMLElement {

  // initializes the card instance, sets up shadow DOM and internal containers
  constructor() {
    super();
    this.attachShadow({ mode: "open" }); // enable shadow DOM
    
    // initialize properties
    this._hass = undefined;
    this._config = {};
    this._activeViewElement = null;

    // initialize caches
    this._resolved = { view: undefined, dashboard: undefined, hash: undefined };
    this._waitingForRoot = false;
    this._wsConfigCache = {};
    this._waitForTimers = new Set();

    // initialize DOM elements
    this._container = document.createElement("div");
    this._container.style.display = "contents";
    this._inner = document.createElement("div");
    this._inner.style.margin = "0";

    // hash mode handler
    this._onHashChange = this._onHashChange.bind(this);

    // hash mode view cache
    this._hashViews = {};
  }


  connectedCallback() {
    window.addEventListener("hashchange", this._onHashChange);
    window.addEventListener("popstate", this._onHashChange);
  }

  disconnectedCallback() {
    window.removeEventListener("hashchange", this._onHashChange);
    window.removeEventListener("popstate", this._onHashChange);
    for (const id of this._waitForTimers) clearTimeout(id);
    this._waitForTimers.clear();
  }

  _onHashChange() {
    if (this._config.mode === "hash") {
      this._resolved.hash = undefined;
      this.hass = this._hass;
    }
  }


  // applies user configuration, sets defaults, and builds the initial DOM structure
  setConfig(config) {
    this._config = {
      mode: "static",               // mode: static, dynamic, or hash

      // static mode
      dashboard: undefined,         // dashboard  (empty or undefined => current)
      view: undefined,              // view
      view_path: undefined,         // legacy fallback (read-only)

      // dynamic mode
      target_entity: undefined,     // entity whose state is "dashboard/view"
      view_path_entity: undefined,  // legacy fallback (read-only)

      // hash mode
      default: undefined,           // fallback hash value
      states: {},                   // map of hash -> { dashboard, view }

      // style
      ha_card: true,
      bleed: false,
      bleed_inline: 16,
      bleed_block: 8,
      ...config,
    };

    // migrate legacy 'view_path_entity' -> dynamic mode on runtime, once
    if (this._config.view_path_entity && !this._config.target_entity) {
      this._config.mode = "dynamic";
      this._config.target_entity = this._config.view_path_entity;
      delete this._config.view_path_entity;
      // drop static-only fields to avoid ambiguous state
      delete this._config.view;
      delete this._config.view_path;
      delete this._config.dashboard;
    }

    // initialize DOM elements
    this.shadowRoot.innerHTML = "";
    this._container.innerHTML = "";
    this._inner.innerHTML = "";
    this._activeViewElement = null;

    // ha-card wrapper
    if (this._config.ha_card !== false) {
      const card = document.createElement("ha-card");
      card.appendChild(this._container);
      this.shadowRoot.appendChild(card);
    } else {
      this.shadowRoot.appendChild(this._container);
    }

    // bleed (only without ha-card)
    const bleedOn = this._config.ha_card === false && this._config.bleed === true;
    const bleedInline = Number.isFinite(this._config.bleed_inline) ? this._config.bleed_inline : 16;
    const bleedBlock = Number.isFinite(this._config.bleed_block) ? this._config.bleed_block : 8;
    this._inner.style.marginInline = bleedOn ? `-${bleedInline}px` : "0";
    this._inner.style.marginBlock  = bleedOn ? `-${bleedBlock}px` : "0";

    this._container.appendChild(this._inner);
  }


  // called whenever Home Assistant state updates (resolves target and (re)renders view)
  set hass(hass) {
    this._hass = hass;
    if (!this._config) return;

    // read current dashboard and view
    let currentDashboard = this._getHuiRoot()?.lovelace?.urlPath || null;
    // normalize default dashboard: treat "lovelace" as valid, not as null
    if (currentDashboard === null && window.location.pathname.includes("/lovelace")) {
      currentDashboard = "lovelace";
    }
    const segments = window.location.pathname.split("/").filter(Boolean);
    const i = currentDashboard ? segments.indexOf(currentDashboard) : -1;
    const currentView = i >= 0 && segments[i + 1] ? decodeURIComponent(segments[i + 1]) : null; 

    // resolve target (dashboard + view) by mode
    const mode = this._config.mode === "dynamic" ? "dynamic" : this._config.mode === "hash" ? "hash" : "static";

    let effectiveDashboard = null;
    let effectiveView = null;
    let external = false;
    let currentHash = "";

    // wait for current dashboard
    if (!currentDashboard) {
      if (!this._waitingForRoot) {
        this._waitingForRoot = true;
        this._waitFor(() => this._getHuiRoot()?.lovelace, 10000, "hui-root not found")
          .then(() => { this._waitingForRoot = false; this.hass = this._hass; })
          .catch(() => { this._waitingForRoot = false; });
      }
      return;
    }

    if (mode === "hash") {
      // hash mode -> read URL hash or extra path segment, match against states map
      const hashValue = window.location.hash.replace(/^#/, "");
      // extract extra path segment as the last segment beyond dashboard/view
      // e.g. /dashboard-test/home/climate -> segments=["dashboard-test","home","climate"] -> "climate"
      const pathValue = segments.length > 2 ? decodeURIComponent(segments[segments.length - 1]) : "";
      currentHash = hashValue || pathValue || this._config.default || "";

      if (!currentHash) {
        if (this._resolved.view !== "__error_hash__") {
          this._resolved.view = "__error_hash__";
          this._showError(this._t("Missing configuration") + ": no URL hash, path segment, or default value");
        }
        return;
      }

      const states = this._config.states || {};
      const stateConfig = states[currentHash];

      if (!stateConfig) {
        if (this._resolved.view !== "__error_hash__") {
          this._resolved.view = "__error_hash__";
          this._showError(this._t("No matching state for hash") + ": " + currentHash);
        }
        return;
      }

      effectiveView = stateConfig.view;
      if (!effectiveView) {
        if (this._resolved.view !== "__error_hash__") {
          this._resolved.view = "__error_hash__";
          this._showError(this._t("Missing configuration") + ": no view for hash \"" + currentHash + "\"");
        }
        return;
      }

      effectiveDashboard = stateConfig.dashboard || currentDashboard || null;
      external = Boolean(effectiveDashboard && currentDashboard && (effectiveDashboard !== currentDashboard));
    } 
    
    else if (mode === "dynamic") {
      // dynamic -> "target_entity"
      const targetentity = this._config.target_entity;
      const targetentitystate = targetentity ? this._hass?.states?.[targetentity]?.state : undefined;

      if (!targetentitystate) {
        if (this._resolved.view !== "__error_dyn__") {
          this._resolved.view = "__error_dyn__";
          this._showError(this._t("Missing configuration") + ": no target_entity or empty entity");
        }
        return;
      }

      const parsed = this._parseTargetString(targetentitystate, currentDashboard);

      if (!parsed || !parsed.dashboard || !parsed.view) {
        this._showError(this._t("Invalid dynamic target") + ": " + _escapeHtml(targetentitystate));
        return;
      }

      effectiveDashboard = parsed.dashboard;
      effectiveView = parsed.view;
      external = Boolean(effectiveDashboard && currentDashboard && (effectiveDashboard !== currentDashboard));
    } 
    
    else {
      // static -> "dashboard" and "view" (fallback "view_path" or "view_path_entity")
      // view (with fallback)
      effectiveView = this._config.view ?? this._config.view_path;
      if (!effectiveView && this._config.view_path_entity) {
        const viewpathentity = this._config.view_path_entity;
        const viewpathentitystate = viewpathentity ? this._hass?.states?.[viewpathentity] : undefined;
        effectiveView = viewpathentitystate?.state || undefined;
      }
      if (!effectiveView) {
        if (this._resolved.view !== "__error_stat__") {
          this._resolved.view = "__error_stat__";
          this._showError(this._t("Missing configuration") + ": no view");
        }
        return;
      }

      // dashboard (undefined or empty => current)
      effectiveDashboard = this._config.dashboard || currentDashboard || null;
      external = Boolean(effectiveDashboard && currentDashboard && (effectiveDashboard !== currentDashboard));
    }


    // loop guard -> prevent self-embedding
    if (effectiveDashboard == currentDashboard && effectiveView == currentView) {
      this._showError(this._t("Self embedding not allowed") + ":<br>host view = " + _escapeHtml(currentDashboard) + "/" + _escapeHtml(currentView) + "<br>embedding view = " + _escapeHtml(effectiveDashboard) + "/" + _escapeHtml(effectiveView));
      return;
    }

    // render view only if not existing or targetpath changed
    const needRender =
      !this._activeViewElement ||
      effectiveView !== this._resolved.view ||
      effectiveDashboard !== this._resolved.dashboard ||
      (mode === "hash" && currentHash !== this._resolved.hash);

    if (needRender) {
      this._renderTarget(effectiveDashboard, effectiveView, external).catch((err) => {
        this._showError(this._t("Error loading view") + ": " + (err?.message || err));
      });
      return;
    }

    // hass live update
    if (this._activeViewElement) this._activeViewElement.hass = this._hass;
  }


  // render a view either from the current dashboard (live) or from another dashboard (via WS config).
  async _renderTarget(dashboardPath, viewPath, external) {

    let lovelace, views;

    // build views array
    if (external) {
      // fetch ws-config for the chosen dashboard
      const config = await this._fetchLovelaceConfigWS(dashboardPath);
      lovelace = { config: config, urlPath: dashboardPath, editMode: false };
      views = Array.isArray(config?.views) ? config.views : [];
    }
    else {
      const root = await this._waitFor(() => this._getHuiRoot(), 10000, "hui-root not found");
      lovelace = root?.lovelace;
      views = Array.isArray(lovelace?.config?.views) ? lovelace.config.views : [];
    }

    // search for matching view
    let view = views.find((i) => i?.path === viewPath);

    // allow index ("0", "1", …) or "index-0" style
    if (!view) {
      const index = this._convertToIndex(viewPath);
      if (index != null && index >= 0 && index < views.length) {
        view = views[index];
      }
    }

    // fresh WS reload (cache-bust) if external dashboard and view not found 
    if (!view && external) {
      const freshConfig = await this._fetchLovelaceConfigWS(dashboardPath, { force: true });
      const freshViews = Array.isArray(freshConfig?.views) ? freshConfig.views : [];
      let fresh = freshViews.find((i) => i?.path === viewPath);

      if (!fresh) {
        const index = this._convertToIndex(viewPath);
        if (index != null && index >= 0 && index < freshViews.length) {
          fresh = freshViews[index];
        }
      }
      if (!fresh) {
        this._showError(this._t("View not found") + ": " + _escapeHtml(viewPath));
        return;
      }
      lovelace = { config: freshConfig, urlPath: dashboardPath, editMode: false };
      views = freshViews;
      view = fresh;
    }

    // no view found
    if (!view) {
      this._showError(this._t("View not found") + ": " + _escapeHtml(viewPath));
      return;
    }

    // respect 'visible' rules
    if (!this._isViewVisibleToUser(view)) {
      this._showError(this._t("View not visible for this user"));
      return;
    }

    // create HA hui-view
    const huiview = document.createElement("hui-view");
    huiview.setAttribute("style", "margin:0;padding:0;display:contents;");
    huiview.hass = this._hass;
    huiview.narrow = false;
    huiview.lovelace = lovelace;
    huiview.index = views.indexOf(view);
    huiview.isStrategyView = !!view?.strategy;
    if (view?.strategy) {
      huiview.strategy = view.strategy;
    }
    huiview.viewConfig = view;

    this._inner.innerHTML = "";
    this._inner.appendChild(huiview);
    this._activeViewElement = huiview;

    // storage paths so that we render only on change 
    this._resolved.view = viewPath;
    this._resolved.dashboard = dashboardPath;
    if (this._config.mode === "hash") {
      this._resolved.hash = window.location.hash.replace(/^#/, "") || this._config.default || "";
    }
  }


  // checks if the given view is visible for the current user according to its config
  _isViewVisibleToUser(view) {
    return _isViewVisibleToUser(view, this._hass);
  }

  // fetch dashboard config  (only refresh when `force: true`)
  async _fetchLovelaceConfigWS(urlPath, { force = false } = {}) {
    const cached = this._wsConfigCache[urlPath];
    if (!force && cached) {
      return Promise.resolve(cached);
    }

    const promise = this._hass.callWS({ type: "lovelace/config", url_path: urlPath })
      .then(config => {
        this._wsConfigCache[urlPath] = config;
        return config;
      })
      .catch(err => {
        delete this._wsConfigCache[urlPath];
        throw new Error(`Failed to fetch dashboard config "${urlPath}": ${err.message}`);
      });

    this._wsConfigCache[urlPath] = promise;
    return promise;
  }


  // parse a combined "dashboard/view" string.
  _parseTargetString(targetentitystate, currentDashboard) {
    return _parseDashboardViewString(targetentitystate, currentDashboard);
  }


  // accepts "0", "1", ... or "index-0" style and returns a number or null
  _convertToIndex(path) {
    if (typeof path !== "string") return null;
    const m = path.match(/^(?:index-)?(\d+)$/);
    return m ? Number(m[1]) : null;
  }


  // show the error and initialize the current view so the next valid target re-renders
  _showError(msg) {
    this._inner.innerHTML = `<hui-warning>${msg}</hui-warning>`;
    this._activeViewElement = null;
  }


  // traverses nested shadowRoots to locate the main <hui-root> element of lovelace
  _getHuiRoot() {
    return _getHuiRoot();
  }


  // repeatedly calls fn() until it returns a value or the timeout is reached
  async _waitFor(fn, timeout = 8000, message = "Timeout") {
    const start = performance.now();
    return new Promise((resolve, reject) => {
      let timerId;
      const tick = () => {
        try {
          const v = fn();
          if (v) {
            this._waitForTimers.delete(timerId);
            return resolve(v);
          }
        } catch (_) {}

        if (performance.now() - start > timeout) {
          this._waitForTimers.delete(timerId);
          return reject(new Error(message));
        }

        timerId = setTimeout(tick, 100);
        this._waitForTimers.add(timerId);
      };
      tick();
    });
  }

  // returns the custom editor element used in the Lovelace UI
  static getConfigElement() { return document.createElement("embedded-view-card-editor"); }

  // provides a minimal default config when the card is first added
  static getStubConfig() { return { type: "custom:embedded-view-card", view: "" }; }

  // translate
  _t(key, vars) {
    return i18n(this._hass, key, vars);
  }
}
customElements.define("embedded-view-card", EmbeddedViewCard);








class EmbeddedViewCardEditor extends HTMLElement {

  // initializes and set up states (not modify DOM per HA editor rules)
  constructor() {
    super();
    this._hass = undefined;
    this._config = {};
    this._rendered = false;

    this._selectedDash = "";    // dashboard (for UI selection)
    this._dashboards = [];      // [{ value: url_path, label: string }]
    this._viewsForDash = [];    // [{ path, title }]
    this._hashViews = {};       // cached views per dashboard for hash mode
    this._needsRender = true;   // only rebuild DOM when structure changes
  }

  // lifecycle hook
  connectedCallback() {}


  // applies configuration and builds (updates the editor UI)
  setConfig(config) {
    // normalize incoming config so legacy keys (view_path) are removed immediately
    const normalized = this._normalizeConfig(config || {});
    const changed = JSON.stringify(normalized) !== JSON.stringify(config || {});
    this._config = normalized;

    // set currently selected dashboard for the editor dropdown
    if (typeof this._config.dashboard === "string") this._selectedDash = this._config.dashboard;

    // ensure states is always an object when in hash mode
    if (this._config.mode === "hash" && !this._config.states) {
      this._config.states = {};
    }

    // notify HA editor that the config has changed
    if (changed) {
      this._updateConfig();
    }

    if (this._needsRender) {
      this._needsRender = false;
      this._safeRender();
    }
  }


  // applies configuration and builds/updates the editor UI
  set hass(hass) {
    this._hass = hass;
    this._collectDashboards().then(() => {
      if (this._needsRender) this._safeRender();
    }).catch(() => {});
  }


  // collect all available lovelace dashboards from hass.panels for the editor dropdown
  async _collectDashboards() {
    try {
      const panels = this._hass?.panels || {};
      const list = [];
      const deny = new Set(["lovelace", "map"]); // skip reserved panels like "lovelace" (default) or "map"

      for (const [key, p] of Object.entries(panels)) {
        // no lovelace view
        const comp = p?.component_name || p?.component;
        if (comp !== "lovelace") continue;

        // on deny list
        const urlPath = (typeof p.url_path === "string" && p.url_path.length) ? p.url_path : key;
        if (deny.has(urlPath)) continue;

        // no visible views for this user
        const views = await this._loadViewsFor(urlPath);
        if (!Array.isArray(views) || views.length === 0) continue;

        const label = (p.title && String(p.title).trim()) ? `${p.title} (${urlPath})` : urlPath;
        list.push({ value: urlPath, label });
      }

      // remove duplicate dashboards (using seen set) and sort list alphabetically by label
      const seen = new Set();
      this._dashboards = list
        .filter(d => !seen.has(d.value) && seen.add(d.value))
        .sort((a, b) => a.label.localeCompare(b.label, undefined, { sensitivity: "base" }));

      // reset selection if the previously chosen dashboard is no longer in the available list
      if (this._selectedDash && !this._dashboards.some(d => d.value === this._selectedDash)) {
        this._selectedDash = "";
        this._viewsForDash = [];
      }
    }
    catch (e) {
      console.warn("[embedded-view-card] editor: dashboards listing failed", e);
      this._dashboards = [];
    }
  }


  // wrapper around _render(): catches errors to prevent editor crash
  _safeRender() { try { this._render(); } catch (ex) { console.error("[embedded-view-card] editor render error:", ex); } }


  // builds or updates the editor UI elements based on the current config and hass state
  _render() {
    if (this._rendered || !this._hass) return;

    // create a flexbox column wrapper with padding and spacing for the editor controls
    const wrap = document.createElement("div");
    wrap.style.display = "flex";
    wrap.style.flexDirection = "column";
    wrap.style.gap = "12px";
    wrap.style.padding = "0 16px";

    // mode selector (plain select for reliability)
    const modeRow = document.createElement("div");
    modeRow.style.display = "flex";
    modeRow.style.alignItems = "center";
    modeRow.style.gap = "8px";

    const modeLabel = document.createElement("label");
    modeLabel.textContent = this._t("Mode");
    modeLabel.style.fontWeight = "600";
    modeRow.appendChild(modeLabel);

    const modeSel = document.createElement("select");
    modeSel.style.cssText = "flex:1;padding:8px;border:1px solid var(--divider-color);border-radius:8px;background:var(--card-background-color);color:var(--primary-text-color);font-size:14px;";
    const modeOptions = [
      { value: "static",  label: this._t("Static") },
      { value: "dynamic", label: this._t("Dynamic (entity)") },
      { value: "hash",    label: this._t("Hash (URL hash)") },
    ];
    for (const opt of modeOptions) {
      const option = document.createElement("option");
      option.value = opt.value;
      option.textContent = opt.label;
      if (opt.value === (this._config.mode || "static")) option.selected = true;
      modeSel.appendChild(option);
    }

    modeSel.addEventListener("change", () => {
      const mode = modeSel.value;
      if (this._config.mode === mode) return;

      this._config.mode = mode;

      if (mode === "hash") {
        delete this._config.dashboard;
        delete this._config.view;
        delete this._config.view_path;
        delete this._config.view_path_entity;
        delete this._config.target_entity;
        if (!this._config.states) this._config.states = {};
        if (!this._config.default) this._config.default = "";
      }
      else if (mode === "dynamic") {
        delete this._config.dashboard;
        delete this._config.view;
        delete this._config.view_path;
        delete this._config.view_path_entity;
        delete this._config.states;
        delete this._config.default;
        this._selectedDash = "";
        this._viewsForDash = [];
      }
      else {
        delete this._config.target_entity;
        delete this._config.states;
        delete this._config.default;
        const legacy = this._config.view ?? this._config.view_path ?? "";
        if (legacy !== "") this._config.view = legacy;
        delete this._config.view_path;
        delete this._config.view_path_entity;
      }

      this._needsRender = true;
      this._updateConfig();
    });
    modeRow.appendChild(modeSel);
    wrap.appendChild(modeRow);

    // static mode UI
    if ((this._config.mode || "static") === "static") {
      // dashboard dropdown
      const dashSel = document.createElement("ha-selector");
      dashSel.label = this._t("Choose a dashboard");
      dashSel.hass = this._hass;
      dashSel.selector = { select: { options: this._dashboards.length ? this._dashboards : [], custom_value: true } };
      dashSel.value = this._selectedDash;

      dashSel.addEventListener("value-changed", async (ev) => {
        this._selectedDash = ev.detail?.value || "";
        this._config.dashboard = this._selectedDash || "";
        this._updateConfig();

        this._viewsForDash = this._selectedDash ? [{ path: "", title: this._t("Loading views…") }] : [];
        this._rendered = false;
        this._safeRender();

        const views = this._selectedDash ? await this._loadViewsFor(this._selectedDash) : [];
        this._viewsForDash = views.length ? views : (this._selectedDash ? [{ path: "", title: this._t("No views found") }] : []);
        this._rendered = false;
        this._safeRender();
      });
      wrap.appendChild(dashSel);

      // view dropdown (stores `view`, not `view_path`)
      const viewSel = document.createElement("ha-selector");
      viewSel.label = this._t("Choose a view");
      viewSel.hass = this._hass;
      const viewOptions = this._viewsForDash.map(v => ({
        value: v.path,
        label: v.path ? (v.title ? `${v.title} (${v.path})` : v.path) : v.title
      })).filter(o => o.value !== undefined && o.value !== null);
      viewSel.selector = { select: { options: viewOptions, custom_value: true } };
      viewSel.value = this._config.view ?? this._config.view_path ?? "";

      viewSel.addEventListener("value-changed", (ev) => {
        this._config.view = ev.detail?.value || "";
        delete this._config.view_path;  // remove legacy key if present
        this._updateConfig();
      });
      wrap.appendChild(viewSel);
    }

    // dynamic mode UI
    if ((this._config.mode || "static") === "dynamic") {
      // entity that stores "dashboard/view"
      const entSel = document.createElement("ha-selector");
      entSel.label = this._t('Target entity (state: "dashboard/view")');
      entSel.hass = this._hass;
      entSel.selector = { entity: {} };
      entSel.value = this._config.target_entity || "";

      entSel.addEventListener("value-changed", (ev) => {
        const v = ev.detail?.value || "";
        if (this._config.target_entity === v) return;
        this._config.target_entity = v;
        this._updateConfig();
      });
      wrap.appendChild(entSel);

      // live preview of the entity state and parsed parts
      const targetEntity = this._config.target_entity;
      const state = targetEntity ? this._hass?.states?.[targetEntity]?.state : undefined;
      const currentDashboard = this._getHuiRoot()?.lovelace?.urlPath || null;
      const parsed = typeof state === "string" && state ? this._parsePreview(state, currentDashboard) : null;

      const hint = document.createElement("div");
      hint.style.opacity = "0.9";
      hint.innerHTML = [
        `<div><strong>${this._t("Expected format")}:</strong> <code>dashboard/view</code></div>`,
        `<div>${this._t("Examples")}:</div>`,
        `<ul style="margin:4px 0 0 16px;padding:0;">`,
        `<li><code>dashboard-rooms/kitchen</code></li>`,
        `<li><code>current/kitchen</code> ${this._t("(uses current dashboard)")}</li>`,
        `<li><code>/kitchen</code> ${this._t("(interpreted as current/kitchen)")}</li>`,
        `<li><code>current/0</code> ${this._t("(first view by index)")}</li>`,
        `<li><code>/0</code> ${this._t("(also first view by index)")}</li>`,
        `</ul>`,
      ].join("");
      wrap.appendChild(hint);

      const pv = document.createElement("div");
      pv.style.fontFamily = "monospace";
      pv.style.padding = "8px 10px";
      pv.style.border = "1px solid var(--divider-color)";
      pv.style.borderRadius = "8px";
      pv.style.background = "var(--card-background-color)";
      pv.innerHTML = [
        `<div><strong>${this._t("Current value")}:</strong> <code>${state ?? "—"}</code></div>`,
        `<div><strong>${this._t("Parsed to")}:</strong> ${
          parsed
            ? `<code>${parsed.dashboard || currentDashboard}/${parsed.view}</code>`
            : `<span style="color:var(--error-color);">${this._t("invalid or empty")}</span>`
        }</div>`,
      ].join("");
      wrap.appendChild(pv);
    }

    // hash mode UI
    if ((this._config.mode || "static") === "hash") {
      try {
      // Defensive guard: ensure _hashViews exists
      if (!this._hashViews) this._hashViews = {};

      // default value input
      const defaultInput = document.createElement("ha-selector");
      defaultInput.label = this._t("Default hash value (fallback)");
      defaultInput.hass = this._hass;
      defaultInput.selector = { text: {} };
      defaultInput.value = this._config.default || "";

      defaultInput.addEventListener("value-changed", (ev) => {
        this._config.default = ev.detail?.value || "";
        this._updateConfig();
      });
      wrap.appendChild(defaultInput);

      // states list
      const statesContainer = document.createElement("div");
      statesContainer.style.display = "flex";
      statesContainer.style.flexDirection = "column";
      statesContainer.style.gap = "12px";

      const statesLabel = document.createElement("div");
      statesLabel.style.fontWeight = "600";
      statesLabel.textContent = this._t("States (hash → view mapping)");
      statesContainer.appendChild(statesLabel);

      const buildStateRow = (key) => {
        const state = this._config.states[key];
        const card = document.createElement("div");
        card.style.cssText = "border:1px solid var(--divider-color);border-radius:8px;padding:12px;position:relative;";

        // header row: hash key + remove button
        const header = document.createElement("div");
        header.style.cssText = "display:flex;gap:8px;align-items:center;margin-bottom:8px;";

        const keyLabel = document.createElement("span");
        keyLabel.style.cssText = "font-weight:600;min-width:60px;";
        keyLabel.textContent = this._t("Hash key");
        header.appendChild(keyLabel);

        const keyInput = document.createElement("ha-selector");
        keyInput.selector = { text: {} };
        keyInput.value = key;
        keyInput.style.flex = "1";
        keyInput.addEventListener("value-changed", (ev) => {
          const newKey = ev.detail?.value || key;
          if (newKey !== key && newKey) {
            const newState = { ...this._config.states[key] };
            delete this._config.states[key];
            this._config.states[newKey] = newState;
            this._needsRender = true;
            this._updateConfig();
          }
        });
        header.appendChild(keyInput);

        const removeBtn = document.createElement("button");
        removeBtn.textContent = "✕";
        removeBtn.title = this._t("Remove");
        removeBtn.style.cssText = "background:none;border:none;color:var(--error-color);cursor:pointer;font-size:18px;padding:4px 8px;border-radius:4px;line-height:1;";
        removeBtn.addEventListener("mouseover", () => removeBtn.style.background = "rgba(220,53,69,0.1)");
        removeBtn.addEventListener("mouseout", () => removeBtn.style.background = "none");
        removeBtn.addEventListener("click", () => {
          delete this._config.states[key];
          this._needsRender = true;
          this._updateConfig();
        });
        header.appendChild(removeBtn);
        card.appendChild(header);

        // dashboard dropdown
        const dashRow = document.createElement("div");
        dashRow.style.cssText = "display:flex;gap:8px;align-items:center;margin-bottom:8px;";

        const dashLabel = document.createElement("span");
        dashLabel.style.cssText = "font-weight:600;min-width:60px;";
        dashLabel.textContent = this._t("Dashboard");
        dashRow.appendChild(dashLabel);

        const dashOptions = [{ value: "", label: this._t("(current dashboard)") }, ...this._dashboards];
        const dashSel = document.createElement("ha-selector");
        dashSel.selector = { select: { options: dashOptions, custom_value: true } };
        dashSel.value = state.dashboard || "";
        dashSel.style.flex = "1";
        dashRow.appendChild(dashSel);
        card.appendChild(dashRow);

        // view dropdown
        const viewRow = document.createElement("div");
        viewRow.style.cssText = "display:flex;gap:8px;align-items:center;";

        const viewLabel = document.createElement("span");
        viewLabel.style.cssText = "font-weight:600;min-width:60px;";
        viewLabel.textContent = this._t("View");
        viewRow.appendChild(viewLabel);

        const selectedDash = state.dashboard || "";
        let viewOptions = [];
        if (selectedDash && this._hashViews[selectedDash]) {
          viewOptions = this._hashViews[selectedDash].map(v => ({
            value: v.path,
            label: v.path ? (v.title ? `${v.title} (${v.path})` : v.path) : v.title
          }));
        } else if (!selectedDash && this._hashViews["__current__"]) {
          viewOptions = this._hashViews["__current__"].map(v => ({
            value: v.path,
            label: v.path ? (v.title ? `${v.title} (${v.path})` : v.path) : v.title
          }));
        } else {
          viewOptions = [{ value: "", label: this._t("Loading views…") }];
        }

        const viewSel = document.createElement("ha-selector");
        viewSel.selector = { select: { options: viewOptions, custom_value: true } };
        viewSel.value = state.view || "";
        viewSel.style.flex = "1";
        viewRow.appendChild(viewSel);
        card.appendChild(viewRow);

        // load views when dashboard changes
        const loadViews = async (dashboard) => {
          const cacheKey = dashboard || "__current__";
          if (!this._hashViews[cacheKey]) {
            this._hashViews[cacheKey] = [{ path: "", title: this._t("Loading views…") }];
            this._needsRender = true;
            this._safeRender();

            const views = dashboard ? await this._loadViewsFor(dashboard) : await this._loadViewsFor(this._getHuiRoot()?.lovelace?.urlPath || "lovelace");
            this._hashViews[cacheKey] = views.length ? views : [{ path: "", title: this._t("No views found") }];
            this._needsRender = true;
            this._safeRender();
          }
        };

        dashSel.addEventListener("value-changed", (ev) => {
          const newDash = ev.detail?.value || "";
          state.dashboard = newDash;
          this._updateConfig();

          const ck = newDash || "__current__";
          if (!this._hashViews[ck]) {
            loadViews(newDash);
          }
          this._needsRender = true;
        });

        viewSel.addEventListener("value-changed", (ev) => {
          state.view = ev.detail?.value || "";
          this._updateConfig();
        });

        return card;
      };

      // preload current dashboard views (async, non-blocking)
      const currentDash = this._getHuiRoot()?.lovelace?.urlPath || "lovelace";
      if (!this._hashViews["__current__"]) {
        this._hashViews["__current__"] = [{ path: "", title: this._t("Loading views…") }];
        this._loadViewsFor(currentDash).then(views => {
          this._hashViews["__current__"] = views.length ? views : [{ path: "", title: this._t("No views found") }];
          if (this._config.mode === "hash") {
            this._needsRender = true;
            this._safeRender();
          }
        }).catch(() => {});
      }

      // preload views for dashboards referenced in existing states (async, non-blocking)
      const states = this._config.states || {};
      for (const key of Object.keys(states)) {
        const dash = states[key].dashboard;
        const cacheKey = dash || "__current__";
        if (!this._hashViews[cacheKey]) {
          this._hashViews[cacheKey] = [{ path: "", title: this._t("Loading views…") }];
          const loadDash = dash || currentDash;
          this._loadViewsFor(loadDash).then(views => {
            this._hashViews[cacheKey] = views.length ? views : [{ path: "", title: this._t("No views found") }];
            if (this._config.mode === "hash") {
              this._needsRender = true;
              this._safeRender();
            }
          }).catch(() => {});
        }
      }

      // render all state rows
      for (const key of Object.keys(states)) {
        statesContainer.appendChild(buildStateRow(key));
      }

      // add button
      const addBtn = document.createElement("button");
      addBtn.textContent = "+ " + this._t("Add state");
      addBtn.style.cssText = "background:var(--primary-color);color:var(--text-primary-color);border:none;border-radius:8px;padding:8px 16px;cursor:pointer;font-weight:600;font-size:14px;margin-top:4px;";
      addBtn.addEventListener("click", () => {
        if (!this._config.states) this._config.states = {};
        const newKey = "state" + (Object.keys(this._config.states).length + 1);
        this._config.states[newKey] = { view: "" };
        this._needsRender = true;
        this._updateConfig();
      });

      wrap.appendChild(statesContainer);
      wrap.appendChild(addBtn);

      // hint
      const hashHint = document.createElement("div");
      hashHint.style.opacity = "0.9";
      hashHint.innerHTML = [
        `<div><strong>${this._t("How it works")}:</strong></div>`,
        `<ul style="margin:4px 0 0 16px;padding:0;">`,
        `<li>${this._t("The card reads the URL hash (e.g., #climate) or extra path segment (e.g., /dashboard/view/climate)")}</li>`,
        `<li>${this._t("Matches it against the states map above")}</li>`,
        `<li>${this._t("Use navigate action in buttons to change the hash or path")}</li>`,
        `</ul>`,
      ].join("");
      wrap.appendChild(hashHint);
      } catch (err) {
        console.error("[embedded-view-card] hash mode render error:", err);
        const errDiv = document.createElement("div");
        errDiv.style.cssText = "padding:12px;border:1px solid var(--error-color);border-radius:8px;color:var(--error-color);font-family:monospace;font-size:12px;";
        errDiv.textContent = "Hash mode error: " + err.message;
        wrap.appendChild(errDiv);
      }
    }

    // ha-card toggle
    const haCardCheckbox = document.createElement("ha-selector");
    haCardCheckbox.label = this._t("Wrap in ha-card");
    haCardCheckbox.hass = this._hass;
    haCardCheckbox.selector = { boolean: {} };
    haCardCheckbox.value = this._config.ha_card !== false;

    haCardCheckbox.addEventListener("value-changed", (ev) => {
      this._config.ha_card = ev.detail.value;
      // if ha-card is enabled, bleed options are irrelevant
      if (this._config.ha_card !== false) {
        delete this._config.bleed;
        delete this._config.bleed_inline;
        delete this._config.bleed_block;
      }

      this._updateConfig();
      this._rendered = false;
      this._safeRender();
    });
    wrap.appendChild(haCardCheckbox);

    // bleed options (only when ha_card is false)
    if (this._config.ha_card === false) {
      
      // bleed toggle
      const bleedCheckbox = document.createElement("ha-selector");
      bleedCheckbox.label = this._t("Remove outer padding (bleed)");
      bleedCheckbox.hass = this._hass;
      bleedCheckbox.selector = { boolean: {} };
      bleedCheckbox.value = this._config.bleed === true;

      bleedCheckbox.addEventListener("value-changed", (ev) => {
        this._config.bleed = ev.detail.value;

        this._updateConfig();
        this._rendered = false;
        this._safeRender();
      });
      wrap.appendChild(bleedCheckbox);

      // inline and block values visible only if bleed is on
      if (this._config.bleed === true) {

        // bleed inline
        const bleedInlineInput = document.createElement("ha-selector");
        bleedInlineInput.label = this._t("Bleed inline (px, left/right)");
        bleedInlineInput.hass = this._hass;
        bleedInlineInput.selector = { number: { min: 0, max: 64, step: 1, mode: "box" } };
        bleedInlineInput.value = Number.isFinite(this._config.bleed_inline) ? this._config.bleed_inline : 16;

        bleedInlineInput.addEventListener("value-changed", (ev) => {
          const val = Number(ev.detail.value);
          if (Number.isFinite(val)) this._config.bleed_inline = val;
          else delete this._config.bleed_inline;

          this._updateConfig();
        });
        wrap.appendChild(bleedInlineInput);

        // bleed_block
        const bleedBlockInput = document.createElement("ha-selector");
        bleedBlockInput.label = this._t("Bleed block (px, top/bottom)");
        bleedBlockInput.hass = this._hass;
        bleedBlockInput.selector = { number: { min: 0, max: 64, step: 1, mode: "box" } };
        bleedBlockInput.value = Number.isFinite(this._config.bleed_block) ? this._config.bleed_block : 8;

        bleedBlockInput.addEventListener("value-changed", (ev) => {
          const val = Number(ev.detail.value);
          if (Number.isFinite(val)) this._config.bleed_block = val;
          else delete this._config.bleed_block;

          this._updateConfig();
        });
        wrap.appendChild(bleedBlockInput);
      }
    }

    // general notes
    const note = document.createElement("div");
    note.style.opacity = "0.8";
    note.style.marginTop = "8px";
    note.textContent = this._t("Card renders the chosen (or dynamic) dashboard + view.");
    wrap.appendChild(note);

    // add a prominent warning below the note that multi-call loop detection is not supported yet
    const warn = document.createElement("div");
    warn.style.marginTop = "6px";
    warn.style.padding = "6px 8px";
    warn.style.border = "1px solid rgba(220,53,69,0.5)";
    warn.style.background = "rgba(220,53,69,0.08)";
    warn.style.color = "rgb(176,0,32)";
    warn.style.borderRadius = "6px";
    warn.style.fontWeight = "600";
    warn.style.display = "flex";
    warn.style.alignItems = "center";
    warn.style.gap = "8px";
    warn.textContent = this._t("Warning: cross-call loop detection is not implemented yet. Do not test recursive embeddings across multiple calls.");
    wrap.appendChild(warn);

    this.replaceChildren(wrap);
    // if dashboard list was not yet loaded we need a re-render
    if (!this._dashboards?.length) return
    this._rendered = true;
  }


  // build dropdown options: use path if available, otherwise numeric index
  async _loadViewsFor(urlPath) {
    try {
      // load WS views for a dashboard
      const wsConfig = await this._hass.callWS({ type: "lovelace/config", url_path: urlPath });
      const wsViews = wsConfig?.views.filter(v => this._isViewVisibleToUser(v)) || [];  // respect visibility

      // editor uses numeric index ("0") if view has no path
      return (Array.isArray(wsViews) ? wsViews : []).map((v, i) => {
        const val = v?.path ?? String(i);
        const title =
          v?.title ??
          v?.name ??
          (v?.path ? v.path : (i === 0 ? "Home" : `Index ${i}`));
        return { path: val, title };
      });
    }
    catch {
      return [];
    }
  }


  // checks if the given view is visible for the current user according to its config
  _isViewVisibleToUser(view) {
    return _isViewVisibleToUser(view, this._hass);
  }


  // update config and notify HA editor about the change
  _updateConfig() {
    this.dispatchEvent(new CustomEvent("config-changed", { detail: { config: this._config } }));
  }


  // normalizes config: drop legacy keys, keep valid/static/dynamic/hash settings, preserve extras
  _normalizeConfig(config) {
    const out = {};

    // migrate legacy 'view_path_entity' to dynamic mode if no target_entity is set
    const hasLegacyEntity = !!config.view_path_entity;
    const effectiveTarget = config.target_entity || (hasLegacyEntity ? config.view_path_entity : undefined);

    let mode = String(config.mode ?? "static").toLowerCase();
    if (effectiveTarget && mode !== "dynamic") mode = "dynamic";
    mode = mode === "dynamic" ? "dynamic" : mode === "hash" ? "hash" : "static";

    // header
    out.type = "custom:embedded-view-card";
    out.mode = mode;

    if (mode === "dynamic") {
      // dynamic: keep only dynamic essentials
      if (effectiveTarget) out.target_entity = effectiveTarget;
      // drop dynamic/leftover keys implicitly (not copied)
    }
    else if (mode === "hash") {
      // hash: keep states and default
      if (config.default) out.default = config.default;
      if (config.states && Object.keys(config.states).length > 0) out.states = config.states;
    }
    else {
      // static: prefer view and dashboard, (legacy fallback: view_path, view_path_entity)
      const view = config.view ?? config.view_path ?? null;
      if (config.dashboard !== undefined && config.dashboard !== "") out.dashboard = config.dashboard;
      if (view) out.view = view;
      // drop dynamic leftovers implicitly (not copied)
    }

    // optional flags (only if non-default)
    if (config.ha_card === false) out.ha_card = false;
    if (config.bleed === true) out.bleed = true;
    if (Number.isFinite(config.bleed_inline) && config.bleed_inline !== 16) out.bleed_inline = config.bleed_inline;
    if (Number.isFinite(config.bleed_block)  && config.bleed_block  !== 8)  out.bleed_block  = config.bleed_block;

    // preserve unknown extras at the end, but drop legacy keys
    const known = new Set(Object.keys(out));
    for (const k of Object.keys(config)) {
      if (
        !known.has(k) &&                // not already copied
        config[k] !== undefined &&      // has a value
        k !== "view_path" &&            // exclude legacy
        k !== "view_path_entity"        // exclude legacy
      ) {
        out[k] = config[k];
      }
    }
    return out;
  }


  // parse the entity state string into { dashboard, view }; supports "dashboard/view", "current/view", or just "view"
  _parsePreview(value, currentDashboard) {
    return _parseDashboardViewString(value, currentDashboard);
  }


  // traverses nested shadowRoots to locate the main <hui-root> element of lovelace
  _getHuiRoot() {
    return _getHuiRoot();
  }


  // translate
  _t(key, vars) {
    return i18n(this._hass, key, vars);
  }
}
customElements.define("embedded-view-card-editor", EmbeddedViewCardEditor);

// register this custom card (shows up in HA's card picker)
window.customCards = window.customCards || [];
window.customCards.push({
  type: "embedded-view-card",
  name: "Embedded View Card",
  description: "Allows embedding another view into a card.",
});


// console info
console.info(
  `%c🧩 EMBEDDED VIEW CARD %c v${VERSION} `,
  "background:#fafafa;color:#17c711;font-weight:bold;padding:2px 6px;",
  "background:#17c711;color:#fafafa;font-weight:bold;padding:2px 4px;"
);
