import {
  BitmapFont,
  BitmapText,
  Container,
  FederatedPointerEvent,
  Graphics,
  Rectangle,
  Sprite,
  Texture,
  type Application,
} from "pixi.js";
import { invoke } from "@tauri-apps/api/core";
import {
  BADGE_SIZE,
  BADGE_SLOTS_PER_ROW,
  EMOTE_SLOTS_PER_ROW,
  MENTION_SLOTS_PER_ROW,
  MESSAGE_POOL_SIZE,
} from "../constants";
import type { Badge, ChatEvent, EmoteSpan, LinkSpan, MentionSpan } from "./types";
import { resolveEmojiUrl } from "./emoteUrl";
import { EmoteFrameTicker, TextureLru } from "./textures";
import {
  ScrollModel,
  wheelDeltaRows,
  type LaidSlot,
  type ScrollAnchor,
  type ScrollSnapshot,
} from "./scroll";
import {
  atlasFontSize,
  clampChatFontSize,
  clampChatFontWeight,
  measureFontMetrics,
  measureTextWidth,
  qtWeightToCss,
  qtWeightToPixi,
  sanitizeFontFamily,
} from "./chatFont";
import type { ThemePixiFills } from "../shell/theme";
import type { LastReadPattern } from "../shell/lastRead";
import {
  formatUsername,
  resolveNickColor,
  type UsernameDisplayMode,
} from "../shell/nickStyle";
import { NickColorCache } from "../shell/nickColorCache";
import {
  clipNick,
  collapseWrapLines,
  indexToLineCol,
  lineColToIndex,
  renderWrapped,
  withCollapsedEllipsis,
  wrapBody,
  type WrapLine,
  type WrapOptions,
} from "./wrap";

const TIME_GAP = 8;
const BADGE_GAP = 2;
const MIN_BODY_CHARS = 24;

export type PauseModifier = "None" | "Shift" | "Control" | "Alt" | "Meta";

export type SlotContext = {
  msgId: string;
  login: string;
  /** Автор сообщения (для Reply); = login на клике по нику. */
  authorLogin: string;
  nick: string;
  text: string;
  clientX: number;
  clientY: number;
  disabled: boolean;
  replyToId: string;
  linkUrl: string;
};

type Slot = {
  root: Container;
  highlight: Graphics;
  mentions: Graphics;
  disabledGfx: Graphics;
  time: BitmapText;
  nick: BitmapText;
  body: BitmapText;
  mentionTexts: BitmapText[];
  emotes: Sprite[];
  emoteKeys: string[];
  badges: Sprite[];
  badgeKeys: string[];
  badgesRaw: Badge[];
  msgId: string;
  login: string;
  bodyRaw: string;
  nickRaw: string;
  copyText: string;
  replyToId: string;
  timestampMs: number;
  spansRaw: EmoteSpan[];
  linkSpans: LinkSpan[];
  mentionSpans: MentionSpan[];
  wrapLines: WrapLine[];
  lineCount: number;
  startRow: number;
  highlightColor: string;
  disabled: boolean;
  /** Scrollback snapshot (stock MessageFlag::RecentMessage). */
  fromHistory: boolean;
  /** Privmsg-like: stock MessageFlag::Collapsed + expand on click. */
  collapsible: boolean;
  expanded: boolean;
  /** Set in paintClip when body is truncated this frame. */
  collapsed: boolean;
  /** System/timeout-like: не гасить при room CLEARCHAT (как MessageFlag::System). */
  system: boolean;
  /** Author nick chrome (privmsg); empty → system / fallback. */
  nickUserId: string;
  nickColorRaw: string;
  nickLogin: string;
  nickDisplay: string;
  useNickStyle: boolean;
  replyToLogin: string;
  isAction: boolean;
  /** Символы до reply/action prefix + copyText (system lead у usernotice). */
  leadLen: number;
};

type Drawn = {
  time: string;
  nick: string;
  nickColor: number;
  body: string;
  copyText: string;
  /** Длина lead до reply/action/@-prefix (0 для обычного privmsg). */
  leadLen: number;
  spans: EmoteSpan[];
  links: LinkSpan[];
  mentions: MentionSpan[];
  badges: Badge[];
  highlightColor: string;
};

export class MessageRing {
  private readonly slots: Slot[] = [];
  private readonly textures: TextureLru;
  private readonly emoteTicker = new EmoteFrameTicker();
  private readonly scroll = new ScrollModel();
  private readonly laidBuf: LaidSlot[] = [];
  private occupied = 0;
  private head = 0;
  private highlightMarksGen = 0;
  private highlightMarksCache: string[] = [];
  private highlightMarksCacheGen = -1;
  private ready = false;
  private showTimestamps = true;
  private timestampFormat = "hh:mm";
  private chatFontFamily = "Segoe UI";
  private chatFontSize = 10;
  private chatFontWeight = 50;
  private fontScale = 1;
  private atlasDesignSize = 0;
  private fontSize = 10;
  private lineHeight = Math.ceil(10 * (22 / 15));
  private charWidth = 10 * 0.56;
  private nickCharWidth = 10 * 0.56;
  private badgeSize = BADGE_SIZE;
  private emoteScale = 1;
  private enableEmoteImages = true;
  private enableZeroWidthEmotes = true;
  private removeSpacesBetweenEmotes = false;
  private emojiSet = "Twitter";
  private animateEmotes = true;
  private findHitId = "";
  private hideModerated = false;
  private hideModerationActions = false;
  private hideDeletionActions = false;
  private deletedMessageLengthLimit = 50;
  private fadeMessageHistory = true;
  private hideTimestampsWhenLive = false;
  private channelLive = false;
  private loadingSnapshot = false;
  /** Live msg ids this channel session (survive gap recovery snapshot). */
  private liveMsgIds = new Set<string>();
  private showReplyButton = false;
  private linksDoubleClickOnly = false;
  private alternateMessages = false;
  private separateMessages = false;
  private collapseMessagesMinLines = 0;
  private showLastRead = false;
  private lastReadPattern: LastReadPattern = "Solid";
  private lastReadColor = 0x7f2026;
  private lastReadMsgId = "";
  private colorizeNicknames = true;
  private usernameDisplayMode: UsernameDisplayMode = "UsernameAndLocalizedName";
  private nickBoldScale = 63;
  private nickAtlasDesignSize = 0;
  private boldUsernames = true;
  private colorUsernames = true;
  private readonly nickColorCache = new NickColorCache(500);
  private hideReplyContext = false;
  private pauseMouse = false;
  private pauseKey = false;
  private pauseFollowIntent = false;
  private pauseOnHoverSec = 0;
  private pauseModifier: PauseModifier = "None";
  private wheelMultiplier = 1;
  private hoverPauseTimer = 0;
  private scrollRaf = 0;
  private themeFills: ThemePixiFills = {
    canvasBg: 0x191919,
    body: 0xffffff,
    timestamp: 0x8c7f7f,
    nickFallback: 0x8c7f7f,
    alternate: 0x222222,
    alternateAlpha: 1,
    separator: 0x3c3c3c,
    disabled: 0x191919,
    disabledAlpha: 0x99 / 255,
  };
  private onScroll: ((state: ScrollSnapshot) => void) | undefined;
  private onContext: ((ctx: SlotContext) => void) | undefined;
  private onNickClick: ((ctx: SlotContext) => void) | undefined;
  private onNickRightClick: ((ctx: SlotContext, ev: FederatedPointerEvent) => void) | undefined;

  constructor(
    private readonly app: Application,
    textures: TextureLru,
  ) {
    this.textures = textures;
    this.emoteTicker.subscribe(() => this.tickEmoteFrames());
  }

  setOnScroll(cb: (state: ScrollSnapshot) => void): void {
    this.onScroll = cb;
  }

  /** Highlight colors in scrollback order (empty string = no mark). Stock 1:1 with messages. */
  highlightMarks(): string[] {
    if (this.highlightMarksCacheGen === this.highlightMarksGen) {
      return this.highlightMarksCache;
    }
    const out: string[] = [];
    const start = (this.head - this.occupied + MESSAGE_POOL_SIZE) % MESSAGE_POOL_SIZE;
    for (let i = 0; i < this.occupied; i += 1) {
      const slot = this.slots[(start + i) % MESSAGE_POOL_SIZE];
      out.push(slot.msgId ? slot.highlightColor : "");
    }
    this.highlightMarksCache = out;
    this.highlightMarksCacheGen = this.highlightMarksGen;
    return out;
  }

  /** Cheap stamp for scrollUi: skip rebuild when gen and track height unchanged. */
  highlightMarksGeneration(): number {
    return this.highlightMarksGen;
  }

  private bumpHighlightMarks(): void {
    this.highlightMarksGen += 1;
  }

  setOnContextMenu(cb: (ctx: SlotContext) => void): void {
    this.onContext = cb;
  }

  setOnNickClick(cb: (ctx: SlotContext) => void): void {
    this.onNickClick = cb;
  }

  setOnNickRightClick(
    cb: (ctx: SlotContext, ev: FederatedPointerEvent) => void,
  ): void {
    this.onNickRightClick = cb;
  }

  configureLastReadIndicator(opts: {
    enabled: boolean;
    pattern: LastReadPattern;
    color: number;
  }): void {
    this.showLastRead = opts.enabled;
    this.lastReadPattern = opts.pattern;
    this.lastReadColor = opts.color;
    if (!opts.enabled) {
      this.lastReadMsgId = "";
    }
    if (!this.ready) {
      return;
    }
    this.repaintHighlights();
  }

  /** Capture newest message id when leaving the app (stock updateLastReadMessage). */
  markLastReadAtBottom(): void {
    if (!this.showLastRead || this.occupied === 0) {
      return;
    }
    const idx = (this.head - 1 + MESSAGE_POOL_SIZE) % MESSAGE_POOL_SIZE;
    const id = this.slots[idx]?.msgId ?? "";
    if (id === this.lastReadMsgId) {
      return;
    }
    this.lastReadMsgId = id;
    if (this.ready) {
      this.repaintHighlights();
    }
  }

  private repaintHighlights(): void {
    for (const slot of this.slots) {
      if (slot.msgId) {
        this.paintHighlight(slot);
      }
    }
  }

