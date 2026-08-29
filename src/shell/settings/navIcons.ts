import type { IconName } from "../icons";

/** Settings sidebar page.id → icon. */
export const SETTINGS_NAV_ICONS: Record<string, IconName> = {
  general: "settings",
  accounts: "user",
  nicknames: "edit",
  commands: "slash",
  highlights: "star",
  ignores: "warning",
  filters: "filter",
  hotkeys: "keyboard",
  moderation: "shield",
  notifications: "bell",
  external: "external",
  about: "info",
};

export function settingsNavIcon(pageId: string): IconName {
  return SETTINGS_NAV_ICONS[pageId] ?? "settings";
}
