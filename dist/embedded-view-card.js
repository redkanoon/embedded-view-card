// Embedded View Card for Home Assistant
// Embeds a Lovelace view (from the current or any other dashboard) into a card.

import { VERSION } from "./version.js";
import { t as i18n } from "./i18n/index.js";

const LOG_PREFIX = "[embedded-view-card]";
const CURRENT = "__current__";          // editor sentinel for "current dashboard"
const DEFAULT_DASHBOARD = "lovelace";   // url_path of the legacy default dashboard
const MAX_NESTING = 5;                  // max depth of nested embedded-view-cards
const STRATEGY_WAIT_MS = 5000;

const MDI_DELETE =
  "M19,4H15.5L14.5,3H9.5L8.5,4H5V6H19M6,19A2,2 0 0,0 8,21H16A2,2 0 0,0 18,19V7H6V19Z";


// ── Shared utilities (used by card and editor) ───────────────────────────────

// locate the <hui-root> of the panel the user is currently looking at
function getHuiRoot() {
  const main = document
    .querySelector("home-assistant")?.shadowRoot
    ?.querySelector("home-assistant-main")?.shadowRoot;
  if (!main) return null;
  for (const panel of ["ha-panel-lovelace", "ha-panel-home", "ha-panel-energy"]) {
    const root = main.querySelector(panel)?.shadowRoot?.querySelector("hui-root");
    if (root) return root;
  }
  // newer frontends wrap panels in partial-panel-resolver / ha-drawer
  const resolver = main.querySelector("ha-drawer partial-panel-resolver, partial-panel-resolver");
  const panel = resolver?.querySelector("ha-panel-lovelace, ha-panel-home, ha-panel-energy");
  return panel?.shadowRoot?.querySelector("hui-root") || null;
}

// url path of the dashboard currently shown ("lovelace" for the legacy default dashboard)
function getCurrentDashboard(root = getHuiRoot()) {
  const lovelace = root?.lovelace;
  if (!lovelace) return null;
  return lovelace.urlPath || DEFAULT_DASHBOARD;
}

function normalizeDashboard(dash, currentDashboard) {
  if (dash === undefined || dash === null) return currentDashboard;
  const d = String(dash).trim().replace(/^\/+|\/+$/g, "");
  if (!d || d === "current" || d === CURRENT) return currentDashboard;
  return d;
}

