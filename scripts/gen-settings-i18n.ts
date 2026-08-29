/**
 * Walk SETTINGS_PAGES and emit settings string tables.
 * Run: node --experimental-strip-types scripts/gen-settings-i18n.ts
 */
import { writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { SETTINGS_PAGES } from "../src/shell/settings/catalog.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

function slug(s: string): string {
  const out = String(s)
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_|_$/g, "");
  return out || "x";
}

const en: Record<string, string> = {};

function put(key: string, text: string): void {
  if (en[key] !== undefined && en[key] !== text) {
    throw new Error(`collision ${key}: "${en[key]}" vs "${text}"`);
  }
  en[key] = text;
}

for (const page of SETTINGS_PAGES) {
  put(`settings.page.${page.id}.title`, page.title);
  put(`settings.page.${page.id}.nav`, page.navLabel);
  const walkSections = (sections: typeof page.sections): void => {
    for (const section of sections ?? []) {
      put(`settings.section.${slug(section.title)}`, section.title);
      for (const knob of section.knobs) {
        put(`settings.knob.${knob.id}`, knob.label);
        for (const o of knob.options ?? []) {
          const base = `settings.knob.${knob.id}.opt.${slug(String(o.value))}`;
          const key =
            en[base] !== undefined && en[base] !== o.label
              ? `${base}__${slug(o.label)}`
              : base;
          put(key, o.label);
        }
      }
    }
  };
  walkSections(page.sections);
  for (const tab of page.tabs ?? []) {
    put(`settings.tab.${page.id}.${tab.id}`, tab.label);
    walkSections(tab.sections);
    if (tab.table) {
      for (const col of tab.table.columns) {
        put(`settings.table.${tab.table.id}.col.${col.key}`, col.label);
        for (const o of col.options ?? []) {
          put(
            `settings.table.${tab.table.id}.col.${col.key}.opt.${slug(String(o.value))}`,
            o.label,
          );
        }
      }
    }
  }
  if (page.table) {
    for (const col of page.table.columns) {
      put(`settings.table.${page.table.id}.col.${col.key}`, col.label);
      for (const o of col.options ?? []) {
        put(
          `settings.table.${page.table.id}.col.${col.key}.opt.${slug(String(o.value))}`,
          o.label,
        );
      }
    }
  }
}

const keys = Object.keys(en).sort();
console.log(`keys: ${keys.length}`);

const enBody = keys
  .map((k) => `  ${JSON.stringify(k)}: ${JSON.stringify(en[k])},`)
  .join("\n");

writeFileSync(
  join(root, "src/i18n/settings.en.ts"),
  `/** Settings catalog English strings (generated from catalog labels). */\nexport const settingsEn = {\n${enBody}\n} as const;\n\nexport type SettingsMessageKey = keyof typeof settingsEn;\n`,
  "utf8",
);

console.log("wrote src/i18n/settings.en.ts");
