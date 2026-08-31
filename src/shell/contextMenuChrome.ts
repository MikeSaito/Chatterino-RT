import { iconEl, type IconName } from "./icons";
import { t, type MessageKey } from "../i18n";

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
  pin: "pin",
  unpin: "pin-off",
};

const ACTION_SHORTCUTS: Record<string, string> = {
  copy: "Ctrl+C",
  "copy-full": "Ctrl+Shift+C",
};

const ACTION_LABELS: Record<string, MessageKey> = {
  copy: "context.copyMessage",
  "copy-full": "context.copyFull",
  "copy-id": "context.copyId",
  "copy-json": "context.copyJson",
  "open-link": "context.openLink",
  "open-link-incognito": "context.openLinkIncognito",
  "copy-link": "context.copyLink",
  reply: "context.reply",
  "reply-original": "context.replyOriginal",
  thread: "context.thread",
  user: "context.user",
  "open-twitch": "context.openTwitch",
  "open-streamlink": "context.openStreamlink",
  "open-custom-player": "context.openCustomPlayer",
  unpin: "context.unpin",
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
    iconWrap.append(iconEl(iconName, 14));
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
}

function applyStaticLabels(menu: HTMLElement): void {
  for (const [action, key] of Object.entries(ACTION_LABELS)) {
    const btn = menu.querySelector<HTMLButtonElement>(
      `button[data-action="${action}"]`,
    );
    if (btn) {
      setContextMenuLabel(btn, t(key));
    }
  }
  const openLab = menu.querySelector<HTMLButtonElement>(
    "#chat-context-image-open .chat-context-submenu-label",
  );
  if (openLab) {
    setContextMenuLabel(openLab, t("context.open"));
  }
  const copyLab = menu.querySelector<HTMLButtonElement>(
    "#chat-context-image-copy .chat-context-submenu-label",
  );
  if (copyLab) {
    setContextMenuLabel(copyLab, t("context.copy"));
  }
  const moderateLab = menu.querySelector<HTMLButtonElement>(
    "#chat-context-moderate > .chat-context-submenu-label",
  );
  if (moderateLab) {
    setContextMenuLabel(moderateLab, t("context.moderate"));
  }
  const pinLab = menu.querySelector<HTMLButtonElement>(
    "#chat-context-pin > .chat-context-submenu-label",
  );
  if (pinLab) {
    setContextMenuLabel(pinLab, t("context.pin"));
  }
  const pinDurationLabels: Array<[string, MessageKey]> = [
    ["", "context.pinUntilEnd"],
    ["60", "context.pin1m"],
    ["600", "context.pin10m"],
    ["1800", "context.pin30m"],
  ];
  for (const [duration, key] of pinDurationLabels) {
    const btn = menu.querySelector<HTMLButtonElement>(
      `button[data-action="pin"][data-duration="${duration}"]`,
    );
    if (btn) {
      setContextMenuLabel(btn, t(key));
    }
  }
}

/** Icons and shortcut hints for chat context menu rows. */
export function applyContextMenuChrome(menu: HTMLElement): void {
  applyStaticLabels(menu);
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