  configureNickStyle(opts: {
    colorize: boolean;
    mode: UsernameDisplayMode;
    boldScale: number;
  }): void {
    const bold = Math.min(999, Math.max(1, Math.round(opts.boldScale)));
    const boldChanged = bold !== this.nickBoldScale;
    this.colorizeNicknames = opts.colorize;
    this.usernameDisplayMode = opts.mode;
    this.nickBoldScale = bold;
    if (!this.ready) {
      return;
    }
    if (boldChanged || this.nickAtlasDesignSize === 0) {
      this.reinstallNickFont();
    }
    this.refreshFontMetrics();
    for (const slot of this.slots) {
      slot.nick.style.fontFamily = "ChatNickFont";
      slot.nick.style.fontSize = this.fontSize;
      if (slot.useNickStyle) {
        slot.nickRaw = formatUsername({
          login: slot.nickLogin,
          displayName: slot.nickDisplay,
          mode: this.usernameDisplayMode,
        });
        slot.nick.text = slot.nickRaw;
        slot.nick.tint = resolveNickColor({
          color: slot.nickColorRaw,
          userId: slot.nickUserId,
          colorize: this.colorizeNicknames,
          fallback: this.themeFills.nickFallback,
        });
      }
      dirtyBitmapText(slot.nick);
    }
    this.layout();
  }

  configureMentionStyle(opts: { bold: boolean; color: boolean }): void {
    const bold = opts.bold !== false;
    const color = opts.color !== false;
    if (bold === this.boldUsernames && color === this.colorUsernames) {
      return;
    }
    this.boldUsernames = bold;
    this.colorUsernames = color;
    if (!this.ready) {
      return;
    }
    this.layout();
  }

  configureReplyContext(opts: { hide: boolean }): void {
    const hide = opts.hide === true;
    if (hide === this.hideReplyContext) {
      return;
    }
    this.hideReplyContext = hide;
    if (!this.ready) {
      return;
    }
    for (const slot of this.slots) {
      if (slot.msgId) {
        this.reapplyReplyPrefix(slot);
      }
    }
    this.layout();
  }

  configureScrollBehaviour(opts: {
    pauseOnHoverSec: number;
    pauseModifier: string;
    wheelMultiplier: number;
    smoothScrolling?: boolean;
    smoothScrollingNewMessages?: boolean;
  }): void {
    const sec = Number(opts.pauseOnHoverSec);
    this.pauseOnHoverSec = Number.isFinite(sec) ? sec : 0;
    const mod = opts.pauseModifier;
    this.pauseModifier =
      mod === "Shift" ||
      mod === "Control" ||
      mod === "Alt" ||
      mod === "Meta"
        ? mod
        : "None";
    const mult = Number(opts.wheelMultiplier);
    this.wheelMultiplier = Number.isFinite(mult)
      ? Math.min(2, Math.max(0.5, mult))
      : 1;
    this.scroll.configureSmooth({
      enabled: opts.smoothScrolling !== false,
      newMessages: opts.smoothScrollingNewMessages === true,
    });
    let cleared = false;
    if (Math.abs(this.pauseOnHoverSec) < 0.001 && this.pauseMouse) {
      this.clearHoverPause();
      cleared = true;
    }
    if (this.pauseModifier === "None" && this.pauseKey) {
      this.pauseKey = false;
      cleared = true;
    }
    if (cleared) {
      this.resumeFollowIfPinned();
    }
  }

  /** Keyboard / page scroll: animate when smooth scrolling enabled. */
  isSmoothScrolling(): boolean {
    return this.scroll.isSmoothEnabled();
  }

  isPaused(): boolean {
    return this.pauseMouse || this.pauseKey;
  }

  pauseModifierName(): PauseModifier {
    return this.pauseModifier;
  }

  private markPauseEnter(): void {
    if (!this.pauseFollowIntent && this.scroll.atBottom) {
      this.pauseFollowIntent = true;
    }
  }

  /** Hover over chat: timed or indefinite pause (stock pauseOnHoverDuration). */
  noteChatHover(): void {
    if (Math.abs(this.pauseOnHoverSec) < 0.001) {
      return;
    }
    if (this.pauseOnHoverSec < -0.5) {
      window.clearTimeout(this.hoverPauseTimer);
      this.hoverPauseTimer = 0;
      this.markPauseEnter();
      this.pauseMouse = true;
      return;
    }
    this.markPauseEnter();
    this.pauseMouse = true;
    window.clearTimeout(this.hoverPauseTimer);
    this.hoverPauseTimer = window.setTimeout(() => {
      this.hoverPauseTimer = 0;
      this.pauseMouse = false;
      this.resumeFollowIfPinned();
    }, Math.round(this.pauseOnHoverSec * 1000));
  }

  leaveChatHover(): void {
    this.clearHoverPause();
    this.resumeFollowIfPinned();
  }

  setKeyPause(active: boolean): void {
    if (this.pauseModifier === "None") {
      if (this.pauseKey) {
        this.pauseKey = false;
        this.resumeFollowIfPinned();
      }
      return;
    }
    const was = this.pauseKey;
    if (active) {
      this.markPauseEnter();
      this.pauseKey = true;
    } else {
      this.pauseKey = false;
      if (was) {
        this.resumeFollowIfPinned();
      }
    }
  }

  private clearHoverPause(): void {
    window.clearTimeout(this.hoverPauseTimer);
    this.hoverPauseTimer = 0;
    this.pauseMouse = false;
  }

  private resumeFollowIfPinned(): void {
    if (this.isPaused()) {
      return;
    }
    if (this.pauseFollowIntent) {
      this.pauseFollowIntent = false;
      this.scroll.goToBottom();
      this.afterScrollChange();
      return;
    }
    const snap = this.scroll.snapshot();
    if (snap.overflow && snap.desired >= snap.bottom - 1e-3) {
      this.scroll.goToBottom();
      this.afterScrollChange();
    }
  }

  /** Pixi chat colors from resolved theme preset. Atlas stays white; colors via style.fill / tint. */
  applyThemeFills(fills: ThemePixiFills): void {
    this.themeFills = { ...fills };
    if (!this.ready) {
      return;
    }
    for (const slot of this.slots) {
      slot.time.style.fill = this.themeFills.timestamp;
      slot.body.style.fill = this.themeFills.body;
      slot.nick.style.fill = 0xffffff;
      if (slot.useNickStyle) {
        slot.nick.tint = resolveNickColor({
          color: slot.nickColorRaw,
          userId: slot.nickUserId,
          colorize: this.colorizeNicknames,
          fallback: this.themeFills.nickFallback,
        });
      } else if (!slot.msgId) {
        slot.nick.tint = this.themeFills.nickFallback;
      }
      dirtyBitmapText(slot.time);
      dirtyBitmapText(slot.nick);
      dirtyBitmapText(slot.body);
    }
    this.layout();
  }

  configureChatFont(opts: {
    family: string;
    size: number;
    weight: number;
  }): void {
    const family = sanitizeFontFamily(opts.family);
    const size = clampChatFontSize(opts.size);
    const weight = clampChatFontWeight(opts.weight);
    const changed =
      family !== this.chatFontFamily ||
      size !== this.chatFontSize ||
      weight !== this.chatFontWeight;
    this.chatFontFamily = family;
    this.chatFontSize = size;
    this.chatFontWeight = weight;
    if (!changed && this.atlasDesignSize > 0) {
      return;
    }
    this.reinstallChatFont();
    this.refreshFontMetrics();
    if (!this.ready) {
      return;
    }
    this.applyFontStylesToSlots(true);
  }

  /** Масштаб шрифта, timestamps, emotes и hideModerated без destroy PIXI.Application. */
  applyDisplay(
    fontScale: number,
    showTimestamps: boolean,
    hideModerated = false,
    timestampFormat = "hh:mm",
    alternateMessages = false,
    separateMessages = false,
    collapseMessagesMinLines = 0,
    hideModerationActions = false,
    hideDeletionActions = false,
    deletedMessageLengthLimit = 50,
    fadeMessageHistory = true,
    hideTimestampsWhenLive = false,
    showReplyButton = false,
    linksDoubleClickOnly = false,
    emotes?: {
      scale?: number;
      images?: boolean;
      zeroWidth?: boolean;
      animate?: boolean;
      animateOnlyFocused?: boolean;
      removeSpaces?: boolean;
      emojiSet?: string;
    },
  ): void {
    const scale = Math.min(4, Math.max(0.5, fontScale));
    const prevAnimate = this.animateEmotes;
    const prevImages = this.enableEmoteImages;
    const prevEmojiSet = this.emojiSet;
    this.showTimestamps = showTimestamps;
    this.hideModerated = hideModerated;
    this.timestampFormat = timestampFormat === "Disable" ? "hh:mm" : timestampFormat;
    this.alternateMessages = alternateMessages;
    this.separateMessages = separateMessages;
    this.collapseMessagesMinLines = Math.max(
      0,
      Math.floor(Number(collapseMessagesMinLines) || 0),
    );
    this.hideModerationActions = hideModerationActions;
    this.hideDeletionActions = hideDeletionActions;
    this.deletedMessageLengthLimit = Math.max(
      0,
      Math.floor(Number(deletedMessageLengthLimit) || 0),
    );
    this.fadeMessageHistory = fadeMessageHistory;
    this.hideTimestampsWhenLive = hideTimestampsWhenLive;
    this.showReplyButton = showReplyButton;
    this.linksDoubleClickOnly = linksDoubleClickOnly;
    this.emoteScale = clampEmoteScale(emotes?.scale ?? this.emoteScale);
    this.enableEmoteImages = emotes?.images ?? this.enableEmoteImages;
    this.enableZeroWidthEmotes = emotes?.zeroWidth ?? this.enableZeroWidthEmotes;
    this.removeSpacesBetweenEmotes =
      emotes?.removeSpaces ?? this.removeSpacesBetweenEmotes;
    this.emojiSet = normalizeEmojiSet(emotes?.emojiSet ?? this.emojiSet);
    this.animateEmotes = emotes?.animate ?? this.animateEmotes;
    this.emoteTicker.configure({
      animate: this.animateEmotes,
      onlyFocused: emotes?.animateOnlyFocused ?? false,
    });
    this.fontScale = scale;
    const neededAtlas = atlasFontSize(this.chatFontSize);
    if (this.atlasDesignSize < neededAtlas || this.atlasDesignSize === 0) {
      this.reinstallChatFont();
    }
    this.refreshFontMetrics();
    this.badgeSize = Math.max(8, Math.round(BADGE_SIZE * scale));
    if (!this.ready) {
      return;
    }
    // Zoom changes fontSize without atlas rebuild; BitmapText skips GPU update
    // unless forced — nicks vanish and column gaps drift from stale glyphs.
    this.applyFontStylesToSlots(true);
    const emoteSize = this.emotePixelSize();
    for (const slot of this.slots) {
      if (slot.msgId && slot.timestampMs) {
        slot.time.text = formatTime(slot.timestampMs, this.timestampFormat);
      }
      for (const spr of slot.badges) {
        spr.y = (this.lineHeight - this.badgeSize) / 2;
        if (spr.visible && spr.texture !== Texture.EMPTY) {
          applySpriteTexture(spr, spr.texture, this.badgeSize);
        }
      }
      for (const spr of slot.emotes) {
        if (spr.visible && spr.texture !== Texture.EMPTY) {
          applySpriteTexture(spr, spr.texture, emoteSize);
        }
      }
    }
    if (
      prevAnimate !== this.animateEmotes ||
      prevImages !== this.enableEmoteImages ||
      prevEmojiSet !== this.emojiSet
    ) {
      if (!this.animateEmotes) {
        this.snapEmotesToFirstFrame();
      }
      this.reloadVisibleEmotes();
    }
    this.layout();
  }

