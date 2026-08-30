/**
 * Active IRC ROOMSTATE chips above the chat message strip.
 */

import { t } from "../i18n/index.ts";

export type ChannelRoomState = {
  channel: string;
  emoteOnly: boolean;
  subsOnly: boolean;
  slowSec: number;
  /** Twitch followers-only minutes; -1 = off. */
  followersOnly: number;
};

export function paintChatModes(
  root: HTMLElement,
  modes: ChannelRoomState | null | undefined,
): void {
  root.replaceChildren();
  if (!modes) {
    root.hidden = true;
    return;
  }
  const chips: string[] = [];
  if (modes.emoteOnly) {
    chips.push(t("chat.modes.emoteOnly"));
  }
  if (modes.subsOnly) {
    chips.push(t("chat.modes.subsOnly"));
  }
  if (modes.followersOnly >= 0) {
    if (modes.followersOnly === 0) {
      chips.push(t("chat.modes.followers"));
    } else {
      chips.push(
        t("chat.modes.followersMin", { minutes: modes.followersOnly }),
      );
    }
  }
  if (modes.slowSec > 0) {
    chips.push(t("chat.modes.slow", { seconds: modes.slowSec }));
  }
  if (chips.length === 0) {
    root.hidden = true;
    return;
  }
  root.hidden = false;
  for (const label of chips) {
    const chip = document.createElement("span");
    chip.className = "chat-modes-chip";
    chip.textContent = label;
    root.appendChild(chip);
  }
}
