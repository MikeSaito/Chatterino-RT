/** Inline SVG icons for chrome controls (stroke, currentColor). */

export type IconName =
  | "settings"
  | "more"
  | "emote"
  | "send"
  | "close"
  | "search"
  | "pin"
  | "reply"
  | "chevron-down"
  | "check"
  | "plus"
  | "minus"
  | "warning"
  | "arrow-down"
  | "play"
  | "viewers"
  | "live-dot"
  | "copy";

const PATHS: Record<IconName, string> = {
  settings:
    '<path d="M12 15.5a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7z"/><path d="M19.4 13a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09c0 .66.39 1.26 1 1.51a1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82c.25.62.86 1.02 1.51 1.02H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/>',
  more: '<circle cx="12" cy="5" r="1.25" fill="currentColor" stroke="none"/><circle cx="12" cy="12" r="1.25" fill="currentColor" stroke="none"/><circle cx="12" cy="19" r="1.25" fill="currentColor" stroke="none"/>',
  emote:
    '<circle cx="12" cy="12" r="9"/><path d="M8 14s1.5 2 4 2 4-2 4-2"/><circle cx="9" cy="10" r="0.75" fill="currentColor" stroke="none"/><circle cx="15" cy="10" r="0.75" fill="currentColor" stroke="none"/>',
  send: '<path d="M4 12l15-7-7 15-2-6-6-2z"/>',
  close: '<path d="M6 6l12 12M18 6L6 18"/>',
  search:
    '<circle cx="11" cy="11" r="6"/><path d="M20 20l-4-4"/>',
  pin: '<path d="M12 17v5M9 3h6l-1 7h3l-5 5-5-5h3L9 3z"/>',
  reply: '<path d="M9 17l-5-5 5-5M4 12h11a5 5 0 0 1 0 10h-2"/>',
  "chevron-down": '<path d="M6 9l6 6 6-6"/>',
  check: '<path d="M5 12l5 5L20 7"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  minus: '<path d="M5 12h14"/>',
  warning:
    '<path d="M12 3l9 16H3L12 3z"/><path d="M12 10v4"/><circle cx="12" cy="16.5" r="0.75" fill="currentColor" stroke="none"/>',
  "arrow-down": '<path d="M12 5v14M6 13l6 6 6-6"/>',
  play: '<path d="M8 5.5v13l11-6.5L8 5.5z" fill="currentColor" stroke="none"/>',
  viewers:
    '<path d="M17 21v-2a4 4 0 0 0-4-4H7a4 4 0 0 0-4 4v2"/><circle cx="10" cy="7" r="4"/><path d="M21 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75"/>',
  "live-dot":
    '<circle cx="12" cy="12" r="5" fill="currentColor" stroke="none"/>',
  copy: '<rect x="8" y="8" width="12" height="12" rx="1.5"/><path d="M6 16V6a2 2 0 0 1 2-2h10"/>',
};

export function iconSvg(name: IconName, size = 16): string {
  const body = PATHS[name];
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false" class="ui-icon">${body}</svg>`;
}

export function iconEl(name: IconName, size = 16): SVGElement {
  const wrap = document.createElement("span");
  wrap.innerHTML = iconSvg(name, size);
  const svg = wrap.firstElementChild;
  if (!(svg instanceof SVGElement)) {
    throw new Error(`iconEl: failed to parse ${name}`);
  }
  return svg;
}

export function setButtonIcon(
  btn: HTMLButtonElement,
  name: IconName,
  opts?: { size?: number; label?: string },
): void {
  const size = opts?.size ?? 16;
  if (opts?.label) {
    btn.setAttribute("aria-label", opts.label);
    if (!btn.title) {
      btn.title = opts.label;
    }
  }
  btn.replaceChildren(iconEl(name, size));
}

export function hasIcon(name: string): name is IconName {
  return Object.prototype.hasOwnProperty.call(PATHS, name);
}
