import { iconEl, type IconName } from "./icons";

const ACTION_ICONS: Record<string, IconName> = {
  copy: "copy",
  "copy-full": "copy",
  "copy-id": "copy",
  "copy-json": "copy",
  "copy-link": "link",
  "open-link": "external",
  "open-link-incognito": "external",
  "open-twitch": "external",
  "open-streamlink": "play",
  "open-custom-player": "play",
  reply: "reply",
  "reply-original": "reply",
  thread: "reply",
  user: "user",
  "web-search": "search",
};

const ACTION_SHORTCUTS: Record<string, string> = {
  copy: "Ctrl+C",
  "copy-full": "Ctrl+Shift+C",
};

export function setContextMenuLabel(btn: HTMLButtonElement, label: string): void {
  const text = btn.querySelector<HTMLElement>(".chat-context-label");
  if (text) {
    text.textContent = label;
    return;
  }
  btn.textContent = label;
}

function decorateButton(btn: HTMLButtonElement): void {
  const action = btn.dataset.action?.trim();
  if (!action || btn.classList.contains("chat-context-submenu-label")) {
    return;
  }
  if (btn.querySelector(".chat-context-icon")) {
    return;
  }
  const label = btn.textContent?.trim() ?? "";
  if (!label) {
    return;
  }
  btn.replaceChildren();
  const iconName = ACTION_ICONS[action];
  if (iconName) {
    const iconWrap = document.createElement("span");
    iconWrap.className = "chat-context-icon";
    iconWrap.append(iconEl(iconName, 16));
    btn.append(iconWrap);
  }
  const text = document.createElement("span");
  text.className = "chat-context-label";
  text.textContent = label;
  btn.append(text);
  const shortcut = ACTION_SHORTCUTS[action];
  if (shortcut) {
    const hint = document.createElement("span");
    hint.className = "chat-context-shortcut";
    hint.textContent = shortcut;
    btn.append(hint);
  }
  if (action.includes("ban") || btn.classList.contains("is-danger")) {
    btn.classList.add("is-danger");
  }
}

/** Icons and shortcut hints for chat context menu rows. */
export function applyContextMenuChrome(menu: HTMLElement): void {
  menu.querySelectorAll<HTMLButtonElement>("button[data-action]").forEach(decorateButton);
  const submenuLabels = menu.querySelectorAll<HTMLButtonElement>(
    ".chat-context-submenu-label",
  );
  for (const btn of submenuLabels) {
    if (btn.querySelector(".chat-context-icon")) {
      continue;
    }
    const label = btn.textContent?.trim() ?? "";
    btn.replaceChildren();
    const iconWrap = document.createElement("span");
    iconWrap.className = "chat-context-icon";
    iconWrap.append(iconEl("chevron-right", 12));
    btn.append(iconWrap);
    const text = document.createElement("span");
    text.className = "chat-context-label";
    text.textContent = label;
    btn.append(text);
  }
}
