/** Deterministic settings message keys from catalog ids/labels. */

export function settingsSlug(s: string): string {
  const out = String(s)
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_|_$/g, "");
  return out || "x";
}

export function settingsPageTitleKey(pageId: string): string {
  return `settings.page.${pageId}.title`;
}

export function settingsPageNavKey(pageId: string): string {
  return `settings.page.${pageId}.nav`;
}

export function settingsSectionKey(title: string): string {
  return `settings.section.${settingsSlug(title)}`;
}

export function settingsKnobKey(knobId: string): string {
  return `settings.knob.${knobId}`;
}

export function settingsKnobOptKey(
  knobId: string,
  value: string,
  label: string,
  enCatalog: Record<string, string>,
): string {
  const base = `settings.knob.${knobId}.opt.${settingsSlug(value)}`;
  if (enCatalog[base] !== undefined && enCatalog[base] !== label) {
    return `${base}__${settingsSlug(label)}`;
  }
  return base;
}

export function settingsTabKey(pageId: string, tabId: string): string {
  return `settings.tab.${pageId}.${tabId}`;
}

export function settingsTableColKey(tableId: string, colKey: string): string {
  return `settings.table.${tableId}.col.${colKey}`;
}

export function settingsTableColOptKey(
  tableId: string,
  colKey: string,
  value: string,
  label: string,
  enCatalog: Record<string, string>,
): string {
  const base = `settings.table.${tableId}.col.${colKey}.opt.${settingsSlug(value)}`;
  if (enCatalog[base] !== undefined && enCatalog[base] !== label) {
    return `${base}__${settingsSlug(label)}`;
  }
  return base;
}
