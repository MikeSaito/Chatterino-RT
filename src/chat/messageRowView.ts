import { BitmapText, Container, Graphics, Rectangle, Sprite, Texture } from "pixi.js";
import type { ClipCardWidgets } from "./clipCardPixi";

export type MessageRowView = {
  root: Container;
  highlight: Graphics;
  highlightPainted: boolean;
  systemCloud: Graphics;
  mentions: Graphics;
  linksPainted: boolean;
  disabledGfx: Graphics;
  disabledPaint: { w: number; h: number; color: number; alpha: number } | null;
  time: BitmapText;
  nick: BitmapText;
  /** Gradient nick overlay (7TV paint); BitmapText hidden when visible. */
  nickPaintSpr: Sprite;
  nickPaintKey: string;
  /** First wrap line (x after nick). */
  body: BitmapText;
  /** Wrap lines 2+ (x under timestamp); empty when single-line. */
  bodyCont: BitmapText;
  replyHeader: BitmapText;
  mentionTexts: BitmapText[];
  hostTexts: BitmapText[];
  bitsLabel: BitmapText;
  emotes: Sprite[];
  emoteKeys: string[];
  badges: Sprite[];
  badgeKeys: string[];
  modBtns: BitmapText[];
  modIcons: Sprite[];
  modBtnHits: Array<{ x0: number; x1: number; action: string }>;
  automodBtnHits: Array<{
    x0: number;
    x1: number;
    y0: number;
    y1: number;
    action: "allow" | "deny";
  }>;
  caughtTexts: BitmapText[];
  clipUi: ClipCardWidgets | null;
};

export function createMessageRowView(opts: {
  fontSize: number;
  lineHeight: number;
  timestampFill: number;
  bodyFill: number;
}): MessageRowView {
  const root = new Container();
  root.visible = false;
  root.eventMode = "static";
  root.hitArea = new Rectangle(0, 0, 1, opts.lineHeight);
  const hl = new Graphics();
  hl.eventMode = "none";
  const systemCloud = new Graphics();
  systemCloud.eventMode = "none";
  const mentions = new Graphics();
  mentions.eventMode = "none";
  const disabledGfx = new Graphics();
  disabledGfx.eventMode = "none";
  const time = new BitmapText({
    text: "",
    style: {
      fontFamily: "ChatFont",
      fontSize: opts.fontSize,
      lineHeight: opts.lineHeight,
      fill: opts.timestampFill,
    },
  });
  const nick = new BitmapText({
    text: "",
    style: {
      fontFamily: "ChatNickFont",
      fontSize: opts.fontSize,
      lineHeight: opts.lineHeight,
      fill: 0xffffff,
    },
  });
  const nickPaintSpr = new Sprite(Texture.EMPTY);
  nickPaintSpr.visible = false;
  nickPaintSpr.eventMode = "none";
  const body = new BitmapText({
    text: "",
    style: {
      fontFamily: "ChatFont",
      fontSize: opts.fontSize,
      fill: opts.bodyFill,
      lineHeight: opts.lineHeight,
    },
  });
  body.eventMode = "none";
  const bodyCont = new BitmapText({
    text: "",
    style: {
      fontFamily: "ChatFont",
      fontSize: opts.fontSize,
      fill: opts.bodyFill,
      lineHeight: opts.lineHeight,
    },
  });
  bodyCont.visible = false;
  bodyCont.eventMode = "none";
  const replyHeader = new BitmapText({
    text: "",
    style: {
      fontFamily: "ChatFont",
      fontSize: Math.max(8, Math.round(opts.fontSize * 0.85)),
      fill: opts.timestampFill,
    },
  });
  replyHeader.visible = false;
  replyHeader.eventMode = "none";
  const emotes: Sprite[] = [];
  const mentionTexts: BitmapText[] = [];
  const hostTexts: BitmapText[] = [];
  const bitsLabel = new BitmapText({
    text: "",
    style: {
      fontFamily: "ChatFont",
      fontSize: opts.fontSize,
      lineHeight: opts.lineHeight,
      fill: 0x9c34ff,
    },
  });
  bitsLabel.visible = false;
  bitsLabel.eventMode = "none";
  const badges: Sprite[] = [];
  const modBtns: BitmapText[] = [];
  const modIcons: Sprite[] = [];
  const caughtTexts: BitmapText[] = [];
  // body / bodyCont under nick so nick stays readable if chrome widths drift
  root.addChild(
    systemCloud,
    hl,
    mentions,
    ...modBtns,
    ...modIcons,
    replyHeader,
    time,
    body,
    bodyCont,
    nick,
    nickPaintSpr,
    ...mentionTexts,
    ...hostTexts,
    ...caughtTexts,
    bitsLabel,
    ...badges,
    ...emotes,
    disabledGfx,
  );
  return {
    root,
    highlight: hl,
    highlightPainted: false,
    systemCloud,
    mentions,
    linksPainted: false,
    disabledGfx,
    disabledPaint: null,
    time,
    nick,
    nickPaintSpr,
    nickPaintKey: "",
    body,
    bodyCont,
    replyHeader,
    mentionTexts,
    hostTexts,
    bitsLabel,
    emotes,
    emoteKeys: [],
    badges,
    badgeKeys: [],
    modBtns,
    modIcons,
    modBtnHits: [],
    automodBtnHits: [],
    caughtTexts,
    clipUi: null,
  };
}
