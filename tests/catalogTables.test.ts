import { SETTINGS_PAGES } from "../src/shell/settings/catalog.ts";

function assert(cond: boolean, msg: string): void {
  if (!cond) {
    throw new Error(msg);
  }
}

function tables(): {
  id: string;
  columns: { key: string; readonly?: boolean }[];
  blankRow: Record<string, string | boolean>;
}[] {
  const out: {
    id: string;
    columns: { key: string; readonly?: boolean }[];
    blankRow: Record<string, string | boolean>;
  }[] = [];
  for (const page of SETTINGS_PAGES) {
    if (page.table) {
      out.push({
        id: page.table.id,
        columns: page.table.columns,
        blankRow: page.table.blankRow,
      });
    }
    for (const tab of page.tabs ?? []) {
      if (tab.table) {
        out.push({
          id: tab.table.id,
          columns: tab.table.columns,
          blankRow: tab.table.blankRow,
        });
      }
    }
  }
  return out;
}

const byId = new Map(tables().map((t) => [t.id, t]));

const highlights = [
  byId.get("highlight-messages"),
  byId.get("highlight-users"),
  byId.get("highlight-badges"),
];
for (const table of highlights) {
  assert(table !== undefined, "highlight table missing");
  assert(
    !table!.columns.some((c) => c.key === "showInMentions"),
    `${table!.id} must not show Show in Mentions`,
  );
}

const filters = byId.get("filters");
assert(filters !== undefined, "filters table missing");
const valid = filters!.columns.find((c) => c.key === "valid");
assert(valid?.readonly === true, "filters Valid must be read-only");

const mods = byId.get("mod-actions");
assert(mods !== undefined, "mod-actions table missing");
assert(
  !mods!.columns.some((c) => c.key === "icon"),
  "mod-actions must not show Icon",
);
assert(
  mods!.columns.some((c) => c.key === "action"),
  "mod-actions keeps Action",
);
assert(
  byId.get("highlight-messages")!.blankRow.showInMentions === true,
  "showInMentions stays in blankRow",
);
assert(mods!.blankRow.icon === "", "icon stays in blankRow");

console.log("catalogTables.test.ts: ok");
