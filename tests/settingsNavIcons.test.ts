import { settingsNavIcon, SETTINGS_NAV_ICONS } from "../src/shell/settings/navIcons.ts";
import { hasIcon } from "../src/shell/icons.ts";

function assert(cond: boolean, msg: string): void {
  if (!cond) {
    throw new Error(msg);
  }
}

const pages = Object.keys(SETTINGS_NAV_ICONS);
assert(pages.length === 12, `nav map size ${pages.length}`);
for (const [id, icon] of Object.entries(SETTINGS_NAV_ICONS)) {
  assert(settingsNavIcon(id) === icon, `${id} → ${icon}`);
  assert(hasIcon(icon), `icon exists for ${id}: ${icon}`);
}
assert(settingsNavIcon("general") === "settings", "general");
assert(settingsNavIcon("unknown-page") === "settings", "fallback");

console.log("settingsNavIcons.test.ts ok");
