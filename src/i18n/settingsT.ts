/** Resolve catalog labels to translated UI strings. */

import { t } from "./index.ts";
import { settingsEn } from "./settings.en.ts";
import {
  settingsKnobKey,
  settingsKnobOptKey,
  settingsPageNavKey,
  settingsPageTitleKey,
  settingsSectionKey,
  settingsTabKey,
  settingsTableColKey,
  settingsTableColOptKey,
} from "./settingsKeys.ts";

const enTable = settingsEn as Record<string, string>;

export function tPageTitle(pageId: string): string {
  return t(settingsPageTitleKey(pageId));
}

export function tPageNav(pageId: string): string {
  return t(settingsPageNavKey(pageId));
}

export function tSectionTitle(title: string): string {
  return t(settingsSectionKey(title));
}

export function tKnobLabel(knobId: string): string {
  return t(settingsKnobKey(knobId));
}

export function tKnobOption(
  knobId: string,
  value: string,
  label: string,
): string {
  return t(settingsKnobOptKey(knobId, value, label, enTable));
}

export function tTabLabel(pageId: string, tabId: string): string {
  return t(settingsTabKey(pageId, tabId));
}

export function tTableCol(tableId: string, colKey: string): string {
  return t(settingsTableColKey(tableId, colKey));
}

export function tTableColOption(
  tableId: string,
  colKey: string,
  value: string,
  label: string,
): string {
  return t(settingsTableColOptKey(tableId, colKey, value, label, enTable));
}
