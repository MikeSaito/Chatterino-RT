import { setButtonIcon, type IconName } from "./icons";
import { t, type MessageKey } from "../i18n";

type ChromeIcon = {
  id: string;
  name: IconName;
  size?: number;
  labelKey?: MessageKey;
};

const CHROME: ChromeIcon[] = [
  { id: "header-more", name: "more", labelKey: "header.more" },
  { id: "join-toggle", name: "plus", labelKey: "sidebar.join.toggle" },
  { id: "settings-open", name: "settings", labelKey: "settings.open" },
  { id: "emote-open", name: "emote", labelKey: "composer.emotes" },
  { id: "composer-send", name: "send", labelKey: "composer.send.aria" },
  { id: "chat-jump-bottom", name: "arrow-down", labelKey: "chat.jumpBottom" },
  { id: "reply-cancel", name: "close", labelKey: "reply.cancel" },
  { id: "search-close", name: "close", labelKey: "find.close" },
  { id: "search-clear", name: "close", labelKey: "find.clear.aria" },
  { id: "usercard-close", name: "close", labelKey: "usercard.close" },
  { id: "usercard-pin", name: "pin", labelKey: "usercard.pin" },
  { id: "notes-close", name: "close", labelKey: "notes.close" },
  { id: "replythread-close", name: "close", labelKey: "thread.close" },
  { id: "replythread-pin", name: "pin", labelKey: "thread.pin" },
  { id: "emotepopup-close", name: "close", labelKey: "emotes.close" },
];

/** Fill empty icon buttons declared in index.html. */
export function applyChromeIcons(root: ParentNode = document): void {
  for (const item of CHROME) {
    const btn = root.querySelector<HTMLButtonElement>(`#${item.id}`);
    if (!btn) {
      continue;
    }
    const preserveBadge =
      item.id === "chat-jump-bottom"
        ? btn.querySelector<HTMLElement>("#chat-jump-badge")
        : null;
    const label = item.labelKey ? t(item.labelKey) : undefined;
    setButtonIcon(btn, item.name, { size: item.size ?? 16, label });
    if (preserveBadge) {
      btn.appendChild(preserveBadge);
    }
  }
}
