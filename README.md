[![release](https://img.shields.io/github/v/release/redkanoon/embedded-view-card.svg?style=for-the-badge)](https://github.com/redkanoon/embedded-view-card/releases)
[![Ko-fi](https://img.shields.io/badge/Support_me_on-Ko--fi-FF5E5B?logo=ko-fi&logoColor=white&style=for-the-badge)](https://ko-fi.com/redkanoon)


![](https://github.com/redkanoon/embedded-view-card/blob/main/.github/live-switching.gif)

# 🧩 Embedded View Card for Home Assistant

The **Embedded View Card** allows you to embed another Lovelace view directly into a card inside your current dashboard.  
It’s perfect for modular layouts and dynamic content control.

---

## ⚡ Features

- Embed any view from the same dashboard
- Optionally wrap content in `ha-card`
- Dynamic view selection via an entity (e.g. `input_text`)
- Editor UI with localized labels
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

### Static View

```yaml
type: custom:embedded-view-card
view_path: climate
ha_card: true
```

### Dynamic View from Entity

```yaml
type: custom:embedded-view-card
view_path_entity: input_text.active_view
ha_card: false
```

---

## ⚙️ Options

| Option            | Type     | Description                                                      | Default |
|-------------------|----------|------------------------------------------------------------------|---------|
| `view_path`       | string   | Path of the view to embed                                        | —       |
| `view_path_entity`| entity   | Entity whose state provides the view path dynamically            | —       |
| `ha_card`         | boolean  | Whether to wrap content in a `ha-card`                           | `true`  |

> **Note:** At least one of `view_path` or `view_path_entity` must be provided.

---

## 🖥️ Editor Support

- Supports Lovelace editor with dropdown selection of available views
- Localized labels for EN, DE, FR, ES, etc.
- Automatically switches to dynamic mode when needed

---

## 🧪 Developer Notes

- Uses internal components like `hui-root` and `hui-view`  
  *(subject to change by Home Assistant core)*
- Estimates height automatically (~50 px per row)
- Gracefully shows error message when view is not found or misconfigured

---

## 🚀 Contributing

Feel free to submit pull requests and suggestions.  
Ideas for improvement:

- Improve fallback UI
- Add support for multi-dashboard embedding
- Create preview screenshots or a demo video

---

## 📄 License

MIT License. See [LICENSE](./LICENSE) for full details.

---

## ☕ Support

If you find this project helpful, consider supporting it here:

<a href="https://ko-fi.com/redkanoon" target="_blank">
  <img src="https://www.buymeacoffee.com/assets/img/custom_images/white_img.png" alt="Buy Me a Coffee" style="height: auto !important;width: auto !important;">
</a>



