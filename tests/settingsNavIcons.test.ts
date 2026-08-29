import { settingsNavIcon, SETTINGS_NAV_ICONS } from "../src/shell/settings/navIcons.ts";
import { hasIcon } from "../src/shell/icons.ts";

function assert(cond: boolean, msg: string): void {
  if (!cond) {
    throw new Error(msg);
  }
}

const pages = Object.keys(SETTINGS_NAV_ICONS);
assert(pages.length >= 12, "nav map size");
for (const id of pages) {
  const name = settingsNavIcon(id);
  assert(hasIcon(name), `icon for ${id}`);
}
assert(settingsNavIcon("general") === "settings", "general");
assert(settingsNavIcon("unknown-page") === "settings", "fallback");

console.log("settingsNavIcons.test.ts ok");
