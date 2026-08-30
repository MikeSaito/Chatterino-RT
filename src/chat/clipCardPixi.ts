/** Pixi clip preview card owned by a chat message slot root. */

import {
  BitmapText,
  Container,
  Graphics,
  Sprite,
  Texture,
} from "pixi.js";
import { t } from "../i18n";
import {
  formatClipAge,
  formatClipDuration,
  formatClipViews,
  type ClipCardInfo,
} from "./linkEnrichment";
import {
  CLIP_CARD_BG,
  CLIP_CARD_BORDER,
  CLIP_CARD_GAP_PX,
  CLIP_CARD_HEIGHT_PX,
  CLIP_CARD_MAX_W,
  CLIP_CARD_META_GAP,
  CLIP_CARD_RADIUS,
  CLIP_CARD_THUMB_W,
  CLIP_CARD_TITLE_COLOR,
} from "../shell/clipCards";
import type { TextureLru } from "./textures";

export type ClipCardWidgets = {
  root: Container;
  bg: Graphics;
  thumb: Sprite;
  thumbKey: string;
  durationBg: Graphics;
  duration: BitmapText;
  title: BitmapText;
  game: BitmapText;
  foot: BitmapText;
  width: number;
};

export function clipCardRowCount(lineHeight: number): number {
  if (lineHeight <= 0) {
    return 0;
  }
  return Math.max(
    1,
    Math.ceil((CLIP_CARD_HEIGHT_PX + CLIP_CARD_GAP_PX) / lineHeight),
  );
}

export function createClipCardWidgets(mutedFill: number): ClipCardWidgets {
  const root = new Container();
  root.visible = false;
  root.eventMode = "none";
  const bg = new Graphics();
  bg.eventMode = "none";
  const thumb = new Sprite(Texture.EMPTY);
  thumb.eventMode = "none";
  const durationBg = new Graphics();
  durationBg.eventMode = "none";
  const duration = new BitmapText({
    text: "",
    style: { fontFamily: "ChatFont", fontSize: 11, fill: 0xffffff },
  });
  duration.eventMode = "none";
  const title = new BitmapText({
    text: "",
    style: {
      fontFamily: "ChatFont",
      fontSize: 13,
      fill: CLIP_CARD_TITLE_COLOR,
    },
  });
  title.eventMode = "none";
  const game = new BitmapText({
    text: "",
    style: { fontFamily: "ChatFont", fontSize: 12, fill: mutedFill },
  });
  game.eventMode = "none";
  const foot = new BitmapText({
    text: "",
    style: { fontFamily: "ChatFont", fontSize: 12, fill: mutedFill },
  });
  foot.eventMode = "none";
  root.addChild(bg, thumb, durationBg, duration, title, game, foot);
  return {
    root,
    bg,
    thumb,
    thumbKey: "",
    durationBg,
    duration,
    title,
    game,
    foot,
    width: 0,
  };
}

export function releaseClipThumb(
  clip: ClipCardWidgets,
  textures: TextureLru,
): void {
  if (clip.thumbKey) {
    textures.release(clip.thumbKey);
    clip.thumbKey = "";
  }
  clip.thumb.texture = Texture.EMPTY;
  clip.thumb.visible = false;
}

export function hideClipCard(clip: ClipCardWidgets): void {
  clip.root.visible = false;
  clip.width = 0;
  clip.bg.clear();
  clip.durationBg.clear();
  clip.duration.text = "";
  clip.title.text = "";
  clip.game.text = "";
  clip.game.visible = false;
  clip.foot.text = "";
}

function dirtyBitmapText(bt: BitmapText): void {
  const prev = bt.text;
  bt.text = prev.length > 0 ? "" : " ";
  bt.text = prev;
}