function escapeHtml(str) {
  return String(str ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

// parse "dashboard/view", "/dashboard/view", "current/view", "view", "/view"
function parseDashboardViewString(value, currentDashboard) {
  if (typeof value !== "string") return null;
  const parts = value.trim().replace(/^\/+/, "").split("/").filter(Boolean).map((p) => {
    try { return decodeURIComponent(p); } catch { return p; }
  });
  if (parts.length === 0) return null;
  if (parts.length === 1) return { dashboard: currentDashboard, view: parts[0] };
  if (parts.length === 2) return { dashboard: normalizeDashboard(parts[0], currentDashboard), view: parts[1] };
  return null;
}

// "0", "1", ... or "index-0" style -> number, otherwise null
function convertToIndex(path) {
  if (typeof path === "number" && Number.isInteger(path)) return path;
  if (typeof path !== "string") return null;
  const m = path.match(/^(?:index-)?(\d+)$/);
  return m ? Number(m[1]) : null;
}

// find a view by path, falling back to an index
function findViewIndex(views, viewKey) {
  if (!Array.isArray(views) || viewKey === undefined || viewKey === null || viewKey === "") return -1;
  const key = String(viewKey);
  const byPath = views.findIndex((v) => v?.path !== undefined && String(v.path) === key);
  if (byPath >= 0) return byPath;
  const idx = convertToIndex(key);
  return idx !== null && idx >= 0 && idx < views.length ? idx : -1;
}

// a view is hidden for a user when `visible` is a list of users and the user is not part of it.
// `visible: false` (hidden tab) is intentionally NOT treated as hidden: hidden views are a
// common building block for embedding.
function isViewVisibleToUser(view, hass) {
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

function viewLabel(view, index, hass) {
  const title = view?.title ?? view?.name;
  if (title) return String(title);
  if (view?.path) return String(view.path);
  const strat = view?.strategy?.type;
  if (strat) return `${strat} (#${index})`;
  return index === 0 ? (hass?.localize?.("ui.panel.lovelace.views.home") || "Home") : `Index ${index}`;
}

function stripCustom(type) {
  return String(type ?? "").trim().replace(/^custom:/, "");
}

// remove cards of the given types (recursively, e.g. a navbar card that also lives in the host view)
function filterCardTypes(node, types) {
  if (Array.isArray(node)) {
    return node
      .filter((c) => !(c && typeof c === "object" && typeof c.type === "string" && types.has(stripCustom(c.type))))
      .map((c) => filterCardTypes(c, types));
  }
  if (node && typeof node === "object") {
    const out = {};
    for (const [k, v] of Object.entries(node)) {
      out[k] = (v && typeof v === "object") ? filterCardTypes(v, types) : v;
    }
    return out;
  }
  return node;
}

// collect the card types used in a view (for the editor's exclude list)
function collectCardTypes(node, set = new Set()) {
  if (Array.isArray(node)) {
    node.forEach((n) => collectCardTypes(n, set));
  } else if (node && typeof node === "object") {
    const cards = [...(Array.isArray(node.cards) ? node.cards : []), ...(node.card && typeof node.card === "object" ? [node.card] : [])];
    for (const c of cards) {
      if (c && typeof c.type === "string") set.add(c.type);
      collectCardTypes(c, set);
    }
    if (Array.isArray(node.sections)) collectCardTypes(node.sections, set);
  }
  return set;
}

function waitFor(fn, timeout = 8000, message = "Timeout", timers) {
  const start = performance.now();
  return new Promise((resolve, reject) => {
    let id;
    const tick = () => {
      timers?.delete(id);
      try {
        const v = fn();
        if (v) return resolve(v);
      } catch (_) { /* ignore */ }
      if (performance.now() - start > timeout) return reject(new Error(message));
      id = setTimeout(tick, 100);
      timers?.add(id);
    };
    tick();
  });
}


// ── Dashboard list (for the editor) ──────────────────────────────────────────

// every dashboard the user can open: storage/yaml dashboards, the legacy default
// dashboard, the built-in map / home / energy dashboards, ...
function listDashboards(hass) {
  const panels = hass?.panels || {};
  const isAdmin = !!hass?.user?.is_admin;
  const list = [];

  for (const [key, p] of Object.entries(panels)) {
    const comp = p?.component_name || p?.component;
    const urlPath = (typeof p?.url_path === "string" && p.url_path.length) ? p.url_path : key;
    const isLovelace = comp === "lovelace";
    const isBuiltinStrategy = (comp === "home" || comp === "energy") && (urlPath === "home" || urlPath === "energy");
    if (!isLovelace && !isBuiltinStrategy) continue;
    if (p.require_admin && !isAdmin) continue;

    let title = p.title ? String(p.title) : "";
    if (title) {
      const localized = hass?.localize?.(`panel.${title}`);
      if (localized) title = localized;
    } else if (urlPath === DEFAULT_DASHBOARD) {
      title = hass?.localize?.("panel.states") || "Overview";
    }
    list.push({ value: urlPath, label: title ? `${title} (${urlPath})` : urlPath });
  }

  const seen = new Set();
  return list
    .filter((d) => !seen.has(d.value) && seen.add(d.value))
    .sort((a, b) => a.label.localeCompare(b.label, undefined, { sensitivity: "base" }));
}


// ── Dashboard config loading (shared cache, strategies) ──────────────────────

const _configCache = new Map(); // dashboard -> Promise<config>
let _updatesSubscribed = false;

function subscribeLovelaceUpdates(hass) {
  if (_updatesSubscribed || !hass?.connection?.subscribeEvents) return;
  _updatesSubscribed = true;
  hass.connection.subscribeEvents((ev) => {
    const url = ev?.data?.url_path || DEFAULT_DASHBOARD;
    _configCache.delete(url);
    if (url === DEFAULT_DASHBOARD) _configCache.delete(null);
    window.dispatchEvent(new CustomEvent("embedded-view-card-config-updated", { detail: { dashboard: url } }));
  }, "lovelace_updated").catch(() => { _updatesSubscribed = false; });
}

async function fetchRawConfig(hass, dashboard) {
  if (dashboard === "home") return { strategy: { type: "home", home_panel: true } };
  if (dashboard === "energy") return { strategy: { type: "energy" } };

  const call = (urlPath) => hass.callWS({ type: "lovelace/config", url_path: urlPath, force: false });
  try {
    return await call(dashboard);
  } catch (err) {
    // the legacy default dashboard is addressed with url_path=null on older HA versions
    if (dashboard === DEFAULT_DASHBOARD && err?.code !== "config_not_found") {
      try { return await call(null); } catch (err2) { err = err2; }
    }
    // storage dashboard without saved config -> HA auto-generates it
    if (err?.code === "config_not_found") return { strategy: { type: "original-states" } };
    throw new Error(`Failed to fetch dashboard config "${dashboard}": ${err?.message || err}`);
  }
}

async function getStrategyElement(type) {
  if (type.startsWith("custom:")) {
    const name = type.slice(7);
    const tags = [`ll-strategy-dashboard-${name}`, `ll-strategy-${name}`];
    const found = () => tags.map((t) => customElements.get(t)).find(Boolean);
    if (!found()) {
      await Promise.race([
        ...tags.map((t) => customElements.whenDefined(t)),
        new Promise((r) => setTimeout(r, STRATEGY_WAIT_MS)),
      ]);
    }
    return found();
  }
  return customElements.get(`${type}-dashboard-strategy`);
}

// fallbacks for built-in dashboard strategies whose code is not loaded in this browser session
function builtinDashboardStrategyFallback(cfg, hass) {
  const type = cfg.type;
  const areas = Object.values(hass?.areas || {});

  switch (type) {
    case "original-states":
    case "map":
    case "iframe":
      return { views: [{ strategy: cfg }] };

    case "areas": {
      const hidden = new Set(cfg.areas_display?.hidden || []);
      const order = cfg.areas_display?.order || [];
      const sorted = areas
        .filter((a) => !hidden.has(a.area_id))
        .sort((a, b) => {
          const ia = order.indexOf(a.area_id), ib = order.indexOf(b.area_id);
          return (ia < 0 ? 1e9 : ia) - (ib < 0 ? 1e9 : ib);
        });
      return {
        views: [
          { icon: "mdi:home", path: "home", strategy: { type: "areas-overview", areas_display: cfg.areas_display, areas_options: cfg.areas_options, floors_display: cfg.floors_display } },
          ...sorted.map((a) => ({
            title: a.name, path: `areas-${a.area_id}`, subview: true,
            strategy: { type: "area", area: a.area_id, groups_options: cfg.areas_options?.[a.area_id]?.groups_options },
          })),
        ],
      };
    }

    case "home":
      return {
        views: [
          { icon: "mdi:home", path: "overview", strategy: { ...cfg, type: "home-overview" } },
          ...areas.map((a) => ({
            title: a.name, path: `areas-${a.area_id}`, subview: true,
            strategy: { type: "home-area", area: a.area_id, home_panel: cfg.home_panel },
          })),
          { title: hass?.localize?.("ui.panel.lovelace.strategy.home.media_players") || "Media players", path: "media-players", subview: true, strategy: { type: "home-media-players" } },
          { title: hass?.localize?.("ui.panel.lovelace.strategy.home.devices") || "Devices", path: "other-devices", subview: true, strategy: { type: "home-other-devices", home_panel: cfg.home_panel } },
        ],
      };

    case "energy": {
      const t = (p, fb) => hass?.localize?.(`ui.panel.energy.title.${p}`) || fb;
      return {
        views: [
          { path: "overview", title: t("overview", "Overview"), strategy: { type: "energy-overview"  } },
          { path: "electricity", title: t("electricity", "Electricity"), strategy: { type: "energy"  } },
          { path: "water", title: t("water", "Water"), strategy: { type: "water"  } },
          { path: "gas", title: t("gas", "Gas"), strategy: { type: "gas"  } },
          { path: "now", title: t("now", "Now"), strategy: { type: "power"  } },
        ],
      };
    }

    default:
      return null;
  }
}

async function generateDashboardStrategy(rawConfig, hass) {
  let cfg = rawConfig.strategy || {};
  // legacy { type, options } format
  if (Object.keys(cfg).length === 2 && cfg.options && typeof cfg.options === "object") {
    cfg = { type: cfg.type, ...cfg.options };
  }
  const type = String(cfg.type || "");
  if (!type) throw new Error("Dashboard strategy without type");

  const el = await getStrategyElement(type);
  if (el) {
    if (typeof el.generateDashboard === "function") {
      return el.generateDashboard({ config: { strategy: rawConfig.strategy, views: [] }, hass });
    }
    if (typeof el.generate === "function") return el.generate(cfg, hass);
  }

  const fallback = builtinDashboardStrategyFallback(cfg, hass);
  if (fallback) return fallback;
  throw new Error(`Dashboard strategy "${type}" is not available`);
}

// load the (generated) config of any dashboard; cached and deduplicated
function loadDashboardConfig(hass, dashboard, { force = false } = {}) {
  subscribeLovelaceUpdates(hass);
  if (!force && _configCache.has(dashboard)) return _configCache.get(dashboard);

  const promise = (async () => {
    const raw = await fetchRawConfig(hass, dashboard);
    if (raw && raw.strategy && !Array.isArray(raw.views)) {
      const generated = await generateDashboardStrategy(raw, hass);
      return { ...generated, __raw: raw };
    }
    return raw;
  })();
  _configCache.set(dashboard, promise);
  promise.catch(() => { if (_configCache.get(dashboard) === promise) _configCache.delete(dashboard); });
  return promise;
}

function makeLovelace(config, urlPath, hass, base) {
  return {
    ...(base || {}),
    config,
    rawConfig: config?.__raw || config,
    urlPath,
    mode: base?.mode || "storage",
    editMode: false,
    locale: hass?.locale,
    enableFullEditMode: () => {},
    setEditMode: () => {},
    saveConfig: async () => {},
    deleteConfig: async () => {},
    showToast: () => {},
  };
}


// ── Card ─────────────────────────────────────────────────────────────────────

class EmbeddedViewCard extends HTMLElement {

  constructor() {
    super();
    this.attachShadow({ mode: "open" });

    this._hass = undefined;
    this._config = {};
    this._activeViewElement = null;
    this._renderedKey = null;      // "dashboard/view" currently rendered
    this._pendingKey = null;       // "dashboard/view" currently being rendered
    this._renderToken = 0;
    this._lastError = null;
    this._rootConfigRef = null;    // live config reference for current-dashboard embeds
    this._waitingForRoot = false;
    this._timers = new Set();

    this._container = document.createElement("div");
    this._container.style.display = "contents";
    this._inner = document.createElement("div");
    this._inner.className = "inner";

    this._onLocationChange = this._onLocationChange.bind(this);
    this._onConfigUpdated = this._onConfigUpdated.bind(this);
  }

  connectedCallback() {
    window.addEventListener("hashchange", this._onLocationChange);
    window.addEventListener("popstate", this._onLocationChange);
    window.addEventListener("location-changed", this._onLocationChange);
    window.addEventListener("embedded-view-card-config-updated", this._onConfigUpdated);
    if (this._hass) this._update();
  }

  disconnectedCallback() {
    window.removeEventListener("hashchange", this._onLocationChange);
    window.removeEventListener("popstate", this._onLocationChange);
    window.removeEventListener("location-changed", this._onLocationChange);
    window.removeEventListener("embedded-view-card-config-updated", this._onConfigUpdated);
    for (const id of this._timers) clearTimeout(id);
    this._timers.clear();
    this._waitingForRoot = false;
  }

  _onLocationChange() {
    if (this._config.mode === "hash" && this._hass) this._update();
  }

  _onConfigUpdated(ev) {
    const dash = ev?.detail?.dashboard;
    const k = this._renderedKey || this._failed?.key;
    if (k && dash && k.startsWith(dash + "/")) {
      this._renderedKey = null;
      this._failed = null;
      if (this._hass) this._update();
    }
  }

  setConfig(config) {
    if (!config || typeof config !== "object") throw new Error("Invalid configuration");

    this._config = {
      mode: "static",
      dashboard: undefined,
      view: undefined,
      view_path: undefined,         // legacy (read-only)
      target_entity: undefined,
      view_path_entity: undefined,  // legacy (read-only)
      default: undefined,
      states: {},
      exclude_cards: [],
      ha_card: true,
      bleed: false,
      bleed_inline: 16,
      bleed_block: 8,
      ...config,
    };

    if (this._config.view_path_entity && !this._config.target_entity) {
      this._config.mode = "dynamic";
      this._config.target_entity = this._config.view_path_entity;
    }

    this.shadowRoot.innerHTML = "";
    const style = document.createElement("style");
    style.textContent = `
      :host { display: block; }
      .inner { margin: 0; }
      hui-view, hui-view-container { display: block; }
    `;
    this.shadowRoot.appendChild(style);

    this._container.replaceChildren();
    this._inner.replaceChildren();
    this._activeViewElement = null;
    this._renderedKey = null;
    this._pendingKey = null;
    this._failed = null;
    this._lastError = null;

    if (this._config.ha_card !== false) {
      const card = document.createElement("ha-card");
      card.style.overflow = "hidden";
      card.appendChild(this._container);
      this.shadowRoot.appendChild(card);
    } else {
      this.shadowRoot.appendChild(this._container);
    }

    const bleedOn = this._config.ha_card === false && this._config.bleed === true;
    const bleedInline = Number.isFinite(Number(this._config.bleed_inline)) ? Number(this._config.bleed_inline) : 16;
    const bleedBlock = Number.isFinite(Number(this._config.bleed_block)) ? Number(this._config.bleed_block) : 8;
    this._inner.style.marginInline = bleedOn ? `-${bleedInline}px` : "0";
    this._inner.style.marginBlock = bleedOn ? `-${bleedBlock}px` : "0";

    this._container.appendChild(this._inner);
    if (this._hass) this._update();
  }

  set hass(hass) {
    this._hass = hass;
    this._update();
  }

  get hass() { return this._hass; }

  // resolve the target (dashboard + view) and (re)render if needed
  _update() {
    const hass = this._hass;
    if (!hass || !this._config) return;

    const root = getHuiRoot();
    const currentDashboard = getCurrentDashboard(root);

    // wait until the panel is ready (needed to resolve "current dashboard")
    if (!currentDashboard) {
      if (!this._waitingForRoot) {
        this._waitingForRoot = true;
        waitFor(() => getHuiRoot()?.lovelace, 15000, "hui-root not found", this._timers)
          .then(() => { this._waitingForRoot = false; this._update(); })
          .catch(() => {
            this._waitingForRoot = false;
            this._showError(this._t("Error loading view") + ": dashboard not ready");
          });
      }
      return;
    }

    const target = this._resolveTarget(hass, currentDashboard);
    if (!target) return; // error already shown

    const { dashboard, view } = target;
    const key = `${dashboard}/${view}`;
    const isCurrent = dashboard === currentDashboard;

    // current dashboard edited -> re-render
    if (isCurrent && this._renderedKey === key && root?.lovelace?.config !== this._rootConfigRef) {
      this._renderedKey = null;
    }

    if (this._renderedKey === key && this._activeViewElement) {
      this._activeViewElement.hass = hass;
      if (this._viewContainer) this._viewContainer.hass = hass;
      const narrow = !!root?.narrow;
      if (this._activeViewElement.narrow !== narrow) this._activeViewElement.narrow = narrow;
      return;
    }
    if (this._pendingKey === key) return;

    // don't retry a failed target on every state update (only when target or host config changes)
    const rootRef = isCurrent ? root?.lovelace?.config : null;
    if (this._failed && this._failed.key === key && this._failed.rootRef === rootRef) return;
    this._failed = null;

    this._pendingKey = key;
    this._renderTarget(dashboard, view, isCurrent, root, currentDashboard, key)
      .catch((err) => this._showError(this._t("Error loading view") + ": " + escapeHtml(err?.message || err)))
      .finally(() => {
        if (this._pendingKey !== key) return;
        this._pendingKey = null;
        if (this._renderedKey !== key) this._failed = { key, rootRef };
      });
  }

  _resolveTarget(hass, currentDashboard) {
    const mode = ["dynamic", "hash"].includes(this._config.mode) ? this._config.mode : "static";

    if (mode === "hash") {
      const segments = window.location.pathname.split("/").filter(Boolean);
      const hashValue = decodeURIComponent(window.location.hash.replace(/^#/, ""));
      const pathValue = segments.length > 2 ? decodeURIComponent(segments[segments.length - 1]) : "";
      const states = this._config.states || {};
      let current = "";
      if (hashValue && states[hashValue]) current = hashValue;
      else if (pathValue && states[pathValue]) current = pathValue;
      else current = this._config.default || hashValue || pathValue || "";

      if (!current) {
        this._showError(this._t("Missing configuration") + ": " + this._t("no URL hash, path segment or default value"));
        return null;
      }
      const state = states[current];
      if (!state) {
        this._showError(this._t("No matching state for hash") + ": " + escapeHtml(current));
        return null;
      }
      const v = state.view ?? state.view_path;
      if (v === undefined || v === null || v === "") {
        this._showError(this._t("Missing configuration") + ": " + this._t("no view for hash") + ` "${escapeHtml(current)}"`);
        return null;
      }
      return { dashboard: normalizeDashboard(state.dashboard, currentDashboard), view: String(v) };
    }

    if (mode === "dynamic") {
      const entity = this._config.target_entity;
      const value = entity ? hass.states?.[entity]?.state : undefined;
      if (!value || value === "unknown" || value === "unavailable") {
        this._showError(this._t("Missing configuration") + ": " + this._t("no target_entity or empty entity"));
        return null;
      }
      const parsed = parseDashboardViewString(value, currentDashboard);
      if (!parsed || !parsed.dashboard || !parsed.view) {
        this._showError(this._t("Invalid dynamic target") + ": " + escapeHtml(value));
        return null;
      }
      return parsed;
    }

    const v = this._config.view ?? this._config.view_path;
    if (v === undefined || v === null || v === "") {
      this._showError(this._t("Missing configuration") + ": " + this._t("no view"));
      return null;
    }
    return { dashboard: normalizeDashboard(this._config.dashboard, currentDashboard), view: String(v) };
  }

  // keys of all embedded-view-card ancestors (crossing shadow roots)
  _ancestorKeys() {
    const keys = [];
    let node = this;
    while (node) {
      node = node.parentNode || node.host || null;
      if (node instanceof EmbeddedViewCard) keys.push(node._renderedKey || node._pendingKey);
    }
    return keys;
  }

  async _renderTarget(dashboard, viewKey, isCurrent, root, currentDashboard, key) {
    const token = ++this._renderToken;
    const hass = this._hass;

    // loop guard: an ancestor embedded card already renders this target or nesting is too deep
    const ancestors = this._ancestorKeys();
    if (ancestors.includes(key) || ancestors.length >= MAX_NESTING) {
      this._showError(this._t("Recursive embedding detected") + ": " + escapeHtml(key));
      return;
    }

    let config;
    let base;
    if (isCurrent) {
      const r = root?.lovelace ? root : await waitFor(() => getHuiRoot()?.lovelace && getHuiRoot(), 10000, "hui-root not found", this._timers);
      base = r.lovelace;
      config = base.config;
    } else {
      config = await loadDashboardConfig(hass, dashboard);
    }
    if (token !== this._renderToken) return;

    let views = Array.isArray(config?.views) ? config.views : [];
    let index = findViewIndex(views, viewKey);

    // view not found in cached config -> refetch once
    if (index < 0 && !isCurrent) {
      config = await loadDashboardConfig(hass, dashboard, { force: true });
      if (token !== this._renderToken) return;
      views = Array.isArray(config?.views) ? config.views : [];
      index = findViewIndex(views, viewKey);
    }
    if (index < 0) {
      this._showError(this._t("View not found") + ": " + escapeHtml(`${dashboard}/${viewKey}`));
      return;
    }

    // self embedding (host view embeds itself)
    if (isCurrent && dashboard === currentDashboard) {
      const segments = window.location.pathname.split("/").filter(Boolean);
      const di = segments.indexOf(dashboard);
      const urlView = di >= 0 && segments[di + 1] !== undefined ? decodeURIComponent(segments[di + 1]) : null;
      const hostIndex = urlView === null ? 0 : findViewIndex(views, urlView);
      if (hostIndex === index && !this._isInsideEditorPreview()) {
        this._showError(
          this._t("Self embedding not allowed") +
          ":<br>host view = " + escapeHtml(`${currentDashboard}/${urlView ?? 0}`) +
          "<br>embedding view = " + escapeHtml(`${dashboard}/${viewKey}`)
        );
        return;
      }
    }

    const view = views[index];
    if (!isViewVisibleToUser(view, hass)) {
      this._showError(this._t("View not visible for this user"));
      return;
    }

    if (!customElements.get("hui-view")) {
      await Promise.race([
        customElements.whenDefined("hui-view"),
        new Promise((_, rej) => setTimeout(() => rej(new Error("hui-view not available")), 10000)),
      ]);
      if (token !== this._renderToken) return;
    }

    // optional: drop cards that are already present in the host view (e.g. navbars)
    const exclude = (Array.isArray(this._config.exclude_cards) ? this._config.exclude_cards : [this._config.exclude_cards])
      .filter(Boolean).map(stripCustom);
    let finalConfig = config;
    if (exclude.length) {
      const set = new Set(exclude);
      const newViews = views.slice();
      newViews[index] = filterCardTypes(view, set);
      finalConfig = { ...config, views: newViews };
    }

    const lovelace = makeLovelace(finalConfig, dashboard, hass, base);

    const huiview = document.createElement("hui-view");
    huiview.hass = hass;
    huiview.narrow = !!root?.narrow;
    huiview.lovelace = lovelace;
    huiview.index = index;

    // apply the theme of the embedded view
    let mount = huiview;
    this._viewContainer = null;
    if (view?.theme && customElements.get("hui-view-container")) {
      const container = document.createElement("hui-view-container");
      container.hass = hass;
      container.theme = view.theme;
      container.appendChild(huiview);
      this._viewContainer = container;
      mount = container;
    }

    this._inner.replaceChildren(mount);
    this._activeViewElement = huiview;
    this._lastError = null;
    this._renderedKey = key;
    this._rootConfigRef = isCurrent ? config : null;
  }

  _isInsideEditorPreview() {
    let node = this;
    while (node) {
      if (node.localName === "hui-card-preview" || node.localName === "hui-dialog-edit-card") return true;
      node = node.parentNode || node.host || null;
    }
    return false;
  }

  _showError(msg) {
    this._renderToken++; // cancel running renders
    this._activeViewElement = null;
    this._viewContainer = null;
    this._renderedKey = null;
    if (this._lastError === msg) return;
    this._lastError = msg;
    this._inner.innerHTML = `<hui-warning>${msg}</hui-warning>`;
  }

  getCardSize() {
    return 6;
  }

  static getConfigElement() { return document.createElement("embedded-view-card-editor"); }

  static getStubConfig() { return { type: "custom:embedded-view-card", view: "" }; }

  _t(key, vars) { return i18n(this._hass, key, vars); }
}
customElements.define("embedded-view-card", EmbeddedViewCard);


// ── Editor ───────────────────────────────────────────────────────────────────

class EmbeddedViewCardEditor extends HTMLElement {

  constructor() {
    super();
    this._hass = undefined;
    this._config = {};
    this._dashboards = [];
    this._viewCache = {};      // dashboard -> { loading, views: [{value,label}], types: [] }
    this._built = false;
    this._stateRows = [];
  }

  setConfig(config) {
    const normalized = this._normalizeConfig(config || {});
    const changed = JSON.stringify(normalized) !== JSON.stringify(config || {});
    this._config = normalized;
    if (changed) this._fireChanged();
    this._update();
  }

  set hass(hass) {
    const first = !this._hass;
    this._hass = hass;
    if (first || hass?.panels !== this._panelsRef || hass?.language !== this._langRef) {
      this._panelsRef = hass?.panels;
      this._langRef = hass?.language;
      this._dashboards = listDashboards(hass);
      this._update();
      return;
    }
    // cheap path for state updates: only forward hass
    if (!this._built) return;
    this._mainForm.hass = hass;
    this._appearanceForm.hass = hass;
    for (const r of this._stateRows) r.form.hass = hass;
    if ((this._config.mode || "static") === "dynamic") this._renderDynamicHint();
  }

  // ---- helpers

  _t(key, vars) { return i18n(this._hass, key, vars); }

  _currentDashboard() {
    return getCurrentDashboard() || DEFAULT_DASHBOARD;
  }

  _dashKey(dash) {
    return normalizeDashboard(dash, this._currentDashboard());
  }

  _ensureViews(dash) {
    const key = this._dashKey(dash);
    if (this._viewCache[key]) return this._viewCache[key];
    const entry = { loading: true, views: [], types: {} };
    this._viewCache[key] = entry;

    (async () => {
      let config;
      const root = getHuiRoot();
      if (key === getCurrentDashboard(root) && root?.lovelace?.config) config = root.lovelace.config;
      else config = await loadDashboardConfig(this._hass, key);
      const views = Array.isArray(config?.views) ? config.views : [];
      entry.views = views.map((v, i) => ({
        value: v?.path !== undefined && v?.path !== null && v?.path !== "" ? String(v.path) : String(i),
        label: `${viewLabel(v, i, this._hass)}${v?.path ? ` (${v.path})` : ` (#${i})`}${isViewVisibleToUser(v, this._hass) ? "" : " 🔒"}`,
      }));
      views.forEach((v, i) => {
        const value = entry.views[i].value;
        entry.types[value] = v?.strategy ? [] : [...collectCardTypes(v)];
      });
    })()
      .catch((err) => { entry.error = err?.message || String(err); console.warn(LOG_PREFIX, "loading views failed", err); })
      .finally(() => { entry.loading = false; this._update(); });

    return entry;
  }

  _dashboardOptions(selected) {
    const opts = [{ value: CURRENT, label: this._t("(current dashboard)") + ` – ${this._currentDashboard()}` }, ...this._dashboards];
    if (selected && selected !== CURRENT && !opts.some((o) => o.value === selected)) {
      opts.push({ value: selected, label: selected });
    }
    return opts;
  }

  _viewOptions(dash, selected) {
    const entry = this._ensureViews(dash);
    const opts = entry.views.slice();
    if (selected !== undefined && selected !== null && selected !== "" && !opts.some((o) => o.value === String(selected))) {
      opts.unshift({ value: String(selected), label: String(selected) });
    }
    return opts;
  }

  _viewHelper(dash) {
    const entry = this._ensureViews(dash);
    if (entry.loading) return this._t("Loading views…");
    if (entry.error) return this._t("Error loading view") + ": " + entry.error;
    if (!entry.views.length) return this._t("No views found");
    return undefined;
  }

  _computeLabel = (schema) => {
    const labels = {
      mode: this._t("Mode"),
      dashboard: this._t("Choose a dashboard"),
      view: this._t("Choose a view"),
      target_entity: this._t('Target entity (state: "dashboard/view")'),
      default: this._t("Default hash value (fallback)"),
      ha_card: this._t("Wrap in ha-card"),
      bleed: this._t("Remove outer padding (bleed)"),
      bleed_inline: this._t("Bleed inline (px, left/right)"),
      bleed_block: this._t("Bleed block (px, top/bottom)"),
      exclude_cards: this._t("Hide card types from embedded view"),
      appearance: this._t("Appearance"),
      key: this._t("Hash key"),
    };
    return labels[schema.name] ?? schema.name;
  };

  _computeHelper = (schema) => {
    if (schema.name === "view" && this._config.mode !== "hash") return this._viewHelper(this._config.dashboard);
    if (schema.name === "exclude_cards") return this._t("e.g. custom:navbar-card – removes cards that the host view already shows");
    return undefined;
  };

  // ---- schema

  _mainSchema() {
    const mode = this._config.mode || "static";
    const schema = [{
      name: "mode",
      required: true,
      selector: { select: { mode: "dropdown", options: [
        { value: "static", label: this._t("Static") },
        { value: "dynamic", label: this._t("Dynamic (entity)") },
        { value: "hash", label: this._t("Hash (URL hash)") },
      ] } },
    }];

    if (mode === "static") {
      const dash = this._config.dashboard || CURRENT;
      schema.push(
        { name: "dashboard", selector: { select: { mode: "dropdown", options: this._dashboardOptions(dash) } } },
        { name: "view", selector: { select: { mode: "dropdown", custom_value: true, options: this._viewOptions(this._config.dashboard, this._config.view) } } },
      );
    } else if (mode === "dynamic") {
      schema.push({ name: "target_entity", selector: { entity: { domain: ["input_text", "input_select", "select", "sensor", "text"] } } });
    } else {
      schema.push({ name: "default", selector: { text: {} } });
    }
    return schema;
  }

  _appearanceSchema() {
    const schema = [{ name: "ha_card", selector: { boolean: {} } }];
    if (this._config.ha_card === false) {
      schema.push({ name: "bleed", selector: { boolean: {} } });
      if (this._config.bleed === true) {
        schema.push(
          { name: "bleed_inline", selector: { number: { min: 0, max: 64, step: 1, mode: "box", unit_of_measurement: "px" } } },
          { name: "bleed_block", selector: { number: { min: 0, max: 64, step: 1, mode: "box", unit_of_measurement: "px" } } },
        );
      }
    }
    // card types of the selected static view as suggestions
    let suggestions = [];
    if ((this._config.mode || "static") === "static" && this._config.view) {
      const entry = this._ensureViews(this._config.dashboard);
      suggestions = entry.types[String(this._config.view)] || [];
    }
    const selected = this._config.exclude_cards || [];
    const opts = [...new Set([...suggestions, ...selected])].map((v) => ({ value: v, label: v }));
    schema.push({ name: "exclude_cards", selector: { select: { multiple: true, custom_value: true, mode: "dropdown", options: opts } } });
    return [{ name: "appearance", type: "expandable", flatten: true, icon: "mdi:palette", schema }];
  }

  _mainData() {
    return {
      mode: this._config.mode || "static",
      dashboard: this._config.dashboard || CURRENT,
      view: this._config.view ?? "",
      target_entity: this._config.target_entity || "",
      default: this._config.default || "",
    };
  }

  _appearanceData() {
    return {
      ha_card: this._config.ha_card !== false,
      bleed: this._config.bleed === true,
      bleed_inline: Number.isFinite(this._config.bleed_inline) ? this._config.bleed_inline : 16,
      bleed_block: Number.isFinite(this._config.bleed_block) ? this._config.bleed_block : 8,
      exclude_cards: this._config.exclude_cards || [],
    };
  }

  // ---- DOM

  _build() {
    if (this._built) return;
    this._built = true;

    const style = document.createElement("style");
    style.textContent = `
      .evc-wrap { display: flex; flex-direction: column; gap: 12px; }
      .evc-hint { opacity: .85; font-size: 13px; line-height: 1.4; }
      .evc-hint code { font-size: 12px; }
      .evc-preview { font-family: monospace; padding: 8px 10px; border: 1px solid var(--divider-color); border-radius: 8px; }
      .evc-states { display: flex; flex-direction: column; gap: 12px; }
      .evc-state { border: 1px solid var(--divider-color); border-radius: 8px; padding: 8px 8px 8px 12px; display: flex; gap: 4px; align-items: flex-start; }
      .evc-state ha-form { flex: 1; }
      .evc-title { font-weight: 600; }
      .evc-add { align-self: flex-start; background: var(--primary-color); color: var(--text-primary-color, #fff); border: none; border-radius: 18px; padding: 8px 16px; cursor: pointer; font-weight: 500; font-size: 14px; }
      .evc-remove { background: none; border: none; color: var(--error-color); cursor: pointer; padding: 8px; border-radius: 50%; line-height: 0; }
      .evc-remove:hover { background: rgba(220,53,69,.1); }
      .evc-warn { padding: 6px 8px; border-radius: 6px; font-size: 13px; background: rgba(var(--rgb-warning-color, 255,166,0), .12); }
    `;

    this._wrap = document.createElement("div");
    this._wrap.className = "evc-wrap";

    this._mainForm = document.createElement("ha-form");
    this._mainForm.computeLabel = this._computeLabel;
    this._mainForm.computeHelper = this._computeHelper;
    this._mainForm.addEventListener("value-changed", (ev) => this._mainChanged(ev));

    this._dynamicHint = document.createElement("div");
    this._dynamicHint.className = "evc-hint";

    this._hashSection = document.createElement("div");
    this._hashSection.className = "evc-wrap";
    const statesTitle = document.createElement("div");
    statesTitle.className = "evc-title";
    this._statesTitle = statesTitle;
    this._statesWrap = document.createElement("div");
    this._statesWrap.className = "evc-states";
    this._addBtn = document.createElement("button");
    this._addBtn.className = "evc-add";
    this._addBtn.type = "button";
    this._addBtn.addEventListener("click", () => this._addState());
    this._hashHint = document.createElement("div");
    this._hashHint.className = "evc-hint";
    this._hashSection.append(statesTitle, this._statesWrap, this._addBtn, this._hashHint);

    this._appearanceForm = document.createElement("ha-form");
    this._appearanceForm.computeLabel = this._computeLabel;
    this._appearanceForm.computeHelper = this._computeHelper;
    this._appearanceForm.addEventListener("value-changed", (ev) => this._appearanceChanged(ev));

    this._note = document.createElement("div");
    this._note.className = "evc-hint";

    this._wrap.append(this._mainForm, this._dynamicHint, this._hashSection, this._appearanceForm, this._note);
    this.replaceChildren(style, this._wrap);
  }

  _update() {
    if (!this._hass) return;
    this._build();
    const mode = this._config.mode || "static";

    this._mainForm.hass = this._hass;
    this._mainForm.schema = this._mainSchema();
    this._mainForm.data = this._mainData();

    this._appearanceForm.hass = this._hass;
    this._appearanceForm.schema = this._appearanceSchema();
    this._appearanceForm.data = this._appearanceData();

    // dynamic hint + preview
    this._dynamicHint.style.display = mode === "dynamic" ? "" : "none";
    if (mode === "dynamic") this._renderDynamicHint();

    // hash states
    this._hashSection.style.display = mode === "hash" ? "" : "none";
    if (mode === "hash") this._renderStates();

    this._note.textContent = this._t("Card renders the chosen (or dynamic) dashboard + view.");
  }

  _renderDynamicHint() {
    const entity = this._config.target_entity;
    const state = entity ? this._hass?.states?.[entity]?.state : undefined;
    const current = this._currentDashboard();
    const parsed = typeof state === "string" && state ? parseDashboardViewString(state, current) : null;
    const html = [
      `<div><strong>${escapeHtml(this._t("Expected format"))}:</strong> <code>dashboard/view</code></div>`,
      `<div>${escapeHtml(this._t("Examples"))}:</div>`,
      `<ul style="margin:4px 0 8px 16px;padding:0;">`,
      `<li><code>dashboard-rooms/kitchen</code></li>`,
      `<li><code>current/kitchen</code> ${escapeHtml(this._t("(uses current dashboard)"))}</li>`,
      `<li><code>/kitchen</code> ${escapeHtml(this._t("(interpreted as current/kitchen)"))}</li>`,
      `<li><code>current/0</code> ${escapeHtml(this._t("(first view by index)"))}</li>`,
      `</ul>`,
      `<div class="evc-preview">`,
      `<div><strong>${escapeHtml(this._t("Current value"))}:</strong> <code>${escapeHtml(state ?? "—")}</code></div>`,
      `<div><strong>${escapeHtml(this._t("Parsed to"))}:</strong> ${parsed
        ? `<code>${escapeHtml(parsed.dashboard)}/${escapeHtml(parsed.view)}</code>`
        : `<span style="color:var(--error-color);">${escapeHtml(this._t("invalid or empty"))}</span>`}</div>`,
      `</div>`,
    ].join("");
    if (this._dynamicHint.innerHTML !== html) this._dynamicHint.innerHTML = html;
  }

  _stateSchema(state) {
    const dash = state.dashboard || CURRENT;
    return [
      { name: "key", required: true, selector: { text: {} } },
      { type: "grid", name: "", schema: [
        { name: "dashboard", selector: { select: { mode: "dropdown", options: this._dashboardOptions(dash) } } },
        { name: "view", selector: { select: { mode: "dropdown", custom_value: true, options: this._viewOptions(state.dashboard, state.view) } } },
      ] },
    ];
  }

  _renderStates() {
    this._statesTitle.textContent = this._t("States (hash → view mapping)");
    this._addBtn.textContent = "+ " + this._t("Add state");
    this._hashHint.innerHTML = [
      `<div><strong>${escapeHtml(this._t("How it works"))}:</strong></div>`,
      `<ul style="margin:4px 0 0 16px;padding:0;">`,
      `<li>${escapeHtml(this._t("The card reads the URL hash (e.g., #climate) or extra path segment (e.g., /dashboard/view/climate)"))}</li>`,
      `<li>${escapeHtml(this._t("Matches it against the states map above"))}</li>`,
      `<li>${escapeHtml(this._t("Use navigate action in buttons to change the hash or path"))}</li>`,
      `</ul>`,
    ].join("");

    const entries = Object.entries(this._config.states || {});

    // keep row elements stable (focus!) – only add/remove rows when the count changes
    while (this._stateRows.length > entries.length) this._stateRows.pop().el.remove();
    while (this._stateRows.length < entries.length) {
      const index = this._stateRows.length;
      const el = document.createElement("div");
      el.className = "evc-state";
      const form = document.createElement("ha-form");
      form.computeLabel = (s) => (s.name === "dashboard" ? this._t("Dashboard") : s.name === "view" ? this._t("View") : this._computeLabel(s));
      form.addEventListener("value-changed", (ev) => this._stateChanged(index, ev.detail.value));
      const remove = document.createElement("button");
      remove.className = "evc-remove";
      remove.type = "button";
      remove.innerHTML = `<svg viewBox="0 0 24 24" width="20" height="20"><path fill="currentColor" d="${MDI_DELETE}"/></svg>`;
      remove.addEventListener("click", () => this._removeState(index));
      el.append(form, remove);
      this._statesWrap.appendChild(el);
      this._stateRows.push({ el, form, remove });
    }

    entries.forEach(([key, state], i) => {
      const row = this._stateRows[i];
      row.remove.title = this._t("Remove");
      row.form.hass = this._hass;
      row.form.schema = this._stateSchema(state || {});
      row.form.data = { key, dashboard: state?.dashboard || CURRENT, view: state?.view ?? "" };
    });
  }

  // ---- events

  _mainChanged(ev) {
    ev.stopPropagation();
    const v = ev.detail?.value || {};
    const cfg = { ...this._config };
    const prevMode = cfg.mode || "static";
    const mode = v.mode || "static";

    if (mode !== prevMode) {
      cfg.mode = mode;
      delete cfg.dashboard; delete cfg.view; delete cfg.view_path; delete cfg.view_path_entity;
      delete cfg.target_entity; delete cfg.states; delete cfg.default;
      if (mode === "hash") cfg.states = {};
    } else if (mode === "static") {
      const dash = v.dashboard && v.dashboard !== CURRENT ? v.dashboard : undefined;
      if (dash !== cfg.dashboard) {
        if (dash) cfg.dashboard = dash; else delete cfg.dashboard;
        cfg.view = "";
      } else {
        cfg.view = v.view ?? "";
      }
    } else if (mode === "dynamic") {
      if (v.target_entity) cfg.target_entity = v.target_entity; else delete cfg.target_entity;
    } else {
      if (v.default) cfg.default = v.default; else delete cfg.default;
    }
    this._setConfig(cfg);
  }

  _appearanceChanged(ev) {
    ev.stopPropagation();
    const v = ev.detail?.value || {};
    const cfg = { ...this._config };
    if (v.ha_card === false) cfg.ha_card = false; else delete cfg.ha_card;
    if (cfg.ha_card === false && v.bleed === true) cfg.bleed = true; else delete cfg.bleed;
    if (cfg.bleed && Number.isFinite(Number(v.bleed_inline)) && Number(v.bleed_inline) !== 16) cfg.bleed_inline = Number(v.bleed_inline); else delete cfg.bleed_inline;
    if (cfg.bleed && Number.isFinite(Number(v.bleed_block)) && Number(v.bleed_block) !== 8) cfg.bleed_block = Number(v.bleed_block); else delete cfg.bleed_block;
    const ex = Array.isArray(v.exclude_cards) ? v.exclude_cards.filter(Boolean) : [];
    if (ex.length) cfg.exclude_cards = ex; else delete cfg.exclude_cards;
    this._setConfig(cfg);
  }

  _stateChanged(index, value) {
    const entries = Object.entries(this._config.states || {});
    if (!entries[index]) return;
    const [oldKey, oldState] = entries[index];
    const newKey = (value.key ?? "").trim() || oldKey;
    if (newKey !== oldKey && entries.some(([k], i) => i !== index && k === newKey)) return; // duplicate
    const dash = value.dashboard && value.dashboard !== CURRENT ? value.dashboard : undefined;
    const st = {};
    if (dash) st.dashboard = dash;
    // dashboard changed -> reset view
    st.view = (dash || undefined) !== (oldState?.dashboard || undefined) ? "" : (value.view ?? "");
    entries[index] = [newKey, st];
    this._setConfig({ ...this._config, states: Object.fromEntries(entries) });
  }

  _addState() {
    const states = { ...(this._config.states || {}) };
    let n = Object.keys(states).length + 1;
    while (states[`state${n}`]) n++;
    states[`state${n}`] = { view: "" };
    this._setConfig({ ...this._config, states });
  }

  _removeState(index) {
    const entries = Object.entries(this._config.states || {});
    entries.splice(index, 1);
    this._setConfig({ ...this._config, states: Object.fromEntries(entries) });
  }

  _setConfig(cfg) {
    this._config = this._normalizeConfig(cfg);
    this._fireChanged();
    this._update();
  }

  _fireChanged() {
    this.dispatchEvent(new CustomEvent("config-changed", { detail: { config: this._config }, bubbles: true, composed: true }));
  }

  // drop legacy keys, keep mode-specific settings, preserve unknown extras
  _normalizeConfig(config) {
    const out = { type: config.type || "custom:embedded-view-card" };
    const target = config.target_entity || config.view_path_entity;

    let mode = String(config.mode ?? "static").toLowerCase();
    if (config.view_path_entity && !config.target_entity && mode === "static") mode = "dynamic";
    mode = mode === "dynamic" || mode === "hash" ? mode : "static";
    out.mode = mode;

    if (mode === "dynamic") {
      if (target) out.target_entity = target;
    } else if (mode === "hash") {
      if (config.default) out.default = config.default;
      out.states = (config.states && typeof config.states === "object") ? config.states : {};
    } else {
      const view = config.view ?? config.view_path ?? "";
      if (config.dashboard !== undefined && config.dashboard !== "" && config.dashboard !== CURRENT) out.dashboard = config.dashboard;
      out.view = view === null ? "" : view;
    }

    if (config.ha_card === false) out.ha_card = false;
    if (config.bleed === true) out.bleed = true;
    if (Number.isFinite(config.bleed_inline) && config.bleed_inline !== 16) out.bleed_inline = config.bleed_inline;
    if (Number.isFinite(config.bleed_block) && config.bleed_block !== 8) out.bleed_block = config.bleed_block;
    if (Array.isArray(config.exclude_cards) && config.exclude_cards.length) out.exclude_cards = config.exclude_cards;
    else if (typeof config.exclude_cards === "string" && config.exclude_cards) out.exclude_cards = [config.exclude_cards];

    const handled = new Set(["type", "mode", "target_entity", "view_path_entity", "default", "states", "view", "view_path",
      "dashboard", "ha_card", "bleed", "bleed_inline", "bleed_block", "exclude_cards"]);
    for (const k of Object.keys(config)) {
      if (!handled.has(k) && config[k] !== undefined) out[k] = config[k];
    }
    return out;
  }
}
customElements.define("embedded-view-card-editor", EmbeddedViewCardEditor);


window.customCards = window.customCards || [];
if (!window.customCards.some((c) => c.type === "embedded-view-card")) {
  window.customCards.push({
    type: "embedded-view-card",
    name: "Embedded View Card",
    description: "Embed any view of the current or another dashboard into a card.",
    preview: false,
    documentationURL: "https://github.com/redkanoon/embedded-view-card",
  });
}

console.info(
  `%c🧩 EMBEDDED VIEW CARD %c v${VERSION} `,
  "background:#fafafa;color:#17c711;font-weight:bold;padding:2px 6px;",
  "background:#17c711;color:#fafafa;font-weight:bold;padding:2px 4px;"
);
