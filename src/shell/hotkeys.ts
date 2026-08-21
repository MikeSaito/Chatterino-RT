const ZOOM_STEPS = [
  0.5, 0.6, 0.7, 0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2, 2.5, 3, 3.5, 4,
];

export type HotkeyAction =
  | "showSearch"
  | "openSettings"
  | "openEmotesPopup"
  | "scrollToBottom"
  | "zoomIn"
  | "zoomOut"
  | "zoomReset";

export type HotkeyRow = {
  action: HotkeyAction;
  keybinding: string;
  name: string;
};

export type ParsedBinding = {
  ctrl: boolean;
  alt: boolean;
  shift: boolean;
  meta: boolean;
  key: string;
};

export const HOTKEY_ACTION_OPTIONS: { label: string; value: HotkeyAction }[] = [
  { label: "Show search", value: "showSearch" },
  { label: "Open settings", value: "openSettings" },
  { label: "Open emotes popup", value: "openEmotesPopup" },
  { label: "Scroll to bottom", value: "scrollToBottom" },
  { label: "Zoom in", value: "zoomIn" },
  { label: "Zoom out", value: "zoomOut" },
  { label: "Zoom reset", value: "zoomReset" },
];

export const DEFAULT_HOTKEYS: HotkeyRow[] = [
  { action: "showSearch", keybinding: "Ctrl+F", name: "Show search" },
  { action: "openSettings", keybinding: "Ctrl+P", name: "Open settings" },
  { action: "openEmotesPopup", keybinding: "Ctrl+E", name: "Open emotes popup" },
  { action: "scrollToBottom", keybinding: "Ctrl+End", name: "Scroll to bottom" },
  { action: "zoomIn", keybinding: "Ctrl+=", name: "Zoom in" },
  { action: "zoomOut", keybinding: "Ctrl+-", name: "Zoom out" },
  { action: "zoomReset", keybinding: "Ctrl+0", name: "Zoom reset" },
];

const ACTION_SET = new Set<string>(HOTKEY_ACTION_OPTIONS.map((o) => o.value));

let rows: HotkeyRow[] = DEFAULT_HOTKEYS.map((r) => ({ ...r }));
let parsed: { action: HotkeyAction; binding: ParsedBinding }[] = [];

configureHotkeys(DEFAULT_HOTKEYS.map((r) => ({ ...r })));

export function configureHotkeys(
  raw: ReadonlyArray<Record<string, string | boolean>>,
): void {
  rows = normalizeHotkeyRows(raw);
  parsed = [];
  for (const row of rows) {
    const binding = parseBinding(row.keybinding);
    if (binding) {
      parsed.push({ action: row.action, binding });
    }
  }
}

export function defaultHotkeyTableRows(): Record<string, string | boolean>[] {
  return DEFAULT_HOTKEYS.map((r) => ({
    action: r.action,
    keybinding: r.keybinding,
    name: r.name,
  }));
}

export function normalizeHotkeyRows(
  raw: ReadonlyArray<Record<string, string | boolean>>,
): HotkeyRow[] {
  if (!raw || raw.length === 0) {
    return DEFAULT_HOTKEYS.map((r) => ({ ...r }));
  }
  const out: HotkeyRow[] = [];
  const seen = new Set<string>();
  for (const row of raw) {
    const action = String(row.action ?? "").trim();
    if (!ACTION_SET.has(action) || seen.has(action)) {
      continue;
    }
    const keybinding = String(row.keybinding ?? "").trim();
    if (!keybinding || !parseBinding(keybinding)) {
      continue;
    }
    seen.add(action);
    const label =
      HOTKEY_ACTION_OPTIONS.find((o) => o.value === action)?.label ?? action;
    out.push({
      action: action as HotkeyAction,
      keybinding,
      name: String(row.name ?? label),
    });
  }
  if (out.length === 0) {
    return DEFAULT_HOTKEYS.map((r) => ({ ...r }));
  }
  for (const def of DEFAULT_HOTKEYS) {
    if (!seen.has(def.action)) {
      out.push({ ...def });
    }
  }
  return out;
}