function clipTextToWidth(
  text: string,
  maxPx: number,
  measure: (s: string) => number,
): string {
  const limit = Math.max(4, Math.floor(maxPx));
  if (measure(text) <= limit) {
    return text;
  }
  const ellipsis = "...";
  const ellipsisW = measure(ellipsis);
  const budget = Math.max(0, limit - ellipsisW);
  let best = ellipsis;
  let lo = 0;
  let hi = text.length;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const candidate = text.slice(0, mid);
    if (measure(candidate) <= budget) {
      best = `${candidate}${ellipsis}`;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return best;
}

export function paintClipCard(opts: {
  clip: ClipCardWidgets;
  info: ClipCardInfo | null;
  clipCardRows: number;
  lineCount: number;
  lineHeight: number;
  bodyContIndent: number;
  bodyIndent: number;
  paneW: number;
  fontSize: number;
  mutedFill: number;
  textures: TextureLru;
  measure: (s: string) => number;
  applySprite: (spr: Sprite, tex: Texture, w: number, h: number) => void;
  stillCurrent: () => boolean;
}): void {
  const {
    clip,
    info,
    clipCardRows,
    lineCount,
    lineHeight,
    bodyContIndent,
    bodyIndent,
    paneW,
    fontSize,
    mutedFill,
    textures,
    measure,
    applySprite,
    stillCurrent,
  } = opts;

  if (!info || clipCardRows <= 0) {
    releaseClipThumb(clip, textures);
    hideClipCard(clip);
    return;
  }

  const left = Math.max(8, bodyContIndent || bodyIndent || 8);
  const maxW = Math.max(120, paneW - left - 12);
  const width = Math.min(CLIP_CARD_MAX_W, maxW);
  const bodyRows = Math.max(0, lineCount - clipCardRows);
  clip.width = width;
  clip.root.visible = true;
  clip.root.x = left;
  clip.root.y = bodyRows * lineHeight + CLIP_CARD_GAP_PX;

  clip.bg.clear();
  clip.bg
    .roundRect(0, 0, width, CLIP_CARD_HEIGHT_PX, CLIP_CARD_RADIUS)
    .fill({ color: CLIP_CARD_BG, alpha: 0.94 })
    .stroke({ width: 1, color: CLIP_CARD_BORDER, alpha: 0.18 });

  const thumbW = Math.min(CLIP_CARD_THUMB_W, Math.max(48, width - 40));
  clip.thumb.x = 0;
  clip.thumb.y = 0;
  if (info.thumbnailUrl) {
    const key = `clip:${info.clipId}`;
    if (clip.thumbKey !== key) {
      releaseClipThumb(clip, textures);
      clip.thumbKey = key;
      textures.acquire(key);
      void textures.load(key, info.thumbnailUrl, false).then((tex) => {
        if (tex && clip.thumbKey === key && stillCurrent()) {
          applySprite(clip.thumb, tex, thumbW, CLIP_CARD_HEIGHT_PX);
          clip.thumb.visible = true;
        }
      });
    } else if (clip.thumb.texture !== Texture.EMPTY) {
      applySprite(clip.thumb, clip.thumb.texture, thumbW, CLIP_CARD_HEIGHT_PX);
      clip.thumb.visible = true;
    } else {
      clip.thumb.visible = false;
    }
  } else {
    releaseClipThumb(clip, textures);
  }

  const durText = formatClipDuration(info.durationSec);
  clip.duration.style.fontSize = 11;
  clip.duration.style.fill = 0xffffff;
  clip.duration.text = durText;
  dirtyBitmapText(clip.duration);
  const durW = Math.ceil(measure(durText) + 10);
  const durH = 16;
  const durX = thumbW - durW - 6;
  const durY = CLIP_CARD_HEIGHT_PX - durH - 6;
  clip.durationBg.clear();
  clip.durationBg
    .roundRect(durX, durY, durW, durH, 4)
    .fill({ color: 0x000000, alpha: 0.78 });
  clip.duration.x = durX + 5;
  clip.duration.y = durY + 2;

  const metaX = thumbW + CLIP_CARD_META_GAP;
  const metaW = Math.max(24, width - metaX - 10);
  const metaFont = Math.max(10, Math.min(13, fontSize));

  clip.title.style.fontSize = metaFont;
  clip.title.style.fill = CLIP_CARD_TITLE_COLOR;
  clip.title.text = clipTextToWidth(info.title, metaW, measure);
  dirtyBitmapText(clip.title);
  clip.title.x = metaX;
  clip.title.y = 10;

  const gameLine = info.gameName
    ? t("clipCard.playing", { game: info.gameName })
    : "";
  if (gameLine) {
    clip.game.visible = true;
    clip.game.style.fontSize = Math.max(9, metaFont - 1);
    clip.game.style.fill = mutedFill;
    clip.game.text = clipTextToWidth(gameLine, metaW, measure);
    dirtyBitmapText(clip.game);
    clip.game.x = metaX;
    clip.game.y = 28;
  } else {
    clip.game.visible = false;
    clip.game.text = "";
  }

  const who = info.creatorName || info.broadcasterName;
  const foot = [who, formatClipViews(info.viewCount), formatClipAge(info.createdAt)]
    .filter(Boolean)
    .join(" · ");
  clip.foot.style.fontSize = Math.max(9, metaFont - 1);
  clip.foot.style.fill = mutedFill;
  clip.foot.text = clipTextToWidth(foot, metaW, measure);
  dirtyBitmapText(clip.foot);
  clip.foot.x = metaX;
  clip.foot.y = gameLine ? 46 : 32;
}

export function clipCardContains(
  clip: ClipCardWidgets,
  localX: number,
  localY: number,
): boolean {
  if (!clip.root.visible || clip.width <= 0) {
    return false;
  }
  return (
    localX >= clip.root.x &&
    localX < clip.root.x + clip.width &&
    localY >= clip.root.y &&
    localY < clip.root.y + CLIP_CARD_HEIGHT_PX
  );
}
