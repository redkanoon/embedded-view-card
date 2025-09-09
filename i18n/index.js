// Translation for Embedded View Card for Home Assistant

import EN from "./en.js";
import DE from "./de.js";
import FR from "./fr.js";
import ES from "./es.js";
import NL from "./nl.js";
import IT from "./it.js";
import PL from "./pl.js";

const DICTS = {
  en: EN,
  de: DE,
  fr: FR,
  es: ES,
  nl: NL,
  it: IT,
  pl: PL,
};

function resolveLang(hass) {
  const raw =
    (hass && (hass.locale?.language || hass.language)) ||
    (typeof navigator !== "undefined" ? navigator.language : "en") ||
    "en";
  const base = String(raw).toLowerCase();
  if (DICTS[base]) return base;
  const short = base.split("-")[0];
  return DICTS[short] ? short : "en";
}

function fmt(str, vars) {
  if (!vars) return str;
  return str.replace(/\{(\w+)\}/g, (_, k) =>
    vars[k] != null ? String(vars[k]) : `{${k}}`
  );
}

export function t(hass, key, vars) {
  const lang = resolveLang(hass);
  const dict = DICTS[lang] || DICTS.en;
  const base = dict[key] ?? DICTS.en[key] ?? key;
  return fmt(base, vars);
}

export { DICTS };