export function parseBinding(raw: string): ParsedBinding | null {
  let s = raw.trim();
  if (!s) {
    return null;
  }
  let ctrl = false;
  let alt = false;
  let shift = false;
  let meta = false;
  for (;;) {
    const lower = s.toLowerCase();
    if (lower.startsWith("ctrl+") || lower.startsWith("control+")) {
      ctrl = true;
      s = s.slice(s.indexOf("+") + 1);
      continue;
    }
    if (lower.startsWith("alt+")) {
      alt = true;
      s = s.slice(s.indexOf("+") + 1);
      continue;
    }
    if (lower.startsWith("shift+")) {
      shift = true;
      s = s.slice(s.indexOf("+") + 1);
      continue;
    }
    if (
      lower.startsWith("meta+") ||
      lower.startsWith("cmd+") ||
      lower.startsWith("command+") ||
      lower.startsWith("win+")
    ) {
      meta = true;
      s = s.slice(s.indexOf("+") + 1);
      continue;
    }
    break;
  }
  const keyTok = s.trim();
  if (!keyTok) {
    return null;
  }
  const key = normalizeKeyToken(keyTok.toLowerCase());
  if (!key) {
    return null;
  }
  return { ctrl, alt, shift, meta, key };
}

export function matchEvent(ev: KeyboardEvent, binding: ParsedBinding): boolean {
  if (ev.ctrlKey !== binding.ctrl) {
    return false;
  }
  if (ev.altKey !== binding.alt) {
    return false;
  }
  if (ev.shiftKey !== binding.shift) {
    return false;
  }
  if (ev.metaKey !== binding.meta) {
    return false;
  }
  const ek = eventKey(ev);
  if (binding.key === "=") {
    return ek === "=" || ek === "+";
  }
  if (binding.key === "-") {
    return ek === "-" || ek === "_";
  }
  return ek === binding.key;
}

export function resolveAction(ev: KeyboardEvent): HotkeyAction | null {
  for (const row of parsed) {
    if (matchEvent(ev, row.binding)) {
      return row.action;
    }
  }
  return null;
}

export function stepZoom(current: number, dir: 1 | -1 | 0): number {
  const levels = ZOOM_STEPS;
  if (dir === 0) {
    return 1;
  }
  let idx = 0;
  let best = Math.abs(current - levels[0]);
  for (let i = 1; i < levels.length; i += 1) {
    const d = Math.abs(current - levels[i]);
    if (d < best) {
      best = d;
      idx = i;
    }
  }
  const next = idx + dir;
  if (next < 0) {
    return levels[0];
  }
  if (next >= levels.length) {
    return levels[levels.length - 1];
  }
  return levels[next];
}

export function actionAllowsEditable(action: HotkeyAction): boolean {
  return (
    action === "showSearch" ||
    action === "openSettings" ||
    action === "openEmotesPopup"
  );
}

function normalizeKeyToken(token: string): string {
  if (token === "esc") {
    return "escape";
  }
  if (token === "return") {
    return "enter";
  }
  if (token === "pgup" || token === "page up") {
    return "pageup";
  }
  if (token === "pgdown" || token === "page down") {
    return "pagedown";
  }
  if (token === "plus" || token === "+") {
    return "+";
  }
  if (token === "minus" || token === "-") {
    return "-";
  }
  if (token === "equal" || token === "equals" || token === "=") {
    return "=";
  }
  if (token === "space" || token === "spacebar") {
    return " ";
  }
  return token;
}

function eventKey(ev: KeyboardEvent): string {
  if (ev.key === " ") {
    return " ";
  }
  if (ev.key.length === 1) {
    return ev.key.toLowerCase();
  }
  return ev.key.toLowerCase();
}
