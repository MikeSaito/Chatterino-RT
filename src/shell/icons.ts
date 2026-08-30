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
  | "copy"
  | "link"
  | "external"
  | "trash"
  | "edit"
  | "refresh"
  | "pin-off"
  | "chevron-up"
  | "chevron-left"
  | "chevron-right"
  | "clock"
  | "heart"
  | "star"
  | "user"
  | "bell"
  | "filter"
  | "keyboard"
  | "shield"
  | "info"
  | "slash";

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
  link: '<path d="M10 13a4.5 4.5 0 0 0 6.4 0l2.1-2.1a4.5 4.5 0 0 0-6.4-6.4L11 5"/><path d="M14 11a4.5 4.5 0 0 0-6.4 0L5.5 13.1a4.5 4.5 0 0 0 6.4 6.4L13 19"/>',
  external:
    '<path d="M15 3h6v6M10 14L21 3M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/>',
  trash:
    '<path d="M4 7h16M10 11v6M14 11v6M6 7l1 12a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-12M9 7V5a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"/>',
  edit: '<path d="M12 20h9M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4 12.5-12.5z"/>',
  refresh:
    '<path d="M21 12a9 9 0 1 1-3-6.7"/><path d="M21 3v6h-6"/>',
  "pin-off":
    '<path d="M12 17v5M9 3h6l-1 7h3l-5 5-5-5h3L9 3z"/><path d="M3 3l18 18"/>',
  "chevron-up": '<path d="M6 15l6-6 6 6"/>',
  "chevron-left": '<path d="M15 6l-6 6 6 6"/>',
  "chevron-right": '<path d="M9 6l6 6-6 6"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  heart:
    '<path d="M12 21s-7-4.5-9.5-9A5.2 5.2 0 0 1 12 6.2 5.2 5.2 0 0 1 21.5 12C19 16.5 12 21 12 21z"/>',
  star:
    '<path d="M12 3l2.4 4.9 5.4.8-3.9 3.8.9 5.3L12 15.8 6.2 17.8l.9-5.3L3.2 8.7l5.4-.8L12 3z"/>',
  user:
    '<path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/>',
  bell:
    '<path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9"/><path d="M10 21a2 2 0 0 0 4 0"/>',
  filter:
    '<path d="M4 5h16l-6 7v5l-4 2v-7L4 5z"/>',
  keyboard:
    '<rect x="3" y="6" width="18" height="12" rx="2"/><path d="M7 10h.01M11 10h.01M15 10h.01M7 14h10"/>',
  shield: '<path d="M12 3l8 3v6c0 5-3.5 8.5-8 10-4.5-1.5-8-5-8-10V6l8-3z"/>',
  info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v5M12 8h.01"/>',
  slash: '<circle cx="12" cy="12" r="9"/><path d="M5 5l14 14"/>',
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