  private refreshFontMetrics(): void {
    const effective = this.chatFontSize * this.fontScale;
    this.fontSize = effective;
    const metrics = measureFontMetrics(
      this.chatFontFamily,
      qtWeightToCss(this.chatFontWeight),
      effective,
    );
    this.charWidth = metrics.charWidth;
    this.lineHeight = metrics.lineHeight;
    const nickMetrics = measureFontMetrics(
      this.chatFontFamily,
      qtWeightToCss(this.nickBoldScale),
      effective,
    );
    this.nickCharWidth = nickMetrics.charWidth;
  }

  private applyFontStylesToSlots(forceDirty: boolean): void {
    for (const slot of this.slots) {
      slot.time.style.fontSize = this.fontSize;
      slot.nick.style.fontFamily = "ChatNickFont";
      slot.nick.style.fontSize = this.fontSize;
      slot.body.style.fontSize = this.fontSize;
      slot.body.style.lineHeight = this.lineHeight;
      for (const mt of slot.mentionTexts) {
        mt.style.fontSize = this.fontSize;
      }
      if (forceDirty) {
        dirtyBitmapText(slot.time);
        dirtyBitmapText(slot.nick);
        dirtyBitmapText(slot.body);
        for (const mt of slot.mentionTexts) {
          dirtyBitmapText(mt);
        }
      }
    }
  }

  private reinstallChatFont(): void {
    const atlasSize = atlasFontSize(this.chatFontSize);
    BitmapFont.uninstall("ChatFont");
    BitmapFont.install({
      name: "ChatFont",
      style: {
        fontFamily: this.chatFontFamily,
        fontSize: atlasSize,
        fontWeight: qtWeightToPixi(this.chatFontWeight),
        // White atlas so style.fill / nick tint work (Pixi tint-only when fill is white).
        fill: "#ffffff",
      },
      chars: [
        ["\u0020", "\u007e"],
        ["\u0400", "\u04FF"],
      ],
    });
    this.atlasDesignSize = atlasSize;
    this.reinstallNickFont();
  }

  private reinstallNickFont(): void {
    const atlasSize = atlasFontSize(this.chatFontSize);
    BitmapFont.uninstall("ChatNickFont");
    BitmapFont.install({
      name: "ChatNickFont",
      style: {
        fontFamily: this.chatFontFamily,
        fontSize: atlasSize,
        fontWeight: qtWeightToPixi(this.nickBoldScale),
        fill: "#ffffff",
      },
      chars: [
        ["\u0020", "\u007e"],
        ["\u0400", "\u04FF"],
      ],
    });
    this.nickAtlasDesignSize = atlasSize;
  }

  scrollSnapshot(): ScrollSnapshot {
    return this.scroll.snapshot();
  }

  goToBottom(): void {
    this.pauseFollowIntent = false;
    this.scroll.goToBottom();
    this.afterScrollChange();
  }

  setDesired(rows: number, animated = false): void {
    this.pauseFollowIntent = false;
    this.scroll.setDesired(rows, animated);
    this.afterScrollChange();
  }

  /** Прыжок к сообщению в кольце; подсветка hit. false если id нет в пуле. */
  scrollToMsgId(id: string): boolean {
    if (!id || !this.ready) {
      return false;
    }
    const start = (this.head - this.occupied + MESSAGE_POOL_SIZE) % MESSAGE_POOL_SIZE;
    let target: Slot | undefined;
    let prevSlot: Slot | undefined;
    for (let i = 0; i < this.occupied; i += 1) {
      const slot = this.slots[(start + i) % MESSAGE_POOL_SIZE];
      if (this.findHitId && slot.msgId === this.findHitId) {
        prevSlot = slot;
      }
      if (slot.msgId === id) {
        target = slot;
      }
    }
    if (!target) {
      return false;
    }
    // Go to message даже если hideModerated скрыл слот в ленте
    this.findHitId = id;
    this.scroll.setDesired(target.startRow, false);
    this.afterScrollChange();
    if (prevSlot && prevSlot !== target) {
      this.paintHighlight(prevSlot);
    }
    this.paintHighlight(target);
    return true;
  }

  clearFindHit(): void {
    if (!this.findHitId) {
      return;
    }
    const prev = this.findHitId;
    this.findHitId = "";
    const start = (this.head - this.occupied + MESSAGE_POOL_SIZE) % MESSAGE_POOL_SIZE;
    for (let i = 0; i < this.occupied; i += 1) {
      const slot = this.slots[(start + i) % MESSAGE_POOL_SIZE];
      if (slot.msgId === prev) {
        this.paintHighlight(slot);
        break;
      }
    }
  }

  handleWheel(ev: WheelEvent): void {
    ev.preventDefault();
    // Zoom gesture: ignore ctrl+wheel unless Control is the pause modifier (then scroll stays usable).
    if (ev.ctrlKey && this.pauseModifier !== "Control") {
      return;
    }
    const rows =
      wheelDeltaRows(ev.deltaY, ev.deltaMode, this.lineHeight, this.scroll.viewRows) *
      this.wheelMultiplier;
    this.scroll.wheel(rows, true);
    if (!this.isPaused()) {
      this.pauseFollowIntent = false;
    }
    this.afterScrollChange();
  }

  async init(): Promise<void> {
    if (this.ready) {
      return;
    }
    this.reinstallChatFont();
    this.refreshFontMetrics();
    const stage = this.app.stage;
    stage.eventMode = "static";
    for (let i = 0; i < MESSAGE_POOL_SIZE; i += 1) {
      const root = new Container();
      root.visible = false;
      root.eventMode = "static";
      root.hitArea = new Rectangle(0, 0, 1, this.lineHeight);
      const hl = new Graphics();
      hl.eventMode = "none";
      const mentions = new Graphics();
      mentions.eventMode = "none";
      const disabledGfx = new Graphics();
      disabledGfx.eventMode = "none";
      const time = new BitmapText({
        text: "",
        style: {
          fontFamily: "ChatFont",
          fontSize: this.fontSize,
          fill: this.themeFills.timestamp,
        },
      });
      const nick = new BitmapText({
        text: "",
        style: {
          fontFamily: "ChatNickFont",
          fontSize: this.fontSize,
          fill: 0xffffff,
        },
      });
      const body = new BitmapText({
        text: "",
        style: {
          fontFamily: "ChatFont",
          fontSize: this.fontSize,
          fill: this.themeFills.body,
          lineHeight: this.lineHeight,
        },
      });
      const emotes: Sprite[] = [];
      for (let e = 0; e < EMOTE_SLOTS_PER_ROW; e += 1) {
        const spr = new Sprite(Texture.EMPTY);
        spr.visible = false;
        spr.eventMode = "none";
        spr.y = 1;
        emotes.push(spr);
      }
      const mentionTexts: BitmapText[] = [];
      for (let m = 0; m < MENTION_SLOTS_PER_ROW; m += 1) {
        const mt = new BitmapText({
          text: "",
          style: {
            fontFamily: "ChatFont",
            fontSize: this.fontSize,
            fill: 0xffffff,
          },
        });
        mt.visible = false;
        mt.eventMode = "none";
        mentionTexts.push(mt);
      }
      const badges: Sprite[] = [];
      for (let b = 0; b < BADGE_SLOTS_PER_ROW; b += 1) {
        const spr = new Sprite(Texture.EMPTY);
        spr.visible = false;
        spr.eventMode = "none";
        spr.y = (this.lineHeight - this.badgeSize) / 2;
        badges.push(spr);
      }
      // disabled overlay last — поверх текста/эмодзи как MessageLayout fillRect
      root.addChild(
        hl,
        mentions,
        time,
        nick,
        body,
        ...mentionTexts,
        ...badges,
        ...emotes,
        disabledGfx,
      );
      const slot: Slot = {
        root,
        highlight: hl,
        mentions,
        disabledGfx,
        time,
        nick,
        body,
        mentionTexts,
        emotes,
        emoteKeys: [],
        badges,
        badgeKeys: [],
        badgesRaw: [],
        msgId: "",
        login: "",
        bodyRaw: "",
        nickRaw: "",
        copyText: "",
        replyToId: "",
        timestampMs: 0,
        spansRaw: [],
        linkSpans: [],
        mentionSpans: [],
        wrapLines: [{ start: 0, end: 0 }],
        lineCount: 1,
        startRow: 0,
        highlightColor: "",
        disabled: false,
        fromHistory: false,
        collapsible: false,
        expanded: false,
        collapsed: false,
        system: false,
        nickUserId: "",
        nickColorRaw: "",
        nickLogin: "",
        nickDisplay: "",
        useNickStyle: false,
        replyToLogin: "",
        isAction: false,
        leadLen: 0,
      };
      root.on("pointertap", (ev: FederatedPointerEvent) => {
        this.onSlotTap(slot, ev);
      });
      root.on("rightclick", (ev: FederatedPointerEvent) => {
        this.onSlotContext(slot, ev);
      });
      root.on("pointermove", (ev: FederatedPointerEvent) => {
        this.onSlotMove(slot, ev);
      });
      stage.addChild(root);
      this.slots.push(slot);
    }
    this.ready = true;
    this.app.renderer.on("resize", () => this.layout());
  }

