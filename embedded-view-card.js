// Embedded View Card for Home Assistant
// Allows embedding another view from the same dashboard into a card
class EmbeddedViewCard extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: "open" }); // Enable shadow DOM
  }

  setConfig(config) {
    if (!config.view_path) {
      this._showError("Missing configuration: view_path");
      return;
    }

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

    this._loadView();
  }

  async _loadView() {
    try {
      // Wait for hui-root to be available (Lovelace root element)
      const root = await this._waitForElement(() => getHuiRoot());
      if (!root) throw new Error("hui-root not found");

      const views = root.lovelace?.config?.views;
      const view = views?.find((v) => v.path === this._config.view_path);
      if (!view) throw new Error("View not found: " + this._config.view_path);

      // Create a new hui-view element and assign view config
      const viewEl = document.createElement("hui-view");
      viewEl.setAttribute("style", "margin: 0; padding: 0; display: contents;");
      viewEl.hass = root.hass;
      viewEl.narrow = false;
      viewEl.lovelace = root.lovelace;
      viewEl.index = views.indexOf(view);
      viewEl.isStrategyView = false;
      viewEl.viewConfig = view;

      this._container.innerHTML = ""; // Clear container before rendering
      this._container.appendChild(viewEl);
    } catch (err) {
      this._showError("Error loading view: " + err.message);
      console.error("[embedded-view-card] Error:", err);
    }
  }

  set hass(hass) {
    this._hass = hass;
    // Forward hass object to the inner view if already rendered
    if (this._container?.firstChild) {
      this._container.firstChild.hass = hass;
    }
  }

  _showError(msg) {
    // Show warning message inside the card
    this._container.innerHTML = `<hui-warning>${msg}</hui-warning>`;
  }

  getCardSize() {
    // Return estimated height in grid units
    return 5;
  }

  // Utility to wait for an element to be available (with timeout)
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

  static getStubConfig() {
    // Default config stub for card picker
    return { type: "custom:embedded-view-card", view_path: "" };
  }
}

customElements.define("embedded-view-card", EmbeddedViewCard);


// Utility function to safely retrieve hui-root element
function getHuiRoot() {
  return document
    .querySelector("home-assistant")?.shadowRoot
    ?.querySelector("home-assistant-main")?.shadowRoot
    ?.querySelector("ha-panel-lovelace")?.shadowRoot
    ?.querySelector("hui-root");
}


// Config editor for the Embedded View Card
class EmbeddedViewCardEditor extends HTMLElement {
  setConfig(config) {
    this._config = config;
    this._views = [];
    this._rendered = false;
    this._loadViews(); // Start loading view options from current dashboard
  }

  async _loadViews() {
    const huiRoot = getHuiRoot();
    const views = huiRoot?.lovelace?.config?.views || [];

    // Only show views with valid path and not 'home'
    this._views = views
      .filter((v) => v.path && v.path !== "home")
      .map((v) => ({
        value: v.path,
        label: v.title || v.path,
      }));

    this._render();
  }

  _render() {
    // Prevent re-render or render without required state
    if (this._rendered || !this._hass || !this._views.length) return;

    this.innerHTML = "";

    // Wrapper container for layout
    const container = document.createElement("div");
    container.style.display = "flex";
    container.style.flexDirection = "column";
    container.style.gap = "12px";
    container.style.padding = "0 16px";

    // Dropdown for view selection
    const selector = document.createElement("ha-selector");
    const language = this._hass?.locale?.language ?? "en";
    const labels = {
      de: "View auswählen",
      fr: "Sélectionner une vue",
      es: "Seleccionar vista",
      nl: "Selecteer weergave",
      it: "Seleziona vista",
      pl: "Wybierz widok",
      en: "Select view",
    };
    selector.label = labels[language] || labels.en;
    selector.hass = this._hass;
    selector.selector = {
      select: {
        options: this._views,
        custom_value: true, // Allow typing manual paths
      },
    };
    selector.value = this._config.view_path || "";
    selector.id = "view_path";

    selector.addEventListener("value-changed", (ev) => {
      this._config = {
        ...this._config,
        type: "custom:embedded-view-card",
        view_path: ev.detail.value,
      };
      this.dispatchEvent(new CustomEvent("config-changed", { detail: { config: this._config } }));
    });

    // Checkbox for ha-card wrapping
    const checkbox = document.createElement("ha-selector");
    checkbox.label = "Wrap in ha-card";
    checkbox.hass = this._hass;
    checkbox.selector = {
      boolean: {},
    };
    checkbox.value = this._config.ha_card !== false;
    checkbox.id = "ha_card";

    checkbox.addEventListener("value-changed", (ev) => {
      this._config = {
        ...this._config,
        ha_card: ev.detail.value,
      };
      this.dispatchEvent(new CustomEvent("config-changed", { detail: { config: this._config } }));
    });

    container.appendChild(selector);
    container.appendChild(checkbox);

    this.appendChild(container);
    this._rendered = true;
  }

  set hass(hass) {
    this._hass = hass;
    // Try re-render if data was loaded before hass
    if (!this._rendered && this._views?.length) {
      this._render();
    }
  }

  get config() {
    return this._config;
  }
}

customElements.define("embedded-view-card-editor", EmbeddedViewCardEditor);


// Register in the card picker UI
window.customCards = window.customCards || [];
window.customCards.push({
  type: "embedded-view-card",
  name: "Embedded View Card",
  description: "Embeds a view from the current dashboard",
});

console.info(
  `%c 🧩 EMBEDDED VIEW CARD %c v1.1.1 `,
  'background: #fafafa; color: #17c711; font-weight: bold; padding: 2px 6px;',
  'background: #17c711; color: #fafafa; font-weight: bold; padding: 2px 4px;'
);
