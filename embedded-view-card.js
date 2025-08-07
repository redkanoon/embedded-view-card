// Embedded View Card for Home Assistant
// Allows embedding another view from the same dashboard into a card

import { VERSION } from "./version.js";

class EmbeddedViewCard extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: "open" }); // Enable shadow DOM
  }

  setConfig(config) {
    this._config = config;
    this.shadowRoot.innerHTML = ""; // Clear previous content

    this._container = document.createElement("div");

    // Optionally wrap in ha-card unless explicitly disabled
    if (config.ha_card !== false) {
      this._root = document.createElement("ha-card");
      this._root.appendChild(this._container);
      this.shadowRoot.appendChild(this._root);
    } else {
      this.shadowRoot.appendChild(this._container);
    }

    // Don't try to load yet – wait for hass
    this._viewPath = config.view_path || null;
  }

  async _loadView() {
    try {
      const root = await this._waitForElement(() => getHuiRoot());
      if (!root) throw new Error("hui-root not found");

      const views = root.lovelace?.config?.views;
      const view = views?.find((v) => v.path === this._viewPath);
      if (!view) throw new Error("View not found: " + this._viewPath);

      const embeddedViewElement = document.createElement("hui-view");
      embeddedViewElement.setAttribute("style", "margin: 0; padding: 0; display: contents;");
      embeddedViewElement.hass = root.hass;
      embeddedViewElement.narrow = false;
      embeddedViewElement.lovelace = root.lovelace;
      embeddedViewElement.index = views.indexOf(view);
      embeddedViewElement.isStrategyView = false;
      embeddedViewElement.viewConfig = view;

      this._container.innerHTML = "";
      this._container.appendChild(embeddedViewElement);
    } catch (err) {
      this._showError("Error loading view: " + err.message);
      console.error("[embedded-view-card] Error:", err);
    }
  }

  set hass(hass) {
    this._hass = hass;

    // Prefer static view_path if set
    let newPath = this._config.view_path;

    // Otherwise, fallback to dynamic entity if defined
    if (!newPath && this._config.view_path_entity) {
      const entity = this._config.view_path_entity;
      const state = hass.states[entity];
      if (state) {
        newPath = state.state;
      }
    }

    if (!newPath) {
      this._showError("Missing configuration: view_path or view_path_entity");
      return;
    }

    // Initial load and reload if view_path changed
    if (newPath !== this._viewPath || !this._container?.firstChild) {
      this._viewPath = newPath;
      this._loadView();
      return;
    }

    // Just update hass on current view
    if (this._container?.firstChild) {
      this._container.firstChild.hass = hass;
    }
  }

  _showError(msg) {
    this._container.innerHTML = `<hui-warning>${msg}</hui-warning>`;
  }

getCardSize() {
  if (this._container?.firstChild?.offsetHeight) {
    // Estimate rows by height (assuming ~50px per row)
    return Math.ceil(this._container.firstChild.offsetHeight / 50);
  }
  // Fallback if not yet rendered
  return 5;
}

  _waitForElement(fn, timeout = 10000) {
    return new Promise((resolve, reject) => {
      const interval = 100;
      let waited = 0;
      const check = () => {
        const el = fn();
        if (el) return resolve(el);
        waited += interval;
        if (waited >= timeout) return reject(new Error("Timeout waiting for element"));
        setTimeout(check, interval);
      };
      check();
    });
  }

  static getConfigElement() {
    return document.createElement("embedded-view-card-editor");
  }

  // Provides a default stub configuration for initial card setup in the editor UI.
  // This helps Home Assistant render the card preview when adding a new instance.
  // The view_path remains empty, prompting user selection or entity binding.
  static getStubConfig() {
    return { type: "custom:embedded-view-card", view_path: "" };
  }
}

customElements.define("embedded-view-card", EmbeddedViewCard);

// Traverses the shadow DOM to locate the hui-root element of the Lovelace UI.
// This is required to access the active Lovelace configuration and views.
// Returns null if the element is not yet available (e.g. during initial load).
function getHuiRoot() {
  return document
    .querySelector("home-assistant")?.shadowRoot
    ?.querySelector("home-assistant-main")?.shadowRoot
    ?.querySelector("ha-panel-lovelace")?.shadowRoot
    ?.querySelector("hui-root");
}

class EmbeddedViewCardEditor extends HTMLElement {
  setConfig(config) {
    this._config = config;
    this._views = [];
    this._rendered = false;
    this._loadViews();
  }