  reset(): void {
    this.liveMsgIds.clear();
    this.channelLive = false;
    this.resetSlots();
    this.layout();
  }

  setChannelLive(live: boolean): void {
    if (this.channelLive === live) {
      return;
    }
    this.channelLive = live;
    if (!this.ready) {
      return;
    }
    this.layout();
  }

  private timestampsVisible(): boolean {
    return (
      this.showTimestamps && !(this.hideTimestampsWhenLive && this.channelLive)
    );
  }

  destroy(): void {
    this.emoteTicker.destroy();
    this.clearSlots();
  }

  applySnapshot(events: ChatEvent[]): void {
    const follow = this.scroll.atBottom;
    const anchor = this.scroll.captureAnchor(this.laidSlots());
    this.clearSlots();
    const start = Math.max(0, events.length - MESSAGE_POOL_SIZE);
    this.loadingSnapshot = true;
    try {
      for (const event of events.slice(start)) {
        this.pushOne(event);
      }
    } finally {
      this.loadingSnapshot = false;
    }
    this.layout(follow ? undefined : anchor);
  }

  pushMany(events: ChatEvent[]): void {
    const anchor = this.scroll.captureAnchor(this.laidSlots());
    for (const event of events) {
      this.pushOne(event);
    }
    this.layout(anchor);
  }

  private clearSlots(): void {
    this.occupied = 0;
    this.head = 0;
    this.lastReadMsgId = "";
    for (const slot of this.slots) {
      this.clearSlot(slot);
    }
    this.bumpHighlightMarks();
  }

  private resetSlots(): void {
    this.clearSlots();
    this.scroll.reset();
  }

  private pushOne(event: ChatEvent): void {
    if (event.kind === "clearmsg") {
      const target = this.findSlotByMsgId(event.targetId);
      if (!target) {
        return;
      }
      this.disableById(event.targetId);
      if (this.hideDeletionActions || this.hideModerationActions) {
        this.layout();
        return;
      }
      const login = target.nickLogin || target.login || "unknown";
      const notice: ChatEvent = {
        kind: "notice",
        id: `${event.id}:del`,
        timestampMs: event.timestampMs,
        text: deletionNoticeText(
          login,
          target.copyText,
          this.deletedMessageLengthLimit,
        ),
      };
      const slot = this.slots[this.head];
      this.write(slot, notice);
      this.head = (this.head + 1) % MESSAGE_POOL_SIZE;
      if (this.occupied < MESSAGE_POOL_SIZE) {
        this.occupied += 1;
      }
      this.bumpHighlightMarks();
      this.layout();
      return;
    }
    if (event.kind === "clearchat") {
      if (event.targetLogin) {
        this.disableByLogin(event.targetLogin);
      } else {
        this.disableAllUserMessages();
      }
      if (this.hideModerationActions) {
        this.layout();
        return;
      }
    }
    if (event.kind === "roomstate" || event.kind === "userstate") {
      // Legacy raw roomstate / userstate in old snapshots — skip; live path side-effects only.
      return;
    }
    const slot = this.slots[this.head];
    this.write(slot, event);
    this.head = (this.head + 1) % MESSAGE_POOL_SIZE;
    if (this.occupied < MESSAGE_POOL_SIZE) {
      this.occupied += 1;
    }
    this.bumpHighlightMarks();
  }

  /** Soft-delete: MessageFlag::Disabled, слот остаётся (Chatterino Channel). */
  private findSlotByMsgId(id: string): Slot | undefined {
    if (!id) {
      return undefined;
    }
    for (const slot of this.slots) {
      if (slot.msgId === id) {
        return slot;
      }
    }
    return undefined;
  }

  private disableById(id: string): void {
    for (const slot of this.slots) {
      if (slot.msgId === id) {
        slot.disabled = true;
      }
    }
  }

  private disableByLogin(login: string): void {
    const needle = login.toLowerCase();
    for (const slot of this.slots) {
      if (slot.msgId && slot.login === needle) {
        slot.disabled = true;
      }
    }
  }

  private disableAllUserMessages(): void {
    for (const slot of this.slots) {
      if (slot.msgId && slot.login && !slot.system) {
        slot.disabled = true;
      }
    }
  }

  private clearSlot(slot: Slot): void {
    for (const key of slot.emoteKeys) {
      if (key) {
        this.textures.release(key);
      }
    }
    for (const key of slot.badgeKeys) {
      if (key) {
        this.textures.release(key);
      }
    }
    slot.emoteKeys = [];
    slot.badgeKeys = [];
    slot.badgesRaw = [];
    slot.root.visible = false;
    slot.root.cursor = "default";
    slot.time.text = "";
    slot.nick.text = "";
    slot.body.text = "";
    slot.msgId = "";
    slot.login = "";
    slot.bodyRaw = "";
    slot.nickRaw = "";
    slot.copyText = "";
    slot.replyToId = "";
    slot.timestampMs = 0;
    slot.spansRaw = [];
    slot.linkSpans = [];
    slot.mentionSpans = [];
    slot.wrapLines = [{ start: 0, end: 0 }];
    slot.lineCount = 1;
    slot.startRow = 0;
    slot.highlightColor = "";
    slot.disabled = false;
    slot.fromHistory = false;
    slot.collapsible = false;
    slot.expanded = false;
    slot.collapsed = false;
    slot.system = false;
    slot.nickUserId = "";
    slot.nickColorRaw = "";
    slot.nickLogin = "";
    slot.nickDisplay = "";
    slot.useNickStyle = false;
    slot.replyToLogin = "";
    slot.isAction = false;
    slot.leadLen = 0;
    slot.highlight.clear();
    slot.mentions.clear();
    slot.disabledGfx.clear();
    for (const spr of slot.emotes) {
      spr.visible = false;
      spr.texture = Texture.EMPTY;
    }
    for (const spr of slot.badges) {
      spr.visible = false;
      spr.texture = Texture.EMPTY;
    }
    for (const mt of slot.mentionTexts) {
      mt.visible = false;
      mt.text = "";
    }
  }

  private write(slot: Slot, event: ChatEvent): void {
    slot.root.visible = true;
    slot.disabled =
      (event.kind === "privmsg" && !!event.disabled) ||
      (event.kind === "usernotice" &&
        event.privmsg?.kind === "privmsg" &&
        !!event.privmsg.disabled);
    slot.disabledGfx.clear();
    slot.expanded = false;
    slot.collapsed = false;
    // PRIVMSG only — USERNOTICE/NOTICE/CLEARCHAT = System в эталоне
    slot.system = event.kind !== "privmsg";
    slot.collapsible = event.kind === "privmsg";
    if (event.kind === "usernotice" && event.privmsg && event.privmsg.kind === "privmsg") {
      slot.msgId = event.privmsg.id;
      slot.login = event.privmsg.login.toLowerCase();
    } else {
      slot.msgId = event.id;
      slot.login = eventLogin(event);
    }
    if (this.loadingSnapshot) {
      slot.fromHistory = !slot.msgId || !this.liveMsgIds.has(slot.msgId);
    } else {
      slot.fromHistory = false;
      if (slot.msgId) {
        this.liveMsgIds.add(slot.msgId);
      }
    }
    const drawn = this.line(event);
    slot.time.text = drawn.time;
    slot.nickRaw = drawn.nick;
    slot.nick.text = drawn.nick;
    slot.nick.tint = drawn.nickColor;
    if (event.kind === "privmsg") {
      slot.useNickStyle = true;
      slot.nickUserId = event.userId;
      slot.nickColorRaw = event.color;
      slot.nickLogin = event.login;
      slot.nickDisplay = event.displayName || event.login;
      this.nickColorCache.set(event.login, drawn.nickColor);
    } else {
      slot.useNickStyle = false;
      slot.nickUserId = "";
      slot.nickColorRaw = "";
      slot.nickLogin = "";
      slot.nickDisplay = "";
    }
    slot.bodyRaw = drawn.body;
    slot.copyText = drawn.copyText;
    slot.leadLen = drawn.leadLen;
    if (event.kind === "privmsg") {
      slot.replyToId = event.replyToId ?? "";
      slot.replyToLogin = event.replyToLogin ?? "";
      slot.isAction = event.action === true;
    } else if (
      event.kind === "usernotice" &&
      event.privmsg &&
      event.privmsg.kind === "privmsg"
    ) {
      slot.replyToId = event.privmsg.replyToId ?? "";
      slot.replyToLogin = event.privmsg.replyToLogin ?? "";
      slot.isAction = event.privmsg.action === true;
    } else {
      slot.replyToId = "";
      slot.replyToLogin = "";
      slot.isAction = false;
    }
    slot.timestampMs = event.timestampMs;
    slot.spansRaw = drawn.spans;
    slot.linkSpans = drawn.links;
    slot.mentionSpans = drawn.mentions;
    slot.badgesRaw = drawn.badges;
    slot.highlightColor = drawn.highlightColor;
    const msgId = slot.msgId;
    for (const spr of slot.emotes) {
      spr.visible = false;
      spr.texture = Texture.EMPTY;
    }
    for (const spr of slot.badges) {
      spr.visible = false;
      spr.texture = Texture.EMPTY;
    }
    for (const key of slot.emoteKeys) {
      if (key) {
        this.textures.release(key);
      }
    }
    for (const key of slot.badgeKeys) {
      if (key) {
        this.textures.release(key);
      }
    }
    slot.emoteKeys = new Array(slot.emotes.length).fill("");
    slot.badgeKeys = [];
    if (this.enableEmoteImages) {
      for (let i = 0; i < slot.emotes.length; i += 1) {
        const spr = slot.emotes[i];
        const span = drawn.spans[i];
        if (!span) {
          continue;
        }
        const key =
          span.provider === "cheer"
            ? `cheer:${span.url}`
            : `${span.provider}:${span.emoteId}`;
        slot.emoteKeys[i] = key;
        this.textures.acquire(key);
        const wantAnimate = this.animateEmotes;
        const url = this.emoteLoadUrl(span);
        void this.textures.load(key, url, wantAnimate).then((tex) => {
          if (
            tex &&
            slot.msgId === msgId &&
            this.enableEmoteImages &&
            slot.emoteKeys[i] === key &&
            this.animateEmotes === wantAnimate
          ) {
            applySpriteTexture(spr, tex, this.emotePixelSize());
          }
        });
      }
    }
    for (let i = 0; i < slot.badges.length; i += 1) {
      const spr = slot.badges[i];
      const badge = drawn.badges[i];
      if (!badge || !badge.url) {
        continue;
      }
      const key = `badge:${badge.url}`;
      slot.badgeKeys.push(key);
      this.textures.acquire(key);
      void this.textures.load(key, badge.url, false).then((tex) => {
        if (tex && slot.msgId === msgId) {
          applySpriteTexture(spr, tex, this.badgeSize);
        }
      });
    }
  }

