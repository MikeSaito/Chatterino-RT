/**
 * Stream meta strip under the Extended player (Helix ChannelLive).
 * Quality/bitrate/FPS are not available from Helix or the embed iframe.
 */

import type { ChannelLive } from "../chat/types.ts";
import { t } from "../i18n/index.ts";
import {
  channelMetaParts,
  type HeaderKnobs,
} from "./channelHeader.ts";

export type PlayerMetaPaint = {
  root: HTMLElement;
  stream: ChannelLive | null | undefined;
  knobs: HeaderKnobs;
  /** When false, clear the strip (Classic / no channel). */
  enabled: boolean;
};

export function paintPlayerMeta(opts: PlayerMetaPaint): void {
  const { root } = opts;
  root.replaceChildren();
  if (!opts.enabled) {
    return;
  }
  const stream = opts.stream;
  // No Helix snapshot yet: leave empty (:empty hides the strip) to avoid Offline flash.
  if (!stream) {
    return;
  }
  if (!stream.live) {
    const offline = document.createElement("span");
    offline.className = "player-meta-offline";
    offline.textContent = t("player.meta.offline");
    root.appendChild(offline);
    return;
  }

  const live = document.createElement("span");
  live.className = "player-meta-live";
  live.textContent = t("player.meta.live");
  root.appendChild(live);

  const parts = channelMetaParts(stream.channel, stream, opts.knobs);
  if (parts.viewers) {
    const viewers = document.createElement("span");
    viewers.className = "player-meta-viewers";
    viewers.textContent = `${t("player.meta.viewers")}: ${parts.viewers}`;
    root.appendChild(viewers);
  }
  if (parts.uptime) {
    const uptime = document.createElement("span");
    uptime.textContent = parts.uptime;
    root.appendChild(uptime);
  }
  if (parts.game) {
    const game = document.createElement("span");
    game.textContent = parts.game;
    root.appendChild(game);
  }
  if (parts.streamTitle) {
    const title = document.createElement("span");
    title.className = "player-meta-title";
    title.textContent = parts.streamTitle;
    title.title = parts.streamTitle;
    root.appendChild(title);
  }
  if (stream.language) {
    const lang = document.createElement("span");
    lang.className = "player-meta-chip";
    lang.textContent = stream.language.toUpperCase();
    root.appendChild(lang);
  }
  if (stream.isMature) {
    const mature = document.createElement("span");
    mature.className = "player-meta-chip";
    mature.textContent = t("player.meta.mature");
    root.appendChild(mature);
  }
  const tags = stream.tags ?? [];
  for (const tag of tags.slice(0, 4)) {
    const chip = document.createElement("span");
    chip.className = "player-meta-chip";
    chip.textContent = tag;
    root.appendChild(chip);
  }
}
