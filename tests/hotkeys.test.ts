import {
  bindingFromEvent,
  bindingsMatch,
  matchEvent,
  formatBinding,
  normalizeHotkeyRows,
  parseBinding,
  resolveAction,
  stepZoom,
  configureHotkeys,
  DEFAULT_HOTKEYS,
} from "../src/shell/hotkeys.ts";

const f = parseBinding("Ctrl+F");
if (!f || !f.ctrl || f.shift || f.key !== "f") {
  throw new Error(`Ctrl+F parse failed: ${JSON.stringify(f)}`);
}

const end = parseBinding("Ctrl+End");
if (!end || !end.ctrl || end.key !== "end") {
  throw new Error(`Ctrl+End parse failed: ${JSON.stringify(end)}`);
}

const bad = parseBinding("Ctrl+");
if (bad) {
  throw new Error("empty key must fail");
}

const plus = parseBinding("Ctrl++");
if (!plus || !plus.ctrl || plus.key !== "+") {
  throw new Error(`Ctrl++ parse failed: ${JSON.stringify(plus)}`);
}

const plainF = {
  key: "f",
  ctrlKey: true,
  altKey: false,
  shiftKey: false,
  metaKey: false,
} as KeyboardEvent;
if (!matchEvent(plainF, f)) {
  throw new Error("match Ctrl+F failed");
}

configureHotkeys(DEFAULT_HOTKEYS.map((r) => ({ ...r })));
if (resolveAction(plainF) !== "showSearch") {
  throw new Error("defaults must resolve Ctrl+F to showSearch");
}

configureHotkeys([
  { action: "showSearch", keybinding: "Ctrl+Shift+F", name: "Show search" },
  { action: "scrollToBottom", keybinding: "Ctrl+End", name: "Scroll to bottom" },
]);
const shifted = {
  key: "f",
  ctrlKey: true,
  altKey: false,
  shiftKey: true,
  metaKey: false,
} as KeyboardEvent;
if (resolveAction(shifted) !== "showSearch") {
  throw new Error("remapped showSearch should win");
}
if (resolveAction(plainF) !== null) {
  throw new Error("old Ctrl+F must not match after remap");
}

const conflict = normalizeHotkeyRows([
  { action: "showSearch", keybinding: "Ctrl+F", name: "a" },
  { action: "showSearch", keybinding: "Ctrl+G", name: "b" },
]);
if (conflict.filter((r) => r.action === "showSearch").length !== 1) {
  throw new Error("duplicate actions must collapse");
}
if (conflict.length < DEFAULT_HOTKEYS.length) {
  throw new Error("missing defaults must be filled");
}

if (stepZoom(1, 0) !== 1) {
  throw new Error("zoom reset must be 1");
}
if (stepZoom(1, 1) <= 1) {
  throw new Error("zoom in must increase");
}
if (stepZoom(1, -1) >= 1) {
  throw new Error("zoom out must decrease");
}

const fromEvent = bindingFromEvent(plainF);
if (!fromEvent || !fromEvent.ctrl || fromEvent.key !== "f") {
  throw new Error(`bindingFromEvent Ctrl+F failed: ${JSON.stringify(fromEvent)}`);
}

const modifierOnly = bindingFromEvent({
  key: "Control",
  ctrlKey: true,
  altKey: false,
  shiftKey: false,
  metaKey: false,
} as KeyboardEvent);
if (modifierOnly !== null) {
  throw new Error("modifier-only key must return null");
}

if (formatBinding(f!) !== "Ctrl+F") {
  throw new Error(`formatBinding failed: ${formatBinding(f!)}`);
}

if (!bindingsMatch("Ctrl+F", fromEvent!)) {
  throw new Error("bindingsMatch Ctrl+F must match");
}

const shiftedBinding = bindingFromEvent(shifted);
if (shiftedBinding && bindingsMatch("Ctrl+F", shiftedBinding)) {
  throw new Error("Ctrl+Shift+F must not match Ctrl+F");
}

const plusBinding = parseBinding("Ctrl++");
if (!plusBinding || !bindingsMatch("Ctrl+=", plusBinding)) {
  throw new Error("Ctrl+= must match Ctrl++ binding");
}