  /** Пересобрать @reply / * prefix при смене hideReplyContext без полного rewrite события. */
  private reapplyReplyPrefix(slot: Slot): void {
    const core = slot.copyText;
    const lead = slot.bodyRaw.slice(0, Math.max(0, slot.leadLen));
    const newReply =
      !this.hideReplyContext && slot.replyToLogin
        ? `@${slot.replyToLogin} `
        : "";
    const newAction = slot.isAction ? "* " : "";
    const newBefore = `${lead}${newReply}${newAction}`;
    const oldBeforeLen = Math.max(0, slot.bodyRaw.length - core.length);
    const delta = newBefore.length - oldBeforeLen;
    if (delta === 0 && slot.bodyRaw === `${newBefore}${core}`) {
      return;
    }
    slot.bodyRaw = `${newBefore}${core}`;
    if (delta !== 0) {
      slot.spansRaw = shiftSpans(slot.spansRaw, delta);
      slot.linkSpans = shiftSpans(slot.linkSpans, delta);
      slot.mentionSpans = shiftSpans(slot.mentionSpans, delta);
    }
  }

  private line(event: ChatEvent): Drawn {
    const time = formatTime(event.timestampMs, this.timestampFormat);
    switch (event.kind) {
      case "privmsg": {
        let prefix = "";
        if (event.whisper) {
          prefix += "Whisper: ";
        }
        if (!this.hideReplyContext && event.replyToLogin) {
          prefix += `@${event.replyToLogin} `;
        }
        if (event.action) {
          prefix += "* ";
        }
        const shift = prefix.length;
        return {
          time,
          nick: formatUsername({
            login: event.login,
            displayName: event.displayName || event.login,
            mode: this.usernameDisplayMode,
          }),
          nickColor: resolveNickColor({
            color: event.color,
            userId: event.userId,
            colorize: this.colorizeNicknames,
            fallback: this.themeFills.nickFallback,
          }),
          body: `${prefix}${event.text}`,
          copyText: event.text,
          leadLen: 0,
          spans: shiftSpans(event.emoteSpans ?? [], shift),
          links: shiftSpans(event.linkSpans ?? [], shift),
          mentions: shiftSpans(event.mentionSpans ?? [], shift),
          badges: badgesWithUrl(event.badges ?? []),
          highlightColor: event.highlightColor ?? "",
        };
      }
      case "usernotice": {
        let body = event.systemText;
        let spans: EmoteSpan[] = [];
        let links: LinkSpan[] = [];
        let mentions: MentionSpan[] = [];
        let badges: Badge[] = [];
        let highlightColor = "";
        let copyText = event.systemText;
        let leadLen = 0;
        if (event.privmsg && event.privmsg.kind === "privmsg") {
          const inner = event.privmsg;
          let innerPrefix = "";
          if (!this.hideReplyContext && inner.replyToLogin) {
            innerPrefix += `@${inner.replyToLogin} `;
          }
          if (inner.action) {
            innerPrefix += "* ";
          }
          const sep = body.length > 0 ? " " : "";
          leadLen = body.length + sep.length;
          const shift = leadLen + innerPrefix.length;
          body += `${sep}${innerPrefix}${inner.text}`;
          copyText = inner.text;
          spans = shiftSpans(inner.emoteSpans ?? [], shift);
          links = shiftSpans(inner.linkSpans ?? [], shift);
          mentions = shiftSpans(inner.mentionSpans ?? [], shift);
          badges = badgesWithUrl(inner.badges ?? []);
          highlightColor = inner.highlightColor ?? event.highlightColor ?? "";
        } else {
          highlightColor = event.highlightColor ?? "";
        }
        return {
          time,
          nick: "*",
          nickColor: this.themeFills.nickFallback,
          body,
          copyText,
          leadLen,
          spans,
          links,
          mentions,
          badges,
          highlightColor,
        };
      }
      case "clearchat":
        return {
          time,
          nick: "*",
          nickColor: this.themeFills.nickFallback,
          body: clearchatText(event.targetLogin, event.durationSec),
          copyText: clearchatText(event.targetLogin, event.durationSec),
          leadLen: 0,
          spans: [],
          links: [],
          mentions: [],
          badges: [],
          highlightColor: "",
        };
      case "roomstate":
      case "userstate":
        return {
          time,
          nick: "*",
          nickColor: this.themeFills.nickFallback,
          body: "",
          copyText: "",
          leadLen: 0,
          spans: [],
          links: [],
          mentions: [],
          badges: [],
          highlightColor: "",
        };
      case "notice":
        return {
          time,
          nick: "*",
          nickColor: this.themeFills.nickFallback,
          body: event.text,
          copyText: event.text,
          leadLen: 0,
          spans: [],
          links: [],
          mentions: [],
          badges: [],
          highlightColor: "",
        };
      default:
        return {
          time,
          nick: "*",
          nickColor: this.themeFills.nickFallback,
          body: event.kind,
          copyText: "",
          leadLen: 0,
          spans: [],
          links: [],
          mentions: [],
          badges: [],
          highlightColor: "",
        };
    }
  }

  private paintClip(slot: Slot): void {
    const gap = Math.max(4, Math.round(TIME_GAP * this.fontScale));
    const timeSample = this.timestampsVisible()
      ? formatTime(Date.UTC(2000, 0, 1, 23, 59, 59, 999), this.timestampFormat)
      : "";
    const timeW = this.timestampsVisible()
      ? measureTextWidth(
          this.chatFontFamily,
          qtWeightToCss(this.chatFontWeight),
          this.fontSize,
          timeSample,
        ) + gap
      : 0;
    slot.time.x = 0;
    slot.time.visible = this.timestampsVisible();
    const badgeN = slot.badgesRaw.length;
    const badgeBand =
      badgeN === 0 ? 0 : badgeN * this.badgeSize + (badgeN - 1) * BADGE_GAP;
    for (let i = 0; i < slot.badges.length; i += 1) {
      const spr = slot.badges[i];
      const badge = slot.badgesRaw[i];
      if (!badge) {
        spr.visible = false;
        continue;
      }
      spr.visible = true;
      spr.x = timeW + i * (this.badgeSize + BADGE_GAP);
    }
    slot.nick.x = timeW + badgeBand;
    const paneW = this.app.screen.width;
    const nickMaxPx = Math.max(
      8,
      paneW - timeW - badgeBand - gap - 8 - MIN_BODY_CHARS * this.charWidth,
    );
    const nickMaxChars = Math.max(2, Math.floor(nickMaxPx / this.nickCharWidth));
    slot.nick.text = clipNick(slot.nickRaw, nickMaxChars);
    const nickW = Math.max(
      measureTextWidth(
        this.chatFontFamily,
        qtWeightToCss(this.nickBoldScale),
        this.fontSize,
        slot.nick.text,
      ),
      8,
    );
    const bodyX = timeW + badgeBand + nickW + gap;
    slot.body.x = bodyX;
    if (slot.root.hitArea instanceof Rectangle) {
      slot.root.hitArea.width = this.app.screen.width;
    }
    const layoutOpts = this.wrapOpts(slot);
    const bodyCols = maxBodyChars(this.app.screen.width, bodyX, this.charWidth);
    const wrapped = wrapBody(
      slot.bodyRaw,
      bodyCols,
      slot.spansRaw,
      layoutOpts,
    );
    const maxLines =
      slot.collapsible && !slot.expanded ? this.collapseMessagesMinLines : 0;
    const { lines, collapsed } = collapseWrapLines(
      wrapped,
      maxLines,
      slot.bodyRaw,
      bodyCols,
      slot.spansRaw,
      layoutOpts,
    );
    slot.collapsed = collapsed;
    slot.root.cursor = collapsed ? "pointer" : "default";
    slot.wrapLines = lines;
    slot.lineCount = lines.length;
    const overlayMentions =
      this.boldUsernames || this.colorUsernames
        ? this.mentionSpansForOverlay(slot.mentionSpans, lines)
        : [];
    const renderOpts = this.wrapOpts(slot, overlayMentions);
    slot.body.text = withCollapsedEllipsis(
      renderWrapped(slot.bodyRaw, lines, slot.spansRaw, renderOpts),
      collapsed,
    );
    if (slot.root.hitArea instanceof Rectangle) {
      slot.root.hitArea.height = slot.lineCount * this.lineHeight;
    }
    this.paintHighlight(slot);
    this.paintMentions(slot, bodyX, layoutOpts);
    this.paintMentionTexts(slot, bodyX, lines, renderOpts, overlayMentions);
    this.paintDisabled(slot);
    let prevX = 0;
    let prevY = 0;
    let hasPrev = false;
    const emoteSize = this.emotePixelSize();
    for (let i = 0; i < slot.emotes.length; i += 1) {
      const spr = slot.emotes[i];
      const span = slot.spansRaw[i];
      if (!span || !this.enableEmoteImages) {
        spr.visible = false;
        continue;
      }
      const zw = this.enableZeroWidthEmotes && span.zeroWidth === true;
      if (zw && hasPrev) {
        spr.visible = true;
        spr.x = prevX;
        spr.y = prevY;
        if (spr.texture !== Texture.EMPTY) {
          applySpriteTexture(spr, spr.texture, emoteSize);
        }
        continue;
      }
      const pos = indexToLineCol(
        slot.bodyRaw,
        lines,
        span.start,
        slot.spansRaw,
        layoutOpts,
      );
      if (!pos) {
        spr.visible = false;
        continue;
      }
      spr.visible = true;
      spr.x = bodyX + pos.col * this.charWidth;
      spr.y = 1 + pos.line * this.lineHeight;
      if (spr.texture !== Texture.EMPTY) {
        applySpriteTexture(spr, spr.texture, emoteSize);
      }
      prevX = spr.x;
      prevY = spr.y;
      hasPrev = true;
    }
  }

