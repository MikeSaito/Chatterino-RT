/**
 * Active IRC ROOMSTATE status in the header (right cluster).
 */

import { t } from "../i18n/index.ts";
import { iconEl, type IconName } from "./icons.ts";

export type ChannelRoomState = {
  channel: string;
  emoteOnly: boolean;
  subsOnly: boolean;
  slowSec: number;
  /** Twitch followers-only minutes; -1 = off. */
  followersOnly: number;
};

type ModeChip = { icon: IconName; label: string; title: string };

function modeChips(modes: ChannelRoomState): ModeChip[] {
  const chips: ModeChip[] = [];
  if (modes.emoteOnly) {
    chips.push({
      icon: "emote",
      label: t("chat.modes.emoteShort"),
      title: t("chat.modes.emoteOnly"),
    });
  }
  if (modes.subsOnly) {
    chips.push({
      icon: "star",
      label: t("chat.modes.subsShort"),
      title: t("chat.modes.subsOnly"),
    });
  }
  if (modes.followersOnly >= 0) {
    const label =
      modes.followersOnly === 0
        ? t("chat.modes.followers")
        : t("chat.modes.followersShort", { minutes: modes.followersOnly });
    chips.push({
      icon: "heart",
      label,
      title:
        modes.followersOnly === 0
          ? t("chat.modes.followers")
          : t("chat.modes.followersMin", { minutes: modes.followersOnly }),
    });
  }
  if (modes.slowSec > 0) {
    chips.push({
      icon: "clock",
      label: t("chat.modes.slowShort", { seconds: modes.slowSec }),
      title: t("chat.modes.slow", { seconds: modes.slowSec }),
    });
  }
  return chips;
}

export function paintChatModes(
  root: HTMLElement,
  modes: ChannelRoomState | null | undefined,
): void {
  root.replaceChildren();
  if (!modes) {
    root.hidden = true;
    return;
  }
  const chips = modeChips(modes);
  if (chips.length === 0) {
    root.hidden = true;
    return;
  }
  root.hidden = false;
  for (const chip of chips) {
    const el = document.createElement("span");
    el.className = "header-chat-mode";
    el.title = chip.title;
    el.append(iconEl(chip.icon, 14), document.createTextNode(chip.label));
    root.appendChild(el);
  }
}
