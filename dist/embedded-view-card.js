// Embedded View Card for Home Assistant
// Allows embedding another view into a card

import { VERSION } from "./version.js";
import { t as i18n } from "./i18n/index.js";

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
    this._resolved = { view: undefined, dashboard: undefined };
    this._waitingForRoot = false;
    this._wsConfigCache = {};

    // initialize DOM elements
    this._container = document.createElement("div");
    this._container.style.display = "contents";
    this._inner = document.createElement("div");
    this._inner.style.margin = "0";
  }


  // applies user configuration, sets defaults, and builds the initial DOM structure
  setConfig(config) {
    this._config = {
      mode: "static",               // mode: static or dynamic

      // static mode
      dashboard: undefined,         // dashboard  (empty or undefined => current)
      view: undefined,              // view
      view_path: undefined,         // legacy fallback (read-only)

      // dynamic mode
      target_entity: undefined,     // entity whose state is "dashboard/view"
      view_path_entity: undefined,  // legacy fallback (read-only)

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
    const currentDashboard = this._getHuiRoot()?.lovelace?.urlPath || null;
    const segments = window.location.pathname.split("/").filter(Boolean);
    const i = currentDashboard ? segments.indexOf(currentDashboard) : -1;
    const currentView = i >= 0 && segments[i + 1] ? decodeURIComponent(segments[i + 1]) : null; 

    // resolve target (dashboard + view) by mode
    const mode = this._config.mode === "dynamic" ? "dynamic" : "static";

    let effectiveDashboard = null;
    let effectiveView = null;
    let external = false;

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

    if (mode === "dynamic") {
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
        this._showError(this._t("Invalid dynamic target") + ": " + targetentitystate);
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
        const viewpathentitystate = viewpathentity ? this._hass.states?.[viewpathentity] : undefined;
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
      this._showError(this._t("Self embedding not alowed") + ":<br>host view = " + currentDashboard + "/" + currentView + "<br>embedding view = " + effectiveDashboard + "/" + effectiveView);
      return;
    }

    // render view only if not existing or targetpath changed
    const needRender =
      !this._activeViewElement ||
      effectiveView !== this._resolved.view ||
      effectiveDashboard !== this._resolved.dashboard;

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
        this._showError(this._t("View not found") + ": " + viewPath);
        return;
      }
      lovelace = { config: freshConfig, urlPath: dashboardPath, editMode: false };
      views = freshViews;
      view = fresh;
    }

    // no view found
    if (!view) {
      this._showError(this._t("View not found") + ": " + viewPath);
      return;
    }

    // respect 'visible' rules
    if (!this._isViewVisibleToUser(view)) {
      this._showError("View not visible for this user");
      return;
    }

    // create HA hui-view
    const huiview = document.createElement("hui-view");
    huiview.setAttribute("style", "margin:0;padding:0;display:contents;");
    huiview.hass = this._hass;
    huiview.narrow = false;
    huiview.lovelace = lovelace;
    huiview.index = views.indexOf(view);
    huiview.isStrategyView = false;
    huiview.viewConfig = view;

    this._inner.innerHTML = "";
    this._inner.appendChild(huiview);
    this._activeViewElement = huiview;

    // storage paths so that we render only on change 
    this._resolved.view = viewPath;
    this._resolved.dashboard = dashboardPath;
  }


  // checks if the given view is visible for the current user according to its config
  _isViewVisibleToUser(view) {
    // home assistant exposes the current user id on hass.user.id
    const uid = this._hass?.user?.id || null;
    if (!uid || !view) return true; // if we can't tell, fail open

    //  normalize possible visibility definitions:
    //  - 'visible': [ { user: "<id>" }, ... ]  (common)
    //  - 'visible': [ "<id>", ... ]            (tolerate strings)
    //  - 'visibility' or 'users' fallbacks (be liberal in what we accept)
    const raw =
      (Array.isArray(view.visible) && view.visible.length ? view.visible : null) ||
      (Array.isArray(view.visibility) && view.visibility.length ? view.visibility : null) ||
      (Array.isArray(view.users) && view.users.length ? view.users : null);

    // no rules -> visible for everyone
    if (!raw) return true;

    // allow if any rule explicitly includes the current user id
    for (const r of raw) {
      if (typeof r === "string" && r === uid) return true;
      if (r && typeof r === "object") {
        if (typeof r.user === "string" && r.user === uid) return true;
        if (Array.isArray(r.user) && r.user.includes(uid)) return true;
        if (Array.isArray(r.users) && r.users.includes(uid)) return true;
      }
    }

    // rules exist but none matched -> not visible for this user
    return false;
  }

  // fetch dashboard config  (only refresh when `force: true`)
  async _fetchLovelaceConfigWS(urlPath, { force = false } = {}) {
    // return cached config if present and no force reload was requested
    if (!force && this._wsConfigCache[urlPath]) {
      return this._wsConfigCache[urlPath];
    }

    // fetch fresh config via WS and update cache
    const config = await this._hass.callWS({ type: "lovelace/config", url_path: urlPath });
    this._wsConfigCache[urlPath] = config;
    return config;
  }


  // parse a combined "dashboard/view" string.
  _parseTargetString(targetentitystate, currentDashboard) {
    /* accepts:
      "dashboard/view"
      "/dashboard/view"
      "current/view"     (uses current dashboard)
      "view" or "/view"  (uses current dashboard)
    */
    if (typeof targetentitystate !== "string") return null;

    const parts = targetentitystate.trim().split("/").filter(Boolean);
    if (parts.length === 0) return null;

    // only view provided -> current dashboard
    if (parts.length === 1) {
      return { dashboard: currentDashboard, view: parts[0] };
    }

    // dashboard and view provided
    if (parts.length === 2) {
      const [dash, view] = parts;
      return { dashboard: (dash === "current" ? currentDashboard : dash), view };
    }

    // more than 2 parts are invalid
    return null;
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
    return document
      .querySelector("home-assistant")?.shadowRoot
      ?.querySelector("home-assistant-main")?.shadowRoot
      ?.querySelector("ha-panel-lovelace")?.shadowRoot
      ?.querySelector("hui-root");
  }


  // repeatedly calls fn() until it returns a value or the timeout is reached
  async _waitFor(fn, timeout = 8000, message = "Timeout") {
    const start = performance.now();
    return new Promise((resolve, reject) => {
      const tick = () => {
        try {
          const v = fn();
          if (v) return resolve(v);
        } catch (_) {}

        if (performance.now() - start > timeout)
          return reject(new Error(message));

        setTimeout(tick, 100);
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

    // notify HA editor that the config has changed
    if (changed) {
      this._updateConfig();
    }

    this._rendered = false;
    this._safeRender();
  }


  // applies configuration and builds/updates the editor UI
  set hass(hass) {
    this._hass = hass;
    this._collectDashboards().then(() => {
      if (!this._rendered) this._safeRender();
    });
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

    // mode selector (dropdown)
    const modeSel = document.createElement("ha-selector");
    modeSel.label = this._t("Mode");
    modeSel.hass = this._hass;
    modeSel.selector = { select: { options: [
      { value: "static",  label: this._t("Static") },
      { value: "dynamic", label: this._t("Dynamic (entity)") },
    ], custom_value: true } };  // forces dropdown even with few options
    modeSel.value = this._config.mode || "static";

    modeSel.addEventListener("value-changed", (ev) => {
      const mode = String(ev.detail?.value || "").toLowerCase() === "dynamic" ? "dynamic" : "static";
      if (this._config.mode === mode) return;
      this._config.mode = mode;

      if (mode === "dynamic") {
        // switching to dynamic: drop static keys immediately
        delete this._config.dashboard;
        delete this._config.view;
        delete this._config.view_path;
        delete this._config.view_path_entity;
        this._selectedDash = "";
        this._viewsForDash = [];
      }
      else {
        // switching to static: drop dynamic keys and migrate legacy once
        delete this._config.target_entity;
        const legacy = this._config.view ?? this._config.view_path ?? "";
        if (legacy !== "") this._config.view = legacy;
        delete this._config.view_path;
        delete this._config.view_path_entity;
      }

      this._updateConfig();
      this._rendered = false;
      this._safeRender();
    });
    wrap.appendChild(modeSel);

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
    // home assistant exposes the current user id on hass.user.id
    const uid = this._hass?.user?.id || null;
    if (!uid || !view) return true; // if we can't tell, fail open

    //  normalize possible visibility definitions:
    //  - 'visible': [ { user: "<id>" }, ... ]  (common)
    //  - 'visible': [ "<id>", ... ]            (tolerate strings)
    //  - 'visibility' or 'users' fallbacks (be liberal in what we accept)
    const raw =
      (Array.isArray(view.visible) && view.visible.length ? view.visible : null) ||
      (Array.isArray(view.visibility) && view.visibility.length ? view.visibility : null) ||
      (Array.isArray(view.users) && view.users.length ? view.users : null);

    // no rules -> visible for everyone
    if (!raw) return true;

    // allow if any rule explicitly includes the current user id
    for (const r of raw) {
      if (typeof r === "string" && r === uid) return true;
      if (r && typeof r === "object") {
        if (typeof r.user === "string" && r.user === uid) return true;
        if (Array.isArray(r.user) && r.user.includes(uid)) return true;
        if (Array.isArray(r.users) && r.users.includes(uid)) return true;
      }
    }

    // rules exist but none matched -> not visible for this user
    return false;
  }


  // update config and notify HA editor about the change
  _updateConfig() {
    this.dispatchEvent(new CustomEvent("config-changed", { detail: { config: this._config } }));
  }


  // normalizes config: drop legacy keys, keep valid/static/dynamic settings, preserve extras
  _normalizeConfig(config) {
    const out = {};

    // migrate legacy 'view_path_entity' to dynamic mode if no target_entity is set
    const hasLegacyEntity = !!config.view_path_entity;
    const effectiveTarget = config.target_entity || (hasLegacyEntity ? config.view_path_entity : undefined);

    let mode = String(config.mode ?? "static").toLowerCase();
    if (effectiveTarget && mode !== "dynamic") mode = "dynamic";
    mode = mode === "dynamic" ? "dynamic" : "static";

    // header
    out.type = "custom:embedded-view-card";
    out.mode = mode;

    if (mode === "dynamic") {
      // dynamic: keep only dynamic essentials
      if (effectiveTarget) out.target_entity = effectiveTarget;
      // drop dynamic leftovers implicitly (not copied)
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
    if (typeof value !== "string") return null;
    let s = value.trim();
    if (!s) return null;
    if (s.startsWith("/")) s = s.slice(1);
    const parts = s.split("/").filter(Boolean);
    if (parts.length === 1) return { dashboard: currentDashboard, view: parts[0] };
    const [dash, view, ...rest] = parts;
    if (!view || rest.length > 0) return null;
    return { dashboard: dash === "current" ? currentDashboard : dash, view };
  }


  // traverses nested shadowRoots to locate the main <hui-root> element of lovelace
  _getHuiRoot() {
    return document
      .querySelector("home-assistant")?.shadowRoot
      ?.querySelector("home-assistant-main")?.shadowRoot
      ?.querySelector("ha-panel-lovelace")?.shadowRoot
      ?.querySelector("hui-root");
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