  private paintHighlight(slot: Slot): void {
    slot.highlight.clear();
    const h = slot.lineCount * this.lineHeight;
    const w = this.app.screen.width;
    if (this.findHitId && slot.msgId === this.findHitId) {
      slot.highlight.rect(0, 0, w, h).fill({ color: 0xf0ad4e, alpha: 0.28 });
    } else {
      const parsed = parseHighlight(slot.highlightColor);
      if (parsed) {
        slot.highlight
          .rect(0, 0, w, h)
          .fill({ color: parsed.color, alpha: parsed.alpha });
      } else if (this.alternateMessages && slot.startRow % 2 === 1) {
        slot.highlight
          .rect(0, 0, w, h)
          .fill({
            color: this.themeFills.alternate,
            alpha: this.themeFills.alternateAlpha,
          });
      }
    }
    if (this.separateMessages) {
      slot.highlight
        .moveTo(0, h - 0.5)
        .lineTo(w, h - 0.5)
        .stroke({ width: 1, color: this.themeFills.separator, alpha: 0.9 });
    }
    if (
      this.showLastRead &&
      this.lastReadMsgId &&
      slot.msgId === this.lastReadMsgId
    ) {
      this.paintLastReadLine(slot.highlight, w, h);
    }
  }

  private paintLastReadLine(gfx: Graphics, w: number, h: number): void {
    const y = h - 0.5;
    const color = this.lastReadColor;
    if (this.lastReadPattern === "Solid") {
      gfx.moveTo(0, y).lineTo(w, y).stroke({ width: 1, color, alpha: 1 });
      return;
    }
    const dash = 4;
    const gap = 3;
    let x = 0;
    while (x < w) {
      const x2 = Math.min(w, x + dash);
      gfx.moveTo(x, y).lineTo(x2, y);
      x += dash + gap;
    }
    gfx.stroke({ width: 1, color, alpha: 1 });
  }

  private paintDisabled(slot: Slot): void {
    slot.disabledGfx.clear();
    const dim =
      slot.disabled || (this.fadeMessageHistory && slot.fromHistory);
    if (!dim) {
      return;
    }
    slot.disabledGfx
      .rect(0, 0, this.app.screen.width, slot.lineCount * this.lineHeight)
      .fill({
        color: this.themeFills.disabled,
        alpha: this.themeFills.disabledAlpha,
      });
  }

  private paintMentions(
    slot: Slot,
    bodyX: number,
    wrapOpts: WrapOptions,
  ): void {
    slot.mentions.clear();
    for (const span of slot.mentionSpans) {
      // Purple highlight only for @mentions; bare findAllUsernames = text chrome only.
      if (slot.bodyRaw.charAt(span.start) !== "@") {
        continue;
      }
      for (const line of slot.wrapLines) {
        const a = Math.max(span.start, line.start);
        const b = Math.min(span.end, line.end);
        if (a >= b) {
          continue;
        }
        const start = indexToLineCol(
          slot.bodyRaw,
          slot.wrapLines,
          a,
          slot.spansRaw,
          wrapOpts,
        );
        const end = indexToLineCol(
          slot.bodyRaw,
          slot.wrapLines,
          Math.max(a, b - 1),
          slot.spansRaw,
          wrapOpts,
        );
        if (!start || !end || start.line !== end.line) {
          continue;
        }
        const cols = Math.max(1, end.col - start.col + 1);
        slot.mentions
          .rect(
            bodyX + start.col * this.charWidth,
            start.line * this.lineHeight,
            cols * this.charWidth,
            this.lineHeight,
          )
          .fill({ color: 0x5c65f9, alpha: 0.35 });
      }
    }
  }

  private paintMentionTexts(
    slot: Slot,
    bodyX: number,
    lines: readonly WrapLine[],
    wrapOpts: WrapOptions,
    overlayMentions: readonly MentionSpan[],
  ): void {
    for (const mt of slot.mentionTexts) {
      mt.visible = false;
    }
    if (!this.boldUsernames && !this.colorUsernames) {
      return;
    }
    const fontFamily = this.boldUsernames ? "ChatNickFont" : "ChatFont";
    let used = 0;
    for (const span of overlayMentions) {
      for (const line of lines) {
        if (used >= slot.mentionTexts.length) {
          return;
        }
        const a = Math.max(span.start, line.start);
        const b = Math.min(span.end, line.end);
        if (a >= b) {
          continue;
        }
        const pos = indexToLineCol(
          slot.bodyRaw,
          lines,
          a,
          slot.spansRaw,
          wrapOpts,
        );
        if (!pos) {
          continue;
        }
        const mt = slot.mentionTexts[used];
        used += 1;
        mt.text = slot.bodyRaw.slice(a, b);
        mt.style.fontFamily = fontFamily;
        mt.style.fontSize = this.fontSize;
        mt.style.fill = 0xffffff;
        const cached = this.nickColorCache.get(span.login);
        mt.tint =
          this.colorUsernames && cached !== undefined
            ? cached
            : this.themeFills.body;
        mt.x = bodyX + pos.col * this.charWidth;
        mt.y = pos.line * this.lineHeight;
        mt.visible = true;
        dirtyBitmapText(mt);
      }
    }
  }

  /** Mentions, для которых хватает overlay-слотов (по числу line∩span). */
  private mentionSpansForOverlay(
    spans: readonly MentionSpan[],
    lines: readonly WrapLine[],
  ): MentionSpan[] {
    let used = 0;
    const out: MentionSpan[] = [];
    for (const span of spans) {
      let frags = 0;
      for (const line of lines) {
        if (Math.max(span.start, line.start) < Math.min(span.end, line.end)) {
          frags += 1;
        }
      }
      if (frags === 0) {
        continue;
      }
      if (used + frags > MENTION_SLOTS_PER_ROW) {
        break;
      }
      used += frags;
      out.push(span);
    }
    return out;
  }

  private layout(anchor?: ScrollAnchor): void {
    const resolved = anchor ?? this.scroll.captureAnchor(this.laidSlots());
    const start = (this.head - this.occupied + MESSAGE_POOL_SIZE) % MESSAGE_POOL_SIZE;
    let row = 0;
    for (let i = 0; i < this.occupied; i += 1) {
      const slot = this.slots[(start + i) % MESSAGE_POOL_SIZE];
      const live = slot.msgId.length > 0;
      const show = live && !(this.hideModerated && slot.disabled);
      slot.root.visible = show;
      if (!show) {
        continue;
      }
      slot.root.y = row * this.lineHeight;
      this.paintClip(slot);
      slot.startRow = row;
      row += slot.lineCount;
    }
    const viewRows = this.app.screen.height / this.lineHeight;
    this.scroll.applyLayout(
      row,
      viewRows,
      this.laidSlots(),
      resolved,
      this.isPaused(),
    );
    this.afterScrollChange();
  }

  private afterScrollChange(): void {
    this.applyStageY();
    this.notifyScroll();
    this.ensureScrollTick();
  }

  private ensureScrollTick(): void {
    if (!this.scroll.isAnimating()) {
      if (this.scrollRaf !== 0) {
        cancelAnimationFrame(this.scrollRaf);
        this.scrollRaf = 0;
      }
      return;
    }
    if (this.scrollRaf !== 0) {
      return;
    }
    const step = (now: number): void => {
      const cont = this.scroll.tick(now);
      this.applyStageY();
      this.notifyScroll();
      if (cont) {
        this.scrollRaf = requestAnimationFrame(step);
      } else {
        this.scrollRaf = 0;
      }
    };
    this.scrollRaf = requestAnimationFrame(step);
  }

  private laidSlots(): LaidSlot[] {
    const start = (this.head - this.occupied + MESSAGE_POOL_SIZE) % MESSAGE_POOL_SIZE;
    this.laidBuf.length = 0;
    for (let i = 0; i < this.occupied; i += 1) {
      const slot = this.slots[(start + i) % MESSAGE_POOL_SIZE];
      if (slot.msgId.length === 0) {
        continue;
      }
      if (this.hideModerated && slot.disabled) {
        continue;
      }
      this.laidBuf.push({
        msgId: slot.msgId,
        startRow: slot.startRow,
        lineCount: slot.lineCount,
      });
    }
    return this.laidBuf;
  }

  private applyStageY(): void {
    this.app.stage.y = this.scroll.stageY(this.lineHeight);
  }

  private notifyScroll(): void {
    this.onScroll?.(this.scroll.snapshot());
  }

  private onSlotTap(slot: Slot, ev: FederatedPointerEvent): void {
    // Pixi fires pointertap after rightclick; only LMB opens UserCard / links.
    if (ev.button !== 0) {
      return;
    }
    if (slot.collapsed && !slot.expanded) {
      slot.expanded = true;
      this.paintClip(slot);
      this.layout();
      return;
    }
    // Pixi has no dblclick; DOM double-click sets detail >= 2 on the second tap.
    const needDbl = this.linksDoubleClickOnly;
    const isDbl = (ev.detail ?? 1) >= 2;
    if (needDbl && !isDbl) {
      return;
    }
    if (this.nickAt(slot, ev) && slot.login && this.onNickClick) {
      this.onNickClick({
        msgId: slot.msgId,
        login: slot.login,
        authorLogin: slot.login,
        nick: slot.nickRaw,
        text: slot.copyText || slot.bodyRaw,
        clientX: ev.clientX,
        clientY: ev.clientY,
        disabled: slot.disabled,
        replyToId: slot.replyToId,
        linkUrl: "",
      });
      return;
    }
    const mentionLogin = this.mentionLoginAt(slot, ev);
    if (mentionLogin && this.onNickClick) {
      this.onNickClick({
        msgId: slot.msgId,
        login: mentionLogin,
        authorLogin: slot.login,
        nick: mentionLogin,
        text: slot.copyText || slot.bodyRaw,
        clientX: ev.clientX,
        clientY: ev.clientY,
        disabled: slot.disabled,
        replyToId: slot.replyToId,
        linkUrl: "",
      });
      return;
    }
    const url = this.linkAt(slot, ev);
    if (!url) {
      return;
    }
    void invoke("open_chat_link", { url }).catch(() => undefined);
  }

