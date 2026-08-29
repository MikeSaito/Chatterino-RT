import { en, type MessageKey } from "./en.ts";
import { ru } from "./ru.ts";
import { settingsEn, type SettingsMessageKey } from "./settings.en.ts";
import { settingsRu } from "./settings.ru.ts";
import { parseLocale, type Locale } from "./types.ts";

export type { Locale, MessageKey, SettingsMessageKey };
export type UiMessageKey = MessageKey | SettingsMessageKey;
export { parseLocale, en, ru, settingsEn, settingsRu };
export * from "./settingsKeys.ts";

const catalogs: Record<Locale, Record<string, string>> = {
  en: { ...(en as Record<string, string>), ...settingsEn },
  ru: { ...ru, ...settingsRu },
};

let locale: Locale = "en";
const listeners = new Set<() => void>();

export function getLocale(): Locale {
  return locale;
}

export function setLocale(next: Locale): void {
  if (locale === next) {
    return;
  }
  locale = next;
  for (const cb of listeners) {
    cb();
  }
}

export function onLocaleChange(cb: () => void): () => void {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}

function interpolate(
  template: string,
  vars?: Record<string, string | number>,
): string {
  if (!vars) {
    return template;
  }
  return template.replace(/\{(\w+)\}/g, (_, name: string) => {
    const v = vars[name];
    return v === undefined ? `{${name}}` : String(v);
  });
}

/** Translate a message key; falls back to English if missing in current locale. */
export function t(
  key: UiMessageKey | string,
  vars?: Record<string, string | number>,
): string {
  const primary = catalogs[locale][key];
  const raw =
    primary !== undefined && primary !== ""
      ? primary
      : (catalogs.en[key] ?? String(key));
  return interpolate(raw, vars);
}

/** Apply data-i18n* attributes under root. */
export function applyDomI18n(root?: ParentNode): void {
  const target =
    root ?? (typeof document !== "undefined" ? document : undefined);
  if (!target) {
    return;
  }
  target.querySelectorAll<HTMLElement>("[data-i18n]").forEach((el) => {
    const key = el.getAttribute("data-i18n");
    if (!key) {
      return;
    }
    const text = t(key);
    if (
      !(el instanceof HTMLInputElement) &&
      !(el instanceof HTMLTextAreaElement) &&
      !(el instanceof HTMLSelectElement)
    ) {
      el.textContent = text;
    }
    const attrs = el.getAttribute("data-i18n-attr");
    if (attrs) {
      for (const part of attrs.split(",")) {
        const name = part.trim();
        if (name) {
          el.setAttribute(name, text);
        }
      }
    }
  });

  const pair: Array<[string, string]> = [
    ["data-i18n-title", "title"],
    ["data-i18n-aria-label", "aria-label"],
    ["data-i18n-placeholder", "placeholder"],
  ];
  for (const [dataAttr, htmlAttr] of pair) {
    target.querySelectorAll<HTMLElement>(`[${dataAttr}]`).forEach((el) => {
      const key = el.getAttribute(dataAttr);
      if (!key) {
        return;
      }
      el.setAttribute(htmlAttr, t(key));
    });
  }
}

/**
 * Set locale from settings/raw value, sync document.lang, apply DOM strings.
 * No-op when locale is unchanged (avoids wiping dynamic chrome on every settings apply).
 */
export function applyLocale(raw: unknown, root?: ParentNode): Locale {
  const next = parseLocale(raw);
  if (locale === next) {
    return locale;
  }
  locale = next;
  if (typeof document !== "undefined") {
    document.documentElement.lang = next;
    if (document.querySelector("#settings-root")) {
      document.title = t("settings.windowTitle");
    }
  }
  applyDomI18n(root);
  for (const cb of listeners) {
    cb();
  }
  return next;
}

export function localeFromSettings(
  knobs: Record<string, unknown> | undefined,
): Locale {
  return parseLocale(knobs?.["appearance.uiLanguage"]);
}