  async _loadViews() {
    const huiRoot = getHuiRoot();
    const views = huiRoot?.lovelace?.config?.views || [];

    this._views = [this._label("Dynamic"), ...views.filter((v) => v.path && v.path !== "home").map((v) => v.path)];
    this._render();
  }

  _render() {
    if (this._rendered || !this._hass || !this._views.length) return;

    const container = document.createElement("div");
    this.replaceChildren(container)

    const selectedValue = this._config.view_path || this._label("Dynamic");
    const isDynamic = selectedValue === this._label("Dynamic");
    container.style.display = "flex";
    container.style.flexDirection = "column";
    container.style.gap = "12px";
    container.style.padding = "0 16px";

    const selector = document.createElement("ha-selector");
    selector.label = this._label("Select view");
    selector.hass = this._hass;
    selector.selector = { select: {
      options: this._views,
      custom_value: true
    } };
    selector.value = selectedValue;
    selector.id = "view_path";

    selector.addEventListener("value-changed", (ev) => {
      const value = ev.detail.value;
      if (value === this._label("Dynamic")) {
        delete this._config.view_path;
      } else {
        this._config.view_path = value;
        delete this._config.view_path_entity;
      }
      this.dispatchEvent(new CustomEvent("config-changed", { detail: { config: this._config } }));
      this._rendered = false;
      this._render();
    });

    container.appendChild(selector);

    if (isDynamic) {
      const entityInput = document.createElement("ha-selector");
      entityInput.label = this._label("Entity (e.g. input_text.window_view)");
      entityInput.hass = this._hass;
      entityInput.selector = { entity: {} };
      entityInput.value = this._config.view_path_entity || "";
      entityInput.id = "view_path_entity";

      entityInput.addEventListener("value-changed", (ev) => {
        this._config.view_path_entity = ev.detail.value;
        this.dispatchEvent(new CustomEvent("config-changed", { detail: { config: this._config } }));
      });

      container.appendChild(entityInput);
    }

    const checkbox = document.createElement("ha-selector");
    checkbox.label = this._label("Wrap in ha-card");
    checkbox.hass = this._hass;
    checkbox.selector = { boolean: {} };
    checkbox.value = this._config.ha_card !== false;
    checkbox.id = "ha_card";

    checkbox.addEventListener("value-changed", (ev) => {
      this._config.ha_card = ev.detail.value;
      this.dispatchEvent(new CustomEvent("config-changed", { detail: { config: this._config } }));
    });

    container.appendChild(checkbox);

    this.appendChild(container);
    this._rendered = true;
  }

  _label(text) {
    const lang = this._hass?.locale?.language ?? "en";
    const labels = {
      "Select view": {
        de: "View auswählen",
        fr: "Sélectionner une vue",
        es: "Seleccionar vista",
        nl: "Selecteer weergave",
        it: "Seleziona vista",
        pl: "Wybierz widok",
        en: "Select view",
      },
      "Dynamic": {
        de: "Dynamisch",
        fr: "Dynamique",
        es: "Dinámico",
        nl: "Dynamisch",
        it: "Dinamico",
        pl: "Dynamiczny",
        en: "Dynamic",
      },
      "Entity (e.g. input_text.window_view)": {
        de: "Entität (z. B. input_text.window_view)",
        fr: "Entité (ex. input_text.window_view)",
        es: "Entidad (ej. input_text.window_view)",
        nl: "Entiteit (bijv. input_text.window_view)",
        it: "Entità (es. input_text.window_view)",
        pl: "Encja (np. input_text.window_view)",
        en: "Entity (e.g. input_text.window_view)",
      },
      "Wrap in ha-card": {
        de: "In ha-card einbetten",
        fr: "Encapsuler dans ha-card",
        es: "Envolver en ha-card",
        nl: "Verpakken in ha-card",
        it: "Avvolgere in ha-card",
        pl: "Zawijaj w ha-card",
        en: "Wrap in ha-card",
      }
    };
    return labels[text]?.[lang] || text;
  }

  set hass(hass) {
    this._hass = hass;
    if (!this._rendered && this._views?.length) this._render();
  }

}

customElements.define("embedded-view-card-editor", EmbeddedViewCardEditor)

window.customCards = window.customCards || [];
window.customCards.push({
  type: "embedded-view-card",
  name: "Embedded View Card",
  description: "Embeds a view from the current dashboard",
});

console.info(
  `%c 🧩 EMBEDDED VIEW CARD %c v${VERSION} `,
  'background: #fafafa; color: #17c711; font-weight: bold; padding: 2px 6px;',
  'background: #17c711; color: #fafafa; font-weight: bold; padding: 2px 4px;'
);
