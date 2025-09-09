[![release](https://img.shields.io/github/v/release/redkanoon/embedded-view-card.svg?style=for-the-badge)](https://github.com/redkanoon/embedded-view-card/releases)
[![last-commit](https://img.shields.io/github/last-commit/redkanoon/embedded-view-card.svg?style=for-the-badge)](https://github.com/redkanoon/embedded-view-card/commits/main)
[![community](https://img.shields.io/badge/Home%20Assistant%20Community-Forum-blue?style=for-the-badge&logo=home-assistant&logoColor=white)](https://community.home-assistant.io/t/new-custom-card-embedded-view-card-embed-any-view-into-another/917306)
[![Ko-fi](https://img.shields.io/badge/Support_me_on-Ko--fi-FF5E5B?logo=ko-fi&logoColor=white&style=for-the-badge)](https://ko-fi.com/redkanoon)

![](https://github.com/redkanoon/embedded-view-card/blob/main/.github/live-switching.gif)

# 🧩 Embedded View Card for Home Assistant

The **Embedded View Card** allows you to embed another Lovelace view directly into a card inside your current dashboard – or even across dashboards.  
It’s perfect for modular layouts, reusable components, and dynamic navigation.

---

## 💡 Why this card?
Managing complex dashboards with many pages or modular views can become difficult and repetitive.  
This card was built to make it easier to design reusable view components that can be visually customized and referenced from anywhere.

Instead of copying entire layouts into every view, you can now embed them once and reuse them multiple times.  
Compared to using iframes, this approach is faster, more integrated, and avoids the delay of loading a separate web page.

This card was built to feel like a native part of Home Assistant – rendering views directly, without hacks or reloads.

---

## ⚡ Features

- Embed any view from the **current or another dashboard**
- **Static mode**: pick dashboard + view directly
- **Dynamic mode**: use an entity (`input_text`) whose state is `dashboard/view`
- Loop guard to prevent self-embedding
- Optionally wrap content in `ha-card`
- **Bleed mode**: remove default padding with adjustable margins
- Editor UI with localized labels and previews
- Compatible with HACS for easy updates

---

## 📦 Installation

### Manual Installation

1. Download `embedded-view-card.js` into `config/www/`.
2. Add the following to your `configuration.yaml` resources:

```yaml
resources:
  - url: /local/embedded-view-card.js
    type: module
```

### HACS Installation

1. Open **HACS** → **⋮ Menu** → **Custom repositories**
2. Add the following repository as a **Dashboard** integration:

```
https://github.com/redkanoon/embedded-view-card
```

3. After adding, search for **Embedded View Card** and install it from HACS  
4. If not added automatically, add the following to your `configuration.yaml` resources:

```yaml
resources:
  - url: /hacsfiles/embedded-view-card/embedded-view-card.js
    type: module
```

---

## 🧰 Configuration Examples

![](https://github.com/redkanoon/embedded-view-card/blob/main/.github/live-editing.gif)

### Static Mode – Fixed View

```yaml
type: custom:embedded-view-card
dashboard: dashboard-main
view: climate
ha_card: true
```

### Dynamic Mode – View from Entity

#### Helper (must exist)

```yaml
input_text:
  window_view:
    name: window_view
```

#### Card

```yaml
type: custom:embedded-view-card
mode: dynamic
target_entity: input_text.window_view
ha_card: false
```

#### Action (e.g. in a button card)

```yaml
tap_action:
  action: perform-action
  perform_action: input_text.set_value
  target:
    entity_id: input_text.window_view
  data:
    value: dashboard-rooms/kitchen
```

#### The following view must exist in your dashboard

```yaml
title: Kitchen
path: kitchen
type: sections
```

---

## ⚙️ Options

| Option             | Type     | Description                                           | Default |
|--------------------|----------|-------------------------------------------------------|---------|
| `mode`             | string   | `"static"` or `"dynamic"`                             | static  |
| `dashboard`        | string   | Dashboard path (static mode)                          | current |
| `view`             | string   | View path (static mode)                               | —       |
| `target_entity`    | entity   | Entity whose state provides `dashboard/view` (dynamic)| —       |
| `ha_card`          | boolean  | Whether to wrap content in a `ha-card`                | true    |
| `bleed`            | boolean  | Remove outer padding (only when `ha_card: false`)     | false   |
| `bleed_inline`     | number   | Inline padding override (px)                          | 16      |
| `bleed_block`      | number   | Block padding override (px)                           | 8       |

---

## 🖥️ Editor Support

- Dropdown selection of dashboards and views
- Dynamic entity preview and format hints
- Localized labels (EN, DE, FR, ES, IT, NL, PL, …)
- Warning note about recursive loop detection (not yet supported)

---

## 🧪 Developer Notes

- Uses internal components like `hui-root` and `hui-view`  
  *(subject to change by Home Assistant core)*
- Internal caching of WS configs for faster reloads
- Smarter re-rendering (only when dashboard/view changes)
- Gracefully shows error messages when view is not found or misconfigured

---

## 🚀 Contributing

Feel free to submit pull requests and suggestions.  
Ideas for improvement:

- Add safe recursive loop detection
- Add mode "internal" where the embedded view could be changed with actions

---

## 📄 License

MIT License. See [LICENSE](./LICENSE) for full details.

---

## ☕ Support

Hey 👋 I love building this little something for Home Assistant!  
Being part of this amazing community is fun 💡  
If you like it, your support means a lot 🙏❤️

<a href="https://ko-fi.com/redkanoon" target="_blank">
  <img src="https://www.buymeacoffee.com/assets/img/custom_images/white_img.png" alt="Buy Me a Coffee" style="height: auto !important;width: auto !important;">
</a>