  private onSlotContext(slot: Slot, ev: FederatedPointerEvent): void {
    if (!slot.msgId) {
      return;
    }
    if (this.nickAt(slot, ev) && slot.login && this.onNickRightClick) {
      ev.preventDefault();
      this.onNickRightClick(
        {
          msgId: slot.msgId,
          login: slot.login,
          authorLogin: slot.login,
          nick: slot.nickRaw,
          text: slot.copyText || slot.bodyRaw,
          clientX: ev.clientX,
          clientY: ev.clientY,
          disabled: slot.disabled,
          replyToId: slot.replyToId,
          linkUrl: "",
        },
        ev,
      );
      return;
    }
    const mentionLogin = this.mentionLoginAt(slot, ev);
    if (mentionLogin && this.onNickRightClick) {
      ev.preventDefault();
      this.onNickRightClick(
        {
          msgId: slot.msgId,
          login: mentionLogin,
          authorLogin: slot.login,
          nick: mentionLogin,
          text: slot.copyText || slot.bodyRaw,
          clientX: ev.clientX,
          clientY: ev.clientY,
          disabled: slot.disabled,
          replyToId: slot.replyToId,
          linkUrl: "",
        },
        ev,
      );
      return;
    }
    if (!this.onContext) {
      return;
    }
    ev.preventDefault();
    this.onContext({
      msgId: slot.msgId,
      login: slot.login,
      authorLogin: slot.login,
      nick: slot.nickRaw,
      text: slot.copyText || slot.bodyRaw,
      clientX: ev.clientX,
      clientY: ev.clientY,
      disabled: slot.disabled,
      replyToId: slot.replyToId,
      linkUrl: this.linkAt(slot, ev) ?? "",
    });
  }

  private onSlotMove(slot: Slot, ev: FederatedPointerEvent): void {
    if (this.nickAt(slot, ev) && slot.login) {
      slot.root.cursor = "pointer";
      return;
    }
    if (this.mentionLoginAt(slot, ev)) {
      slot.root.cursor = "pointer";
      return;
    }
    slot.root.cursor = this.linkAt(slot, ev) ? "pointer" : "default";
  }

  private nickAt(slot: Slot, ev: FederatedPointerEvent): boolean {
    if (!slot.login || slot.system || !slot.nickRaw) {
      return false;
    }
    const local = ev.getLocalPosition(slot.root);
    const nickW = Math.max(
      measureTextWidth(
        this.chatFontFamily,
        qtWeightToCss(this.nickBoldScale),
        this.fontSize,
        slot.nick.text,
      ),
      8,
    );
    return (
      local.x >= slot.nick.x &&
      local.x < slot.nick.x + nickW &&
      local.y >= 0 &&
      local.y < this.lineHeight
    );
  }

  private mentionLoginAt(slot: Slot, ev: FederatedPointerEvent): string | null {
    if (slot.mentionSpans.length === 0) {
      return null;
    }
    const local = ev.getLocalPosition(slot.root);
    if (local.x < slot.body.x || local.y < 0) {
      return null;
    }
    const col = Math.floor((local.x - slot.body.x) / this.charWidth);
    const line = Math.floor(local.y / this.lineHeight);
    const idx = lineColToIndex(
      slot.bodyRaw,
      slot.wrapLines,
      line,
      col,
      slot.spansRaw,
      this.wrapOpts(slot),
    );
    if (idx === null) {
      return null;
    }
    const hit = slot.mentionSpans.find(
      (span) => idx >= span.start && idx < span.end,
    );
    return hit?.login ?? null;
  }

  private linkAt(slot: Slot, ev: FederatedPointerEvent): string | undefined {
    const local = ev.getLocalPosition(slot.root);
    if (local.x < slot.body.x || local.y < 0) {
      return undefined;
    }
    const col = Math.floor((local.x - slot.body.x) / this.charWidth);
    const line = Math.floor(local.y / this.lineHeight);
    const idx = lineColToIndex(
      slot.bodyRaw,
      slot.wrapLines,
      line,
      col,
      slot.spansRaw,
      this.wrapOpts(slot),
    );
    if (idx === null) {
      return undefined;
    }
    const hit = slot.linkSpans.find((span) => idx >= span.start && idx < span.end);
    return hit?.url;
  }

  /** Hover target for emote/badge tooltip (text + optional CDN image). */
  tooltipHitAt(clientX: number, clientY: number): TooltipHit | null {
    if (!this.ready) {
      return null;
    }
    const canvas = this.app.canvas as HTMLCanvasElement;
    const rect = canvas.getBoundingClientRect();
    const localX = clientX - rect.left;
    const localY = clientY - rect.top;
    const stageY = this.app.stage.y;
    const row = Math.floor((localY - stageY) / this.lineHeight);
    if (row < 0) {
      return null;
    }
    const start = (this.head - this.occupied + MESSAGE_POOL_SIZE) % MESSAGE_POOL_SIZE;
    for (let i = 0; i < this.occupied; i += 1) {
      const slot = this.slots[(start + i) % MESSAGE_POOL_SIZE];
      if (!slot.msgId || !slot.root.visible) {
        continue;
      }
      if (slot.disabled && this.hideModerated) {
        continue;
      }
      const y0 = slot.startRow;
      const y1 = slot.startRow + slot.lineCount;
      if (row < y0 || row >= y1) {
        continue;
      }
      const slotLocalY = localY - stageY - slot.startRow * this.lineHeight;
      for (let b = 0; b < slot.badges.length; b += 1) {
        const spr = slot.badges[b];
        const badge = slot.badgesRaw[b];
        if (!badge || !spr.visible) {
          continue;
        }
        if (!spriteHit(localX, slotLocalY, spr)) {
          continue;
        }
        return {
          text: badgeTooltipText(badge.set),
          imageUrl: badge.url,
        };
      }
      const emoteHit = this.emoteTooltipAt(slot, localX, slotLocalY);
      if (emoteHit) {
        return emoteHit;
      }
      const linkHit = this.linkTooltipAt(slot, localX, slotLocalY);
      if (linkHit) {
        return linkHit;
      }
      return null;
    }
    return null;
  }

  private emoteTooltipAt(
    slot: Slot,
    localX: number,
    slotLocalY: number,
  ): TooltipHit | null {
    if (this.enableEmoteImages) {
      for (let e = slot.emotes.length - 1; e >= 0; e -= 1) {
        const spr = slot.emotes[e];
        const span = slot.spansRaw[e];
        if (!span || !spr.visible) {
          continue;
        }
        if (!spriteHit(localX, slotLocalY, spr)) {
          continue;
        }
        return {
          text: slot.bodyRaw.slice(span.start, span.end),
          imageUrl: this.emoteLoadUrl(span),
        };
      }
      return null;
    }
    if (
      localX < slot.body.x ||
      slotLocalY < 0 ||
      slotLocalY >= slot.lineCount * this.lineHeight
    ) {
      return null;
    }
    const col = Math.floor((localX - slot.body.x) / this.charWidth);
    const line = Math.floor(slotLocalY / this.lineHeight);
    const idx = lineColToIndex(
      slot.bodyRaw,
      slot.wrapLines,
      line,
      col,
      slot.spansRaw,
      this.wrapOpts(slot),
    );
    if (idx === null) {
      return null;
    }
    for (const span of slot.spansRaw) {
      if (idx >= span.start && idx < span.end) {
        return {
          text: slot.bodyRaw.slice(span.start, span.end),
          imageUrl: this.emoteLoadUrl(span),
        };
      }
    }
    return null;
  }

  private linkTooltipAt(
    slot: Slot,
    localX: number,
    slotLocalY: number,
  ): TooltipHit | null {
    if (slot.linkSpans.length === 0) {
      return null;
    }
    if (
      localX < slot.body.x ||
      slotLocalY < 0 ||
      slotLocalY >= slot.lineCount * this.lineHeight
    ) {
      return null;
    }
    const col = Math.floor((localX - slot.body.x) / this.charWidth);
    const line = Math.floor(slotLocalY / this.lineHeight);
    const idx = lineColToIndex(
      slot.bodyRaw,
      slot.wrapLines,
      line,
      col,
      slot.spansRaw,
      this.wrapOpts(slot),
    );
    if (idx === null) {
      return null;
    }
    const hit = slot.linkSpans.find(
      (span) => idx >= span.start && idx < span.end,
    );
    if (!hit) {
      return null;
    }
    return { text: hit.url, resolveUrl: hit.url };
  }

  /** Hover reply chip: screen rect of last visible privmsg under pointer, or null. */
  replyAnchorAt(clientX: number, clientY: number): {
    msgId: string;
    login: string;
    text: string;
    top: number;
    right: number;
  } | null {
    if (!this.showReplyButton || !this.ready) {
      return null;
    }
    void clientX;
    const canvas = this.app.canvas as HTMLCanvasElement;
    const rect = canvas.getBoundingClientRect();
    const localY = clientY - rect.top;
    const stageY = this.app.stage.y;
    const row = Math.floor((localY - stageY) / this.lineHeight);
    if (row < 0) {
      return null;
    }
    const start = (this.head - this.occupied + MESSAGE_POOL_SIZE) % MESSAGE_POOL_SIZE;
    for (let i = 0; i < this.occupied; i += 1) {
      const slot = this.slots[(start + i) % MESSAGE_POOL_SIZE];
      if (!slot.msgId || slot.system || !slot.login) {
        continue;
      }
      if (slot.disabled && this.hideModerated) {
        continue;
      }
      const y0 = slot.startRow;
      const y1 = slot.startRow + slot.lineCount;
      if (row >= y0 && row < y1) {
        return {
          msgId: slot.msgId,
          login: slot.login,
          text: slot.copyText || slot.bodyRaw,
          top: rect.top + stageY + slot.startRow * this.lineHeight,
          right: rect.right - 8,
        };
      }
    }
    return null;
  }

