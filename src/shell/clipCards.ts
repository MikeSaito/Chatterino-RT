/** HTML overlay for Twitch clip cards under chat messages. */

import { invoke } from "@tauri-apps/api/core";
import { t } from "../i18n";
import {
  formatClipAge,
  formatClipDuration,
  formatClipViews,
  type ClipCardInfo,
} from "../chat/linkEnrichment";

export type ClipCardAnchor = {
  msgId: string;
  top: number;
  left: number;
  width: number;
  clip: ClipCardInfo;
};

export function bindClipCardLayer(
  host: HTMLElement,
): {
  sync: (anchors: ClipCardAnchor[]) => void;
  stop: () => void;
} {
  const cards = new Map<string, HTMLElement>();

  const open = (url: string): void => {
    void invoke("open_chat_link", { url }).catch(() => undefined);
  };

  const build = (clip: ClipCardInfo): HTMLElement => {
    const el = document.createElement("button");
    el.type = "button";
    el.className = "clip-card";
    el.setAttribute("aria-label", clip.title);

    const thumbWrap = document.createElement("span");
    thumbWrap.className = "clip-card-thumb";
    const img = document.createElement("img");
    img.alt = "";
    img.loading = "lazy";
    if (clip.thumbnailUrl) {
      img.src = clip.thumbnailUrl;
    } else {
      img.hidden = true;
    }
    const dur = document.createElement("span");
    dur.className = "clip-card-duration";
    dur.textContent = formatClipDuration(clip.durationSec);
    thumbWrap.append(img, dur);

    const meta = document.createElement("span");
    meta.className = "clip-card-meta";
    const title = document.createElement("span");
    title.className = "clip-card-title";
    title.textContent = clip.title;
    const game = document.createElement("span");
    game.className = "clip-card-game";
    if (clip.gameName) {
      game.textContent = t("clipCard.playing", { game: clip.gameName });
    } else {
      game.hidden = true;
    }
    const foot = document.createElement("span");
    foot.className = "clip-card-foot";
    const who = clip.creatorName || clip.broadcasterName;
    foot.textContent = [
      who,
      formatClipViews(clip.viewCount),
      formatClipAge(clip.createdAt),
    ]
      .filter(Boolean)
      .join(" · ");
    meta.append(title, game, foot);

    el.append(thumbWrap, meta);
    el.addEventListener("click", (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      open(clip.url);
    });
    return el;
  };

  return {
    sync: (anchors) => {
      const keep = new Set(anchors.map((a) => a.msgId));
      for (const [id, el] of cards) {
        if (!keep.has(id)) {
          el.remove();
          cards.delete(id);
        }
      }
      for (const anchor of anchors) {
        let el = cards.get(anchor.msgId);
        if (!el) {
          el = build(anchor.clip);
          cards.set(anchor.msgId, el);
          host.append(el);
        }
        el.style.top = `${Math.round(anchor.top)}px`;
        el.style.left = `${Math.round(anchor.left)}px`;
        el.style.width = `${Math.max(120, Math.round(anchor.width))}px`;
      }
    },
    stop: () => {
      for (const el of cards.values()) {
        el.remove();
      }
      cards.clear();
    },
  };
}

/** Pixel height reserved under a message for one clip card. */
export const CLIP_CARD_HEIGHT_PX = 84;
