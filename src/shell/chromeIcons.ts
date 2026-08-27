import { setButtonIcon, type IconName } from "./icons";

type ChromeIcon = {
  id: string;
  name: IconName;
  size?: number;
  label?: string;
};

const CHROME: ChromeIcon[] = [
  { id: "header-more", name: "more", label: "Ещё" },
  { id: "join-toggle", name: "plus", label: "Join channel" },
  { id: "settings-open", name: "settings", label: "Настройки" },
  { id: "emote-open", name: "emote", label: "Emotes" },
  { id: "composer-send", name: "send", label: "Send" },
  { id: "chat-jump-bottom", name: "arrow-down", label: "Вниз" },
  { id: "reply-cancel", name: "close", label: "Отмена" },
  { id: "search-close", name: "close", label: "Закрыть" },
  { id: "search-clear", name: "close", label: "Clear search" },
  { id: "usercard-close", name: "close", label: "Close" },
  { id: "usercard-pin", name: "pin", label: "Pin" },
  { id: "notes-close", name: "close", label: "Close" },
  { id: "replythread-close", name: "close", label: "Close" },
  { id: "replythread-pin", name: "pin", label: "Pin" },
  { id: "emotepopup-close", name: "close", label: "Close" },
];

/** Fill empty icon buttons declared in index.html. */
export function applyChromeIcons(root: ParentNode = document): void {
  for (const item of CHROME) {
    const btn = root.querySelector<HTMLButtonElement>(`#${item.id}`);
    if (!btn) {
      continue;
    }
    setButtonIcon(btn, item.name, { size: item.size ?? 16, label: item.label });
  }
}