  isReplyButtonEnabled(): boolean {
    return this.showReplyButton;
  }

  private emotePixelSize(): number {
    return Math.max(1, Math.round((this.lineHeight - 4) * this.emoteScale));
  }

  private emoteLoadUrl(span: EmoteSpan): string {
    if (span.provider === "emoji") {
      return resolveEmojiUrl(span.emoteId, this.emojiSet);
    }
    return span.url;
  }

  private wrapOpts(
    slot?: Slot,
    maskMentions?: readonly MentionSpan[],
  ): WrapOptions {
    const images = this.enableEmoteImages;
    const emoteMinCols =
      images && this.charWidth > 0
        ? Math.max(1, Math.ceil(this.emotePixelSize() / this.charWidth))
        : 0;
    const chrome = this.boldUsernames || this.colorUsernames;
    const mentions =
      slot && chrome && slot.mentionSpans.length > 0
        ? (maskMentions ?? slot.mentionSpans)
        : undefined;
    return {
      emoteMinCols,
      maskEmotes: images,
      enableZeroWidth: images && this.enableZeroWidthEmotes,
      removeSpacesBetweenEmotes: images && this.removeSpacesBetweenEmotes,
      maskMentions: mentions,
    };
  }

  private reloadVisibleEmotes(): void {
    const start = (this.head - this.occupied + MESSAGE_POOL_SIZE) % MESSAGE_POOL_SIZE;
    for (let i = 0; i < this.occupied; i += 1) {
      const slot = this.slots[(start + i) % MESSAGE_POOL_SIZE];
      if (!slot.msgId) {
        continue;
      }
      for (const key of slot.emoteKeys) {
        if (key) {
          this.textures.release(key);
        }
      }
      slot.emoteKeys = new Array(slot.emotes.length).fill("");
      for (const spr of slot.emotes) {
        spr.visible = false;
        spr.texture = Texture.EMPTY;
      }
      if (!this.enableEmoteImages) {
        continue;
      }
      const msgId = slot.msgId;
      for (let e = 0; e < slot.emotes.length; e += 1) {
        const spr = slot.emotes[e];
        const span = slot.spansRaw[e];
        if (!span) {
          continue;
        }
        const key =
          span.provider === "cheer"
            ? `cheer:${span.url}`
            : `${span.provider}:${span.emoteId}`;
        slot.emoteKeys[e] = key;
        this.textures.acquire(key);
        const wantAnimate = this.animateEmotes;
        const url = this.emoteLoadUrl(span);
        void this.textures.load(key, url, wantAnimate).then((tex) => {
          if (
            tex &&
            slot.msgId === msgId &&
            this.enableEmoteImages &&
            slot.emoteKeys[e] === key &&
            this.animateEmotes === wantAnimate
          ) {
            applySpriteTexture(spr, tex, this.emotePixelSize());
          }
        });
      }
    }
  }

  private snapEmotesToFirstFrame(): void {
    const size = this.emotePixelSize();
    const start = (this.head - this.occupied + MESSAGE_POOL_SIZE) % MESSAGE_POOL_SIZE;
    for (let i = 0; i < this.occupied; i += 1) {
      const slot = this.slots[(start + i) % MESSAGE_POOL_SIZE];
      for (let e = 0; e < slot.emotes.length; e += 1) {
        const key = slot.emoteKeys[e];
        if (!key) {
          continue;
        }
        const spr = slot.emotes[e];
        const tex = this.textures.frameAt(key, 0) ?? this.textures.get(key);
        if (tex && spr.visible) {
          applySpriteTexture(spr, tex, size);
        }
      }
    }
  }

  private tickEmoteFrames(): void {
    if (!this.ready || !this.animateEmotes || !this.enableEmoteImages) {
      return;
    }
    const pos = this.emoteTicker.position();
    const size = this.emotePixelSize();
    const start = (this.head - this.occupied + MESSAGE_POOL_SIZE) % MESSAGE_POOL_SIZE;
    for (let i = 0; i < this.occupied; i += 1) {
      const slot = this.slots[(start + i) % MESSAGE_POOL_SIZE];
      if (!slot.root.visible) {
        continue;
      }
      for (let e = 0; e < slot.emotes.length; e += 1) {
        const key = slot.emoteKeys[e];
        if (!key || !this.textures.isAnimated(key)) {
          continue;
        }
        const spr = slot.emotes[e];
        if (!spr.visible) {
          continue;
        }
        const tex = this.textures.frameAt(key, pos);
        if (tex && spr.texture !== tex) {
          applySpriteTexture(spr, tex, size);
        }
      }
    }
  }
}

function clampEmoteScale(raw: number): number {
  if (!Number.isFinite(raw)) {
    return 1;
  }
  return Math.min(2, Math.max(0.5, raw));
}

/** Force BitmapText GPU rebuild after BitmapFont.uninstall (same text/size skips update). */
function dirtyBitmapText(bt: BitmapText): void {
  const prev = bt.text;
  bt.text = prev.length > 0 ? "" : " ";
  bt.text = prev;
}

function eventLogin(event: ChatEvent): string {
  if (event.kind === "privmsg") {
    return event.login.toLowerCase();
  }
  if (event.kind === "usernotice") {
    if (event.login) {
      return event.login.toLowerCase();
    }
    if (event.privmsg && event.privmsg.kind === "privmsg") {
      return event.privmsg.login.toLowerCase();
    }
  }
  return "";
}

function formatTime(ms: number, format: string): string {
  const d = new Date(ms);
  if (Number.isNaN(d.getTime())) {
    return "--:--";
  }
  const h24 = d.getHours();
  const h12 = h24 % 12 || 12;
  const ampm = h24 < 12 ? "am" : "pm";
  const mm = pad2(d.getMinutes());
  const ss = pad2(d.getSeconds());
  const zzz = String(d.getMilliseconds()).padStart(3, "0");
  switch (format) {
    case "h:mm":
      return `${h24}:${mm}`;
    case "h:mm a":
      return `${h12}:${mm} ${ampm}`;
    case "hh:mm a":
      return `${pad2(h12)}:${mm} ${ampm}`;
    case "h:mm:ss":
      return `${h24}:${mm}:${ss}`;
    case "hh:mm:ss":
      return `${pad2(h24)}:${mm}:${ss}`;
    case "h:mm:ss a":
      return `${h12}:${mm}:${ss} ${ampm}`;
    case "hh:mm:ss a":
      return `${pad2(h12)}:${mm}:${ss} ${ampm}`;
    case "h:mm:ss.zzz":
      return `${h24}:${mm}:${ss}.${zzz}`;
    case "hh:mm:ss.zzz":
      return `${pad2(h24)}:${mm}:${ss}.${zzz}`;
    case "h:mm:ss.zzz a":
      return `${h12}:${mm}:${ss}.${zzz} ${ampm}`;
    case "hh:mm:ss.zzz a":
      return `${pad2(h12)}:${mm}:${ss}.${zzz} ${ampm}`;
    case "hh:mm":
    default:
      return `${pad2(h24)}:${mm}`;
  }
}

function pad2(n: number): string {
  return n.toString().padStart(2, "0");
}

function normalizeEmojiSet(raw: string): string {
  const key = raw.trim().toLowerCase();
  if (key === "facebook") {
    return "Facebook";
  }
  if (key === "apple") {
    return "Apple";
  }
  if (key === "google") {
    return "Google";
  }
  return "Twitter";
}

function clearchatText(login: string | undefined, durationSec: number | undefined): string {
  if (!login) {
    return "чат очищен";
  }
  if (durationSec !== undefined) {
    return `${login} тайм-аут ${durationSec}с`;
  }
  return `${login} забанен`;
}

function deletionNoticeText(login: string, body: string, limit: number): string {
  return `A message from ${login} was deleted: ${truncateDeletedBody(body, limit)}`;
}

function truncateDeletedBody(body: string, limit: number): string {
  if (limit <= 0 || body.length <= limit) {
    return body;
  }
  return `${body.slice(0, limit)}…`;
}

function shiftSpans<T extends { start: number; end: number }>(spans: T[], shift: number): T[] {
  if (shift === 0) {
    return spans;
  }
  return spans.map((span) => ({
    ...span,
    start: span.start + shift,
    end: span.end + shift,
  }));
}

function badgesWithUrl(badges: Badge[]): Badge[] {
  const out: Badge[] = [];
  for (const badge of badges) {
    if (!badge.url) {
      continue;
    }
    out.push(badge);
    if (out.length >= BADGE_SLOTS_PER_ROW) {
      break;
    }
  }
  return out;
}

function parseHighlight(raw: string): { color: number; alpha: number } | undefined {
  const m = /^#([0-9a-fA-F]{6})([0-9a-fA-F]{2})?$/.exec(raw);
  if (!m) {
    return undefined;
  }
  const color = Number.parseInt(m[1], 16);
  const alpha = m[2] ? Number.parseInt(m[2], 16) / 255 : 1;
  return { color, alpha };
}

function applySpriteTexture(spr: Sprite, tex: Texture, size: number): void {
  spr.texture = tex;
  spr.width = size;
  spr.height = size;
}

export type TooltipHit = {
  text: string;
  imageUrl?: string;
  resolveUrl?: string;
};

function spriteHit(localX: number, localY: number, spr: Sprite): boolean {
  return (
    localX >= spr.x &&
    localX < spr.x + spr.width &&
    localY >= spr.y &&
    localY < spr.y + spr.height
  );
}

function badgeTooltipText(set: string): string {
  return set
    .split(/[-_]/)
    .filter((part) => part.length > 0)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1).toLowerCase())
    .join(" ");
}

function maxBodyChars(paneWidth: number, bodyX: number, charWidth: number): number {
  return Math.floor(Math.max(1, paneWidth - bodyX - 8) / charWidth);
}
