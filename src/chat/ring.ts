import { ViewPool } from "./viewPool";
import { createMessageRow, resetMessageRow, type MessageRow } from "./messageRow";
import { createMessageRowView, type MessageRowView } from "./messageRowView";
import { bodyIndexAt, inside } from "./rowHitTest";
import { NickPaintResources } from "./nickPaintResources";
import {
  clampEmoteScale,
  parseCheerColor,
  eventLogin,
  pad2,
  normalizeEmojiSet,
  shiftSpans,
  badgesWithUrl,
  parseHighlight,
  badgeTooltipText,
  clipReplyHeaderToWidth,
} from "./rowFormatting";
import {
  BitmapFont,
  BitmapFontManager,
  BitmapText,
  Cache,
  FederatedPointerEvent,
  Graphics,
  Rectangle,
  Sprite,
  TextStyle,
  Texture,
  type Application,
} from "pixi.js";

import { invoke } from "@tauri-apps/api/core";
import type { WorkspaceScroll } from "../shell/workspace";
import type { ChatPerformance } from "./performance";
import {
  BADGE_SIZE,
  BADGE_SLOTS_PER_ROW,
  EMOTE_SLOTS_PER_ROW,
  MENTION_SLOTS_PER_ROW,
  MOD_ACTION_SLOTS_PER_ROW,
} from "../constants";
import type { ModActionBtn } from "../shell/modActions";
import { modGutterActions } from "../shell/modActions";
import { modGutterIconTexture } from "../shell/modGutterIcons";
import type {
  Badge,
  ChatEvent,
  EmoteSpan,
  LinkSpan,
  MentionSpan,
} from "./types";
import {
  paintRepresentativeRgb,
} from "./nickPaint";

/** Stock Chatterino low-trust / restricted row tint (`MessageLayout.cpp` `#404040`). */
const LOW_TRUST_HIGHLIGHT = "#404040";
import {
  clearchatFormatted,
  deletionNoticeText,
  formatReplyHeader,
  noticeFormatted,
  usernoticeFormatted,
  whisperPrefix,
} from "./chatSystemText";
import { t } from "../i18n/index.ts";
import { resolveEmojiUrl, resolveGifFallbackUrl } from "./emoteUrl";
import { trailingDebounce, type TrailingDebounce } from "./debounce";
import {
  badgeVisibilityEqual,
  DEFAULT_BADGE_VISIBILITY,
  filterVisibleBadges,
  type BadgeVisibilityFlags,
} from "./badgeVisibility";
import { lowercaseLinkHosts, type HostSpanRange } from "./linkDisplay";
import type { ClipCardInfo } from "./linkEnrichment";
import {
  clipCardContains,
  clipCardRowCount,
  createClipCardWidgets,
  paintClipCard,
  releaseClipThumb,
} from "./clipCardPixi";
import { EmoteFrameTicker, isRenderableTexture, TextureLru } from "./textures";
import {
  cleanseSpriteTexture,
  detachSpriteTexture,
  resetBitmapTextGpuTree,
  sanitizeStageSprites,
} from "./textureGuards";
import {
  ScrollModel,
  wheelDeltaRows,
  type LaidSlot,
  type ScrollAnchor,
  type ScrollSnapshot,
} from "./scroll";
import {
  atlasFontSize,
  chatTextRowHeight,
  clampChatFontSize,
  clampChatFontWeight,
  defaultChatLineHeight,
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
import {
  applyNickname,
  nicknameRulesEqual,
  type NicknameRule,
} from "../shell/nicknames";
import { NickColorCache } from "../shell/nickColorCache";
import { formatFullCopyText } from "../shell/copyFormat";
import {
  clipNick,
  collapseWrapLines,
  emoteDisplaySize,
  indexToLineCol,
  renderWrapped,
  renderWrappedContinuation,
  withCollapsedEllipsis,
  wrapBody,
  wrapLineHeights,
  wrapLineOffsetY,
  wrapLineOriginX,
  type WrapLine,
  type WrapOptions,
} from "./wrap";

function onlyAsciiSpaces(text: string, start: number, end: number): boolean {
  if (start > end) {
    return false;
  }
  for (let i = start; i < end; i += 1) {
    if (text.charCodeAt(i) !== 32) {
      return false;
    }
  }
  return true;
}

function stacksZeroWidth(
  text: string,
  prevEnd: number,
  spanStart: number,
  zw: boolean,
  hasPrev: boolean,
): boolean {
  return zw && hasPrev && onlyAsciiSpaces(text, prevEnd, spanStart);
}

const TIME_GAP = 8;
const BADGE_GAP = 2;
/** Chatterino MessageLayoutContainer MARGIN.top/bottom (once per message). */
const MESSAGE_GAP = 4;
/** Soft-clip nick only when it would leave less than this many body columns. */
const MIN_BODY_COLS_AFTER_NICK = 1;
/** Left-aligned system-event cloud (Twitch web-style pill). */
const SYSTEM_CLOUD_BG = 0x2b273f;
const SYSTEM_CLOUD_FG = 0xa39bb8;
const SYSTEM_CLOUD_PAD_X = 12;
const SYSTEM_CLOUD_PAD_Y = 1;
const SYSTEM_CLOUD_RADIUS = 8;
const SYSTEM_CLOUD_MARGIN_X = 8;
/** System event pills: effective chat fontSize minus this many CSS px. */
const SYSTEM_CLOUD_FONT_DELTA = 2;
const MOD_GUTTER_ICON_COUNT = 2;
/** Stock-ish green chrome for AutoMod held rows (#00ad33 @ ~50%). */
const AUTOMOD_HIGHLIGHT = "#00ad3380";
const AUTOMOD_CAUGHT_COLOR = 0xff3333;

export type PauseModifier = "None" | "Shift" | "Control" | "Alt" | "Meta";

export type ImageHit = {
  url: string;
  kind: "emote" | "badge";
  provider?: string;
};

export type SlotContext = {
  msgId: string;
  /** Painted channel login (snapshot at open time for mod actions). */
  channel: string;
  login: string;
  /** Автор сообщения (для Reply); = login на клике по нику. */
  authorLogin: string;
  nick: string;
  text: string;
  /** Stock Copy full message (timestamp + nick + body). */
  fullText: string;
  clientX: number;
  clientY: number;
  disabled: boolean;
  replyToId: string;
  linkUrl: string;
  /** CDN URL эmote/badge под курсором (stock addImageContextMenuItems). */
  imageUrl: string;
  imageKind: "" | "emote" | "badge";
  /** Provider эmote под курсором (twitch/bttv/ffz/7tv/…). */
  imageProvider: string;
  /** Stock: View thread when message is in a reply thread. */
  inReplyThread: boolean;
  /** Stock: hidden items only when modifier is exactly Shift. */
  shiftOnly: boolean;
};

type Slot = MessageRow;

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
  private readonly poolSize: number;
  private readonly slots: Slot[] = [];
  private readonly wantedViews: Slot[] = [];
  private readonly viewPool = new ViewPool<Slot, MessageRowView>({
    create: () => this.createRowView(),
    bind: (slot, view) => this.bindRowView(slot, view),
    unbind: (slot, view) => this.releaseRowView(slot, view),
    // Row graphics own their contexts; an options object must destroy them explicitly.
    destroy: (view) => view.root.destroy({ children: true, context: true, style: true }),
  });
  private readonly textures: TextureLru;
  private readonly emoteTicker = new EmoteFrameTicker();
  private readonly scroll = new ScrollModel();
  private readonly laidBuf: LaidSlot[] = [];
  private readonly measureStyles = new Map<string, TextStyle>();
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
  private lineHeight = defaultChatLineHeight(10);
  private charWidth = 10 * 0.56;
  private badgeSize = BADGE_SIZE;
  private emoteScale = 1;
  private stackBits = false;
  private enableEmoteImages = true;
  private enableZeroWidthEmotes = true;
  private removeSpacesBetweenEmotes = false;
  private emojiSet = "Twitter";
  private animateEmotes = true;
  private findHitId = "";
  private hideModerated = false;
  private hideModerationActions = false;
  private hideRestrictedUsers = false;
  private hideDeletionActions = false;
  private deletedMessageLengthLimit = 50;
  private fadeMessageHistory = true;
  private hideTimestampsWhenLive = false;
  private channelLive = false;
  private loadingSnapshot = false;
  /**
   * After snapshot/history rewrite: snap stick-to-bottom growth (no smooth-new-message
   * tweens) until lazy paints + brief catch-up quiet, then one final snap if still pinned.
   */
  private layoutSettling = false;
  private layoutSettleGen = 0;
  private layoutSettlePinned = false;
  private layoutSettleStartedAt = 0;
  private layoutSettleQuietUntil = 0;
  private static readonly LAYOUT_SETTLE_MAX_MS = 600;
  private static readonly LAYOUT_SETTLE_QUIET_MS = 64;
  private mediaRepaintSlots = new Set<Slot>();
  private mediaRepaintRaf = 0;
  private renderPrerenderHook: (() => void) | null = null;
  private rendererSanitizePatched = false;
  /** Dedupe prerender + renderStart + patched render in the same ticker frame. */
  private lastSanitizeTickerTime = Number.NaN;
  /** Live msg ids this channel session (survive gap recovery snapshot). */
  private liveMsgIds = new Set<string>();
  /**
   * CLEARMSG arrived before the target row was in the ring (local-echo / recover).
   * Applied when the matching msgId is written; capped + pruned on reset.
   */
  private deferredClearMsg = new Map<
    string,
    Extract<ChatEvent, { kind: "clearmsg" }>
  >();
  private static readonly DEFERRED_CLEAR_CAP = 64;
  /** Channel login this ring is painting (mod/AutoMod channel bind). */
  private boundChannel = "";
  private showReplyButton = true;
  private moderationMode = false;
  /** IRC/Helix viewer is mod or broadcaster on the painted channel. */
  private canModerate = false;
  private modActions: ModActionBtn[] = [];
  private selfLogin = "";
  private linksDoubleClickOnly = false;
  /** Stock links.lowercaseDomains (default on). */
  private lowercaseDomains = true;
  private alternateMessages = false;
  private separateMessages = false;
  private collapseMessagesMinLines = 0;
  private showLastRead = false;
  private lastReadPattern: LastReadPattern = "Solid";
  private lastReadColor = 0x7f2026;
  private lastReadMsgId = "";
  private colorizeNicknames = true;
  private usernameDisplayMode: UsernameDisplayMode = "UsernameAndLocalizedName";
  private nicknameRules: NicknameRule[] = [];
  private nickBoldScale = 63;
  private nickAtlasDesignSize = 0;
  private boldUsernames = true;
  private colorUsernames = true;
  private readonly nickColorCache = new NickColorCache(500);
  /** Canvas textures for 7TV nick paints (key → Texture). */
  private readonly nickPaintResources = new NickPaintResources(() => this.viewPool.views);
  private hideReplyContext = false;
  private badgeVisibility: BadgeVisibilityFlags = { ...DEFAULT_BADGE_VISIBILITY };
  private pauseMouse = false;
  private pauseKey = false;
  private pauseFollowIntent = false;
  private pauseOnHoverSec = 0;
  private pauseModifier: PauseModifier = "None";
  private wheelMultiplier = 1;
  private hoverPauseTimer = 0;
  private scrollRaf = 0;
  private resizeDebounce: TrailingDebounce | null = null;
  private perfLogAt = 0;
  private readonly perfOn: boolean;
  private viewportPaintRaf = 0;
  private readonly onRendererResize = (): void => {
    this.resizeDebounce?.schedule();
  };
  private themeFills: ThemePixiFills = {
    canvasBg: 0x191919,
    body: 0xffffff,
    timestamp: 0x8c7f7f,
    nickFallback: 0x8c7f7f,
    alternate: 0x222222,
    alternateAlpha: 1,
    hover: 0x222222,
    hoverAlpha: 0.35,
    separator: 0x3c3c3c,
    disabled: 0x191919,
    disabledAlpha: 0x99 / 255,
  };
  private hoveredMsgId = "";
  private lastReadFadeMsgId = "";
  private lastReadFadeStart = 0;
  private lastReadFadeRaf = 0;
  private pendingBelow = 0;
  private onScroll: ((state: ScrollSnapshot) => void) | undefined;
  private onContext: ((ctx: SlotContext) => void) | undefined;
  private onNickClick: ((ctx: SlotContext) => void) | undefined;
  private onNickRightClick: ((ctx: SlotContext, ev: FederatedPointerEvent) => void) | undefined;
  private onOpenChatLink: ((url: string) => void) | undefined;
  private onModAction:
    | ((action: string, ctx: SlotContext) => void)
    | undefined;
  private onAutomodAction:
    | ((action: "allow" | "deny", messageId: string, ctx: SlotContext) => void)
    | undefined;
  private onViewerRoleChange: (() => void) | undefined;
  private hoverGuard: (() => boolean) | undefined;

  constructor(
    private readonly app: Application,
    textures: TextureLru,
    poolSize: number,
  ) {
    this.poolSize = poolSize;
    this.textures = textures;
    this.textures.setInvalidateListener((id, doomed) => {
      this.onTexturesInvalidated(id, doomed);
    });
    this.emoteTicker.subscribe(() => this.tickEmoteFrames());
    this.perfOn =
      import.meta.env.DEV === true ||
      (typeof localStorage !== "undefined" &&
        localStorage.getItem("crt-debug") === "1");
  }

  setOnScroll(cb: (state: ScrollSnapshot) => void): () => void {
    const subscription = (state: ScrollSnapshot): void => cb(state);
    this.onScroll = subscription;
    return () => {
      if (this.onScroll === subscription) this.onScroll = undefined;
    };
  }


  peekLinkEnrichment(msgId: string): {
    bodySource: string;
    links: LinkSpan[];
    spans: EmoteSpan[];
    mentions: MentionSpan[];
  } | null {
    const slot = this.findSlotByMsgId(msgId);
    if (
      !slot ||
      slot.linkEnriched ||
      !slot.bodySource ||
      slot.linkSpans.length === 0
    ) {
      return null;
    }
    return {
      bodySource: slot.bodySource,
      links: slot.linkSpans.map((l) => ({ ...l })),
      spans: slot.spansRaw.map((s) => ({ ...s })),
      mentions: slot.mentionSpans.map((m) => ({ ...m })),
    };
  }

  applyLinkEnrichment(
    msgId: string,
    payload: {
      body: string;
      links: LinkSpan[];
      hosts: HostSpanRange[];
      spans: EmoteSpan[];
      mentions: MentionSpan[];
      clip: ClipCardInfo | null;
    },
  ): void {
    const slot = this.findSlotByMsgId(msgId);
    if (!slot || !this.ready) {
      return;
    }
    const anchors = this.captureScrollAnchors();
    slot.bodyRaw = payload.body;
    slot.linkSpans = payload.links;
    slot.hostSpans = payload.hosts;
    slot.spansRaw = payload.spans;
    slot.mentionSpans = payload.mentions;
    slot.clipCard = payload.clip;
    slot.clipCardRows = payload.clip ? clipCardRowCount(this.lineHeight) : 0;
    slot.linkEnriched = true;
    // Only this row needs wrap recompute; dual-anchor layout preserves scroll.
    this.invalidateSlotWrap(slot);
    slot.wrapLineHeights = [];
    slot.lineCount = this.estimateSlotLineCount(slot);
    this.layout(anchors, new Set([slot]));
  }

  /** Highlight colors in scrollback order (empty string = no mark). Stock 1:1 with messages. */
  highlightMarks(): string[] {
    if (this.highlightMarksCacheGen === this.highlightMarksGen) {
      return this.highlightMarksCache;
    }
    const out: string[] = [];
    const start = (this.head - this.occupied + this.poolSize) % this.poolSize;
    for (let i = 0; i < this.occupied; i += 1) {
      const slot = this.slots[(start + i) % this.poolSize];
      if (this.isSlotHiddenByPrivacy(slot)) {
        out.push("");
      } else {
        out.push(slot.msgId ? slot.highlightColor : "");
      }
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

  /** Streamer-mode / hide-moderated privacy gate for layout, a11y, scrollbar marks. */
  private isSlotHiddenByPrivacy(slot: Slot): boolean {
    if (!slot.msgId) {
      return true;
    }
    if (this.hideModerated && slot.disabled) {
      return true;
    }
    if (this.hideRestrictedUsers && slot.lowTrustStatus === "restricted") {
      return true;
    }
    return false;
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

  setOnOpenChatLink(cb: (url: string) => void): void {
    this.onOpenChatLink = cb;
  }

  setOnModAction(cb: (action: string, ctx: SlotContext) => void): void {
    this.onModAction = cb;
  }

  setOnAutomodAction(
    cb: (action: "allow" | "deny", messageId: string, ctx: SlotContext) => void,
  ): void {
    this.onAutomodAction = cb;
  }

  setOnViewerRoleChange(cb: () => void): void {
    this.onViewerRoleChange = cb;
  }

  setHoverGuard(cb: (() => boolean) | undefined): void {
    this.hoverGuard = cb;
  }

  setModerationMode(on: boolean): void {
    if (this.moderationMode === on) {
      return;
    }
    this.moderationMode = on;
    if (this.ready) {
      this.markLayoutFullPaint();
      this.layout();
    }
  }

  moderationModeOn(): boolean {
    return this.moderationMode;
  }

  /**
   * Whether gutter may paint for the active channel. Cleared when role is lost
   * or the tab has no mod/BC rights (P1 moderation mode re-check).
   */
  setCanModerate(on: boolean): void {
    if (this.canModerate === on) {
      return;
    }
    this.canModerate = on;
    if (this.ready && this.moderationMode) {
      this.markLayoutFullPaint();
      this.layout();
    }
  }

  canModerateOn(): boolean {
    return this.canModerate;
  }

  setModActions(actions: ModActionBtn[]): void {
    const next = actions.slice(0, MOD_ACTION_SLOTS_PER_ROW);
    if (
      next.length === this.modActions.length &&
      next.every((a, i) => a.action === this.modActions[i]!.action)
    ) {
      this.modActions = next;
      return;
    }
    this.modActions = next;
    if (this.ready) {
      this.markLayoutFullPaint();
      this.layout();
    }
  }

  setSelfLogin(login: string | null | undefined): void {
    const next = (login ?? "").trim().toLowerCase();
    if (this.selfLogin === next) {
      return;
    }
    this.selfLogin = next;
    if (this.ready && this.moderationMode) {
      this.markLayoutFullPaint();
      this.layout();
    }
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

  /** Twitch IRC badge category knobs (stock Visible badges). */
  configureBadgeVisibility(flags: BadgeVisibilityFlags): void {
    if (badgeVisibilityEqual(this.badgeVisibility, flags)) {
      return;
    }
    this.badgeVisibility = { ...flags };
    if (!this.ready) {
      return;
    }
    const start = (this.head - this.occupied + this.poolSize) % this.poolSize;
    for (let i = 0; i < this.occupied; i += 1) {
      const slot = this.slots[(start + i) % this.poolSize];
      if (slot.msgId) {
        this.loadBadgeSprites(slot);
      }
    }
    this.markLayoutFullPaint();
    this.layout();
  }

  /** Stock links.lowercaseDomains: paint host lowercased; open/copy keep original. */
  configureLowercaseDomains(enabled: boolean): void {
    const on = enabled !== false;
    if (on === this.lowercaseDomains) {
      return;
    }
    this.lowercaseDomains = on;
    if (!this.ready) {
      return;
    }
    this.refreshDisplayBodies();
    this.markLayoutFullPaint();
    this.layout();
  }

  /** Stock emotes.stackBits: one cheer emote + total bits label per message. */
  configureStackBits(enabled: boolean): void {
    const on = enabled === true;
    if (on === this.stackBits) {
      return;
    }
    this.stackBits = on;
    if (!this.ready) {
      return;
    }
    this.markLayoutFullPaint();
    this.layout();
  }

  private displayBody(source: string, links: LinkSpan[]): string {
    if (!this.lowercaseDomains || !source || links.length === 0) {
      return source;
    }
    return lowercaseLinkHosts(source, links);
  }

  /** Rebuild painted bodies after lowercaseDomains toggle; skip title-enriched rows. */
  private refreshDisplayBodies(): void {
    const start = (this.head - this.occupied + this.poolSize) % this.poolSize;
    for (let i = 0; i < this.occupied; i += 1) {
      const slot = this.slots[(start + i) % this.poolSize];
      if (!slot.msgId || slot.linkEnriched) {
        continue;
      }
      slot.bodyRaw = this.displayBody(slot.bodySource, slot.linkSpans);
    }
  }

  private visibleBadges(slot: MessageRow): Badge[] {
    return filterVisibleBadges(
      slot.badgesRaw,
      this.badgeVisibility,
      BADGE_SLOTS_PER_ROW,
    );
  }

  /** Reposition badge/emote sprites after async CDN texture load. */
  private repaintSlotMedia(slot: Slot): void {
    if (!this.ready || !slot.msgId) {
      return;
    }
    this.mediaRepaintSlots.add(slot);
    if (this.mediaRepaintRaf !== 0) {
      return;
    }
    this.mediaRepaintRaf = requestAnimationFrame(() => {
      this.mediaRepaintRaf = 0;
      const batch = [...this.mediaRepaintSlots];
      this.mediaRepaintSlots.clear();
      // Capture while root.y and lineCount still agree; paint may change heights.
      const anchors = this.captureScrollAnchors();
      let heightChanged = false;
      for (const s of batch) {
        if (!s.msgId || !s.visible) {
          continue;
        }
        const prev = this.slotPixelHeight(s);
        this.repositionSlotMedia(s);
        if (this.slotPixelHeight(s) !== prev) {
          heightChanged = true;
        }
      }
      if (heightChanged) {
        this.repositionRootsFromCache(anchors);
      }
    });
  }

  /**
   * After texture load: refresh emote/badge placement without re-wrapping body.
   * Falls back to paintClip only when wrap metrics are missing.
   */
  private repositionSlotMedia(slot: Slot): void {
    const view = this.viewPool.get(slot);
    if (!view) { return; }
    if (this.isSystemCloud(slot)) {
      this.paintClip(slot);
      return;
    }
    if (
      slot.wrapLines.length === 0 ||
      (slot.wrapLines.length === 1 &&
        slot.wrapLines[0].start === 0 &&
        slot.wrapLines[0].end === 0 &&
        slot.bodyRaw.length > 0)
    ) {
      this.paintClip(slot);
      return;
    }
    const gap = Math.max(4, Math.round(TIME_GAP * this.fontScale));
    const timeSample = this.timestampsVisible()
      ? formatTime(Date.UTC(2000, 0, 1, 23, 59, 59, 999), this.timestampFormat)
      : "";
    const timeW = this.timestampsVisible()
      ? this.measureBitmapTextWidth("ChatFont", timeSample) + gap
      : 0;
    const gutterW = this.paintModGutter(slot);
    const replyRows = slot.replyRows;
    const contentY = replyRows * this.lineHeight;
    for (const mt of view.modBtns) {
      if (mt.visible) {
        mt.y = contentY;
      }
    }
    for (const spr of view.modIcons) {
      if (spr.visible) {
        spr.y = this.lineMediaY(contentY, spr.height || this.fontSize);
      }
    }
    const badgeVisible = this.visibleBadges(slot);
    for (let i = 0; i < view.badges.length; i += 1) {
      const spr = view.badges[i];
      const badge = badgeVisible[i];
      if (!badge) {
        spr.visible = false;
        continue;
      }
      if (!isRenderableTexture(spr.texture)) {
        spr.visible = false;
        spr.texture = Texture.EMPTY;
        continue;
      }
      spr.visible = true;
      spr.x = gutterW + timeW + i * (this.badgeSize + BADGE_GAP);
      spr.y = this.lineMediaY(contentY, this.badgeSize);
    }
    const firstOriginX = slot.bodyIndent;
    const contOriginX = slot.bodyContIndent;
    const lines = slot.wrapLines;
    const layoutOpts = this.wrapOpts(slot, undefined, Math.max(1, firstOriginX));
    let prevX = 0;
    let prevY = 0;
    let hasPrev = false;
    let prevEnd = 0;
    let bitsLabelShown = false;
    for (let i = 0; i < view.emotes.length; i += 1) {
      const spr = view.emotes[i];
      const span = slot.spansRaw[i];
      if (!span || !this.enableEmoteImages || span.provider === "cheer-mask") {
        spr.visible = false;
        continue;
      }
      const paint = this.emotePaintSize(span, this.slotBodyFontSize(slot));
      const zw = this.enableZeroWidthEmotes && span.zeroWidth === true;
      // Overlay only onto the last painted non-mask emote; lone ZW paints as a regular emote.
      if (stacksZeroWidth(slot.bodyRaw, prevEnd, span.start, zw, hasPrev)) {
        this.paintEmoteSpriteAt(slot, i, spr, span, prevX, prevY, paint.w, paint.h);
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
      this.paintEmoteSpriteAt(
        slot,
        i,
        spr,
        span,
        wrapLineOriginX(firstOriginX, pos.line, contOriginX) + pos.col,
        this.lineMediaYForWrapLine(contentY, paint.h, pos.line, slot),
        paint.w,
        paint.h,
      );
      prevX = spr.x;
      prevY = spr.y;
      hasPrev = true;
      prevEnd = span.end;
      if (
        !bitsLabelShown &&
        this.stackBits &&
        span.bitsAmount != null &&
        span.bitsAmount > 0 &&
        span.bitsColor
      ) {
        const tint = parseCheerColor(span.bitsColor);
        if (tint != null) {
          view.bitsLabel.visible = true;
          view.bitsLabel.text = ` ${span.bitsAmount}`;
          view.bitsLabel.tint = tint;
          view.bitsLabel.x = spr.x + paint.w + 2;
          view.bitsLabel.y = this.wrapLineY(contentY, pos.line, slot);
          bitsLabelShown = true;
        }
      }
    }
    if (!bitsLabelShown) {
      view.bitsLabel.visible = false;
      view.bitsLabel.text = "";
    }
  }

  /** Sealed desired+visual anchors captured against one laidSlots epoch. */
  private captureScrollAnchors(explicitTarget?: ScrollAnchor): {
    target: ScrollAnchor | undefined;
    visual: ScrollAnchor | undefined;
    sealed: true;
  } {
    const laid = this.laidSlots();
    const target = explicitTarget ?? this.scroll.captureAnchor(laid);
    const visual = this.scroll.atBottom
      ? undefined
      : this.scroll.captureAnchor(laid, this.scroll.current);
    return { target, visual, sealed: true };
  }

  private isAnchorPair(
    arg:
      | ScrollAnchor
      | {
          target: ScrollAnchor | undefined;
          visual: ScrollAnchor | undefined;
          sealed: true;
        }
      | undefined,
  ): arg is {
    target: ScrollAnchor | undefined;
    visual: ScrollAnchor | undefined;
    sealed: true;
  } {
    return !!arg && "sealed" in arg && arg.sealed === true;
  }

  /** Update root.y / startRow from cached lineCount without paintClip. */
  private repositionRootsFromCache(pair?: {
    target: ScrollAnchor | undefined;
    visual: ScrollAnchor | undefined;
    sealed: true;
  }): void {
    const anchors = pair ?? this.captureScrollAnchors();
    this.updateSlotVisibility();
    const y = this.positionVisibleSlots();
    const viewRows = this.app.screen.height / this.lineHeight;
    this.scroll.applyLayout(
      this.lineHeight > 0 ? y / this.lineHeight : 0,
      viewRows,
      this.laidSlots(),
      anchors.target,
      this.isPaused(),
      anchors.visual,
      true,
      false,
    );
    this.afterScrollChange();
  }

  private updateSlotVisibility(): void {
    const start = (this.head - this.occupied + this.poolSize) % this.poolSize;
    for (let i = 0; i < this.occupied; i += 1) {
      const slot = this.slots[(start + i) % this.poolSize];
      slot.visible = !this.isSlotHiddenByPrivacy(slot);
    }
  }

  private positionVisibleSlots(): number {
    const start = (this.head - this.occupied + this.poolSize) % this.poolSize;
    const gapPx = this.messageGapPx();
    let y = 0;
    let shown = 0;
    for (let i = 0; i < this.occupied; i += 1) {
      const slot = this.slots[(start + i) % this.poolSize];
      if (!slot.visible) {
        continue;
      }
      if (shown > 0) {
        y += gapPx;
      }
      slot.startRow = shown;
      slot.y = y;
      y += this.slotPixelHeight(slot);
      shown += 1;
    }
    return y;
  }

  private loadBadgeSprites(slot: Slot): void {
    const view = this.viewPool.get(slot);
    if (!view) { return; }
    const token = this.viewPool.tokenOf(slot);
    for (const spr of view.badges) {
      spr.visible = false;
      spr.texture = Texture.EMPTY;
    }
    for (const key of view.badgeKeys) {
      if (key) {
        this.textures.release(key);
      }
    }
    const visible = this.visibleBadges(slot);
    this.resizeMediaSprites(slot, view.badges, visible.length);
    view.badgeKeys = new Array(view.badges.length).fill("");
    const msgId = slot.msgId;
    for (let i = 0; i < view.badges.length; i += 1) {
      const spr = view.badges[i];
      const badge = visible[i];
      if (!badge || !badge.url) {
        continue;
      }
      const key = `badge:${badge.url}`;
      view.badgeKeys[i] = key;
      this.textures.acquire(key);
      void this.textures.load(key, badge.url, false).then((tex) => {
        if (tex && this.viewPool.owns(slot, view, token) && slot.msgId === msgId &&
            view.badgeKeys[i] === key && view.badges[i] === spr) {
          applySpriteTexture(spr, tex, this.badgeSize, this.badgeSize);
          this.repaintSlotMedia(slot);
        }
      });
    }
  }

  /** Capture newest message id when leaving the app (stock updateLastReadMessage). */
  markLastReadAtBottom(): void {
    if (!this.showLastRead || this.occupied === 0) {
      return;
    }
    const idx = (this.head - 1 + this.poolSize) % this.poolSize;
    const id = this.slots[idx]?.msgId ?? "";
    if (id === this.lastReadMsgId) {
      return;
    }
    this.lastReadMsgId = id;
    this.beginLastReadFade(id);
    if (this.ready) {
      this.repaintHighlights();
    }
  }

  private beginLastReadFade(id: string): void {
    this.lastReadFadeMsgId = id;
    this.lastReadFadeStart = performance.now();
    if (this.lastReadFadeRaf !== 0) {
      cancelAnimationFrame(this.lastReadFadeRaf);
      this.lastReadFadeRaf = 0;
    }
    const reduce =
      typeof matchMedia === "function" &&
      matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (reduce) {
      this.lastReadFadeStart = 0;
      return;
    }
    const tick = (): void => {
      this.lastReadFadeRaf = 0;
      if (!this.lastReadFadeMsgId || this.lastReadFadeMsgId !== this.lastReadMsgId) {
        return;
      }
      const elapsed = performance.now() - this.lastReadFadeStart;
      this.repaintHighlights();
      if (elapsed < 150) {
        this.lastReadFadeRaf = requestAnimationFrame(tick);
      } else {
        this.lastReadFadeStart = 0;
      }
    };
    this.lastReadFadeRaf = requestAnimationFrame(tick);
  }

  pendingBelowCount(): number {
    return this.pendingBelow;
  }

  /**
   * Newest-last plain lines for SR readback. Caps work to `limit`; no layout/GPU.
   */
  a11yPlainLines(
    limit = 6,
  ): Array<{ nick: string; text: string; system: boolean }> {
    const out: Array<{ nick: string; text: string; system: boolean }> = [];
    if (limit <= 0 || this.occupied <= 0) {
      return out;
    }
    const start = (this.head - this.occupied + this.poolSize) % this.poolSize;
    for (let i = this.occupied - 1; i >= 0 && out.length < limit; i -= 1) {
      const slot = this.slots[(start + i) % this.poolSize];
      if (this.isSlotHiddenByPrivacy(slot)) {
        continue;
      }
      const text = (slot.copyText || slot.bodyRaw || "").trim();
      if (!text) {
        continue;
      }
      out.push({
        nick: slot.system ? "" : slot.nickRaw || slot.login || "",
        text,
        system: slot.system,
      });
    }
    out.reverse();
    return out;
  }

  occupiedCount(): number {
    return this.occupied;
  }

  clearHover(): void {
    if (!this.hoveredMsgId) {
      return;
    }
    const prev = this.hoveredMsgId;
    this.hoveredMsgId = "";
    const slot = this.findSlotByMsgId(prev);
    if (slot) {
      this.paintHighlight(slot);
    }
  }

  private setHoveredMsgId(id: string): void {
    if (id === this.hoveredMsgId) {
      return;
    }
    const prev = this.hoveredMsgId;
    this.hoveredMsgId = id;
    if (prev) {
      const old = this.findSlotByMsgId(prev);
      if (old) {
        this.paintHighlight(old);
      }
    }
    if (id) {
      const next = this.findSlotByMsgId(id);
      if (next) {
        this.paintHighlight(next);
      }
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
      this.nickPaintResources.clear();
      this.reinstallNickFont();
      if (this.ready) {
        this.applyFontStylesToSlots(true);
      }
    }
    this.refreshFontMetrics();
    this.repaintNickChrome();
    this.markLayoutFullPaint();
    this.layout();
  }

  /** Stock nicknames table: rewrite painted nick after usernameDisplayMode. */
  configureNicknames(rules: NicknameRule[]): void {
    if (nicknameRulesEqual(this.nicknameRules, rules)) {
      return;
    }
    this.nicknameRules = rules.slice();
    if (!this.ready) {
      return;
    }
    this.repaintNickChrome();
    this.markLayoutFullPaint();
    this.layout();
  }

  private paintedNick(login: string, displayName: string): string {
    return applyNickname(
      formatUsername({
        login,
        displayName,
        mode: this.usernameDisplayMode,
      }),
      this.nicknameRules,
    );
  }

  /** Display/login for UserCard and context (no nickname alias). */
  private contextNick(slot: Slot): string {
    if (!slot.useNickStyle) {
      return slot.nickRaw;
    }
    return formatUsername({
      login: slot.nickLogin,
      displayName: slot.nickDisplay,
      mode: this.usernameDisplayMode,
    });
  }

  private repaintNickChrome(): void {
    for (const slot of this.slots) {
      if (slot.useNickStyle) {
        slot.nickRaw = this.paintedNick(slot.nickLogin, slot.nickDisplay);
        slot.nickTint = resolveNickColor({ color: slot.nickColorRaw, userId: slot.nickUserId,
          colorize: this.colorizeNicknames, fallback: this.themeFills.nickFallback });
      }
      const view = this.viewPool.get(slot);
      if (!view) continue;
      view.nick.style.fontFamily = "ChatNickFont";
      view.nick.style.fontSize = this.fontSize;
      view.nick.tint = slot.nickTint;
    }
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
    this.markLayoutFullPaint();
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
    this.markLayoutFullPaint();
    this.layout();
  }

  /**
   * Rebuild CLEARCHAT/CLEARMSG/Whisper bodies for the current locale.
   * Reply headers refresh via paintClip → formatReplyHeader.
   */
  relocalizeSystemStrings(): void {
    if (!this.ready) {
      return;
    }
    const start = (this.head - this.occupied + this.poolSize) % this.poolSize;
    for (let i = 0; i < this.occupied; i += 1) {
      const slot = this.slots[(start + i) % this.poolSize];
      if (!slot.msgId) {
        continue;
      }
      if (slot.systemTextKind === "clearchat") {
        const fmt = clearchatFormatted(
          slot.clearLogin || undefined,
          slot.clearDurationSec,
          slot.clearStackCount > 0 ? slot.clearStackCount : undefined,
          slot.clearSourceLogin || undefined,
          slot.clearModeratorLogin || undefined,
        );
        slot.bodySource = fmt.text;
        slot.copyText = fmt.text;
        slot.mentionSpans = fmt.mentions;
        slot.bodyRaw = this.displayBody(slot.bodySource, slot.linkSpans);
        slot.leadLen = 0;
      } else if (slot.systemTextKind === "clearmsg") {
        const text = deletionNoticeText(
          slot.clearLogin || t("chat.reply.unknown"),
          slot.clearmsgBody,
          this.deletedMessageLengthLimit,
        );
        slot.bodySource = text;
        slot.copyText = text;
        slot.bodyRaw = this.displayBody(slot.bodySource, slot.linkSpans);
        slot.leadLen = 0;
      } else if (slot.systemTextKind === "usernotice") {
        const fmt = usernoticeFormatted({
          systemText: slot.usernoticeSystemText,
          login: slot.usernoticeLogin || undefined,
          msgId: slot.usernoticeMsgId || undefined,
          params: slot.usernoticeParams ?? undefined,
        });
        const oldLead = slot.leadLen;
        const inner = slot.usernoticeInnerBody;
        const sep = fmt.text.length > 0 && inner.length > 0 ? " " : "";
        const newLead = fmt.text.length + (inner.length > 0 ? sep.length : 0);
        const shift = newLead - oldLead;
        const innerMentions = slot.mentionSpans.filter((m) => m.start >= oldLead);
        slot.bodySource = `${fmt.text}${sep}${inner}`;
        if (inner.length === 0) {
          slot.copyText = fmt.text;
        }
        if (shift !== 0) {
          slot.spansRaw = shiftSpans(slot.spansRaw, shift);
          slot.linkSpans = shiftSpans(slot.linkSpans, shift);
        }
        if (slot.linkEnriched) {
          slot.hostSpans = [];
          this.releaseSlotClipCard(slot);
          slot.clipCard = null;
          slot.clipCardRows = 0;
          slot.linkEnriched = false;
        }
        slot.mentionSpans = [
          ...fmt.mentions,
          ...shiftSpans(innerMentions, shift),
        ];
        slot.bodyRaw = this.displayBody(slot.bodySource, slot.linkSpans);
        slot.leadLen = newLead;
      } else if (slot.systemTextKind === "notice") {
        const fmt = noticeFormatted({
          text: slot.noticeFallback,
          msgId: slot.noticeMsgId || undefined,
          timeoutRemainingSec: slot.noticeTimeoutSec,
        });
        slot.bodySource = fmt.text;
        slot.copyText = fmt.text;
        slot.mentionSpans = fmt.mentions;
        slot.bodyRaw = this.displayBody(slot.bodySource, slot.linkSpans);
        slot.leadLen = 0;
      } else if (slot.isWhisper) {
        const oldPrefixLen = Math.max(
          0,
          slot.bodySource.length - slot.copyText.length,
        );
        const whisperP = whisperPrefix();
        const actionP = slot.isAction ? "* " : "";
        const prefix = `${whisperP}${actionP}`;
        const shiftDelta = prefix.length - oldPrefixLen;
        if (shiftDelta !== 0) {
          slot.spansRaw = shiftSpans(slot.spansRaw, shiftDelta);
          slot.linkSpans = shiftSpans(slot.linkSpans, shiftDelta);
          slot.mentionSpans = shiftSpans(slot.mentionSpans, shiftDelta);
        }
        slot.bodySource = `${prefix}${slot.copyText}`;
        slot.bodyRaw = this.displayBody(slot.bodySource, slot.linkSpans);
        slot.leadLen = whisperP.length;
      }
    }
    this.markLayoutFullPaint();
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
      const view = this.viewPool.get(slot);
      if (slot.useNickStyle) {
        slot.nickTint = resolveNickColor({
          color: slot.nickColorRaw,
          userId: slot.nickUserId,
          colorize: this.colorizeNicknames,
          fallback: this.themeFills.nickFallback,
        });
      } else if (!slot.msgId) {
        slot.nickTint = this.themeFills.nickFallback;
      }
      if (!view) continue;
      view.time.style.fill = this.themeFills.timestamp;
      view.body.style.fill = this.themeFills.body;
      view.bodyCont.style.fill = this.themeFills.body;
      view.nick.style.fill = 0xffffff;
      view.nick.tint = slot.nickTint;
    }
    this.markLayoutFullPaint();
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
    if (!changed && this.atlasDesignSize > 0) return;
    const anchors = this.ready ? this.captureScrollAnchors() : undefined;
    this.chatFontFamily = family;
    this.chatFontSize = size;
    this.chatFontWeight = weight;
    this.nickPaintResources.clear();
    this.reinstallChatFont();
    this.refreshFontMetrics();
    if (!this.ready) {
      return;
    }
    this.applyFontStylesToSlots(true);
    this.markLayoutFullPaint();
    this.layout(anchors);
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
    showReplyButton = true,
    linksDoubleClickOnly = false,
    hideRestrictedUsers = false,
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
    const anchors = this.ready ? this.captureScrollAnchors() : undefined;
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
    this.hideRestrictedUsers = hideRestrictedUsers;
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
    const occStart = (this.head - this.occupied + this.poolSize) % this.poolSize;
    for (let i = 0; i < this.occupied; i += 1) {
      const slot = this.slots[(occStart + i) % this.poolSize];
      if (slot.msgId && slot.timestampMs) {
        slot.timeText = formatTime(slot.timestampMs, this.timestampFormat);
      }
      const view = this.viewPool.get(slot);
      if (!view) continue;
      view.time.text = slot.timeText;
      for (const spr of view.badges) {
        spr.y = this.lineMediaY(0, this.badgeSize);
        if (spr.visible && isRenderableTexture(spr.texture)) {
          applySpriteTexture(spr, spr.texture, this.badgeSize, this.badgeSize);
        } else if (spr.visible) {
          spr.visible = false;
          spr.texture = Texture.EMPTY;
        }
      }
      for (let e = 0; e < view.emotes.length; e += 1) {
        const spr = view.emotes[e];
        const span = slot.spansRaw[e];
        if (spr.visible && isRenderableTexture(spr.texture) && span) {
          const paint = this.emotePaintSize(span, this.slotBodyFontSize(slot));
          applySpriteTexture(spr, spr.texture, paint.w, paint.h);
        } else if (spr.visible) {
          spr.visible = false;
          spr.texture = Texture.EMPTY;
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
    this.markLayoutFullPaint();
    this.layout(anchors);
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
  }

  /**
   * Badge/emote Y in a text row (Chatterino alignRectBottomCenter).
   * Vertical center looked slightly above BitmapText glyphs.
   */
  private lineMediaY(contentY: number, mediaH: number, line = 0): number {
    return (
      contentY +
      line * this.lineHeight +
      Math.max(0, this.lineHeight - mediaH)
    );
  }

  private wrapLineRowHeight(slot: Slot, line: number): number {
    return slot.wrapLineHeights[line] ?? this.lineHeight;
  }

  private wrapLineY(contentY: number, line: number, slot: Slot): number {
    if (slot.wrapLineHeights.length === 0) {
      return contentY + line * this.lineHeight;
    }
    return contentY + wrapLineOffsetY(slot.wrapLineHeights, line);
  }

  private lineMediaYForWrapLine(
    contentY: number,
    mediaH: number,
    line: number,
    slot: Slot,
  ): number {
    const rowH = this.wrapLineRowHeight(slot, line);
    return this.wrapLineY(contentY, line, slot) + Math.max(0, rowH - mediaH);
  }

  private slotBodyPixelHeight(slot: MessageRow): number {
    if (slot.wrapLineHeights.length > 0) {
      return slot.wrapLineHeights.reduce((a, b) => a + b, 0);
    }
    const bodyLines = Math.max(
      1,
      slot.wrapLines.length > 0
        ? slot.wrapLines.length
        : slot.lineCount - slot.replyRows - slot.clipCardRows,
    );
    let bodyPix = bodyLines * this.lineHeight;
    if (this.enableEmoteImages) {
      for (const span of slot.spansRaw) {
        if (span.provider !== "twitch-gif" || span.zeroWidth === true) {
          continue;
        }
        const { h } = this.emotePaintSize(span);
        if (
          span.start === 0 &&
          span.end >= Math.max(1, slot.bodyRaw.length - 1)
        ) {
          bodyPix = Math.max(bodyPix, h + this.lineHeight);
        } else {
          bodyPix += Math.max(0, h - this.lineHeight);
        }
      }
    }
    return bodyPix;
  }

  private slotPixelHeight(slot: MessageRow): number {
    return (
      slot.replyRows * this.lineHeight +
      this.slotBodyPixelHeight(slot) +
      slot.clipCardRows * this.lineHeight
    );
  }

  /** Scroll row budget before paintClip; tall GIF placeholders reserve extra rows. */
  private estimateSlotLineCount(slot: Slot): number {
    const bodyPix = this.slotBodyPixelHeight(slot);
    return (
      slot.replyRows +
      slot.clipCardRows +
      Math.max(1, Math.ceil(bodyPix / this.lineHeight))
    );
  }

  /** Twitch chat GIFs are always fetched as animation-capable assets. */
  private wantAnimateSpan(span: EmoteSpan): boolean {
    return span.provider === "twitch-gif" ? true : this.animateEmotes;
  }

  /** Prefer LRU cache over stale sprite.texture (eviction / slot reuse). */
  private resolveEmotePaintTexture(
    slot: Slot,
    index: number,
    spr: Sprite,
  ): Texture {
    const view = this.viewPool.get(slot);
    if (!view) { return Texture.EMPTY; }
    const key = view.emoteKeys[index];
    if (key) {
      if (this.textures.isAnimated(key) && this.animateEmotes) {
        const frame = this.textures.frameAt(key, this.emoteTicker.position());
        if (isRenderableTexture(frame)) {
          return frame;
        }
      }
      const cached = this.textures.get(key);
      if (isRenderableTexture(cached)) {
        return cached;
      }
    }
    const tex = spr.texture;
    return isRenderableTexture(tex) ? tex : Texture.EMPTY;
  }

  private scheduleEmoteLoad(
    slot: Slot,
    index: number,
    span: EmoteSpan,
    msgId: string,
  ): void {
    const view = this.viewPool.get(slot);
    if (!view) { return; }
    const token = this.viewPool.tokenOf(slot);
    const sprite = view.emotes[index];
    if (!sprite) return;
    if (!this.enableEmoteImages || span.provider === "cheer-mask") {
      return;
    }
    const key =
      span.provider === "cheer"
        ? `cheer:${span.url}`
        : `${span.provider}:${span.emoteId}`;
    if (view.emoteKeys[index] !== key) {
      view.emoteKeys[index] = key;
      this.textures.acquire(key);
    }
    const fullUrl = this.emoteLoadUrl(span);
    const wantAnimate = this.wantAnimateSpan(span);
    const fallbackUrl = span.provider === "twitch-gif" ? resolveGifFallbackUrl(fullUrl) : null;
    const onLoaded = (tex: Texture | null): void => {
      if (
        !tex ||
        !this.viewPool.owns(slot, view, token) ||
        slot.msgId !== msgId ||
        !this.enableEmoteImages ||
        view.emoteKeys[index] !== key ||
        view.emotes[index] !== sprite || slot.spansRaw[index] !== span
      ) {
        return;
      }
      const paint = this.emotePaintSize(span, this.slotBodyFontSize(slot));
      applySpriteTexture(view.emotes[index], tex, paint.w, paint.h);
      this.repaintSlotMedia(slot);
    };
    void this.textures.load(key, fullUrl, wantAnimate, fallbackUrl).then(onLoaded);
  }

  private placeEmoteSprite(
    spr: Sprite,
    tex: Texture,
    x: number,
    y: number,
    w: number,
    h: number,
  ): void {
    spr.x = x;
    spr.y = y;
    if (!isRenderableTexture(tex)) {
      spr.visible = false;
      spr.texture = Texture.EMPTY;
      return;
    }
    spr.visible = true;
    applySpriteTexture(spr, tex, w, h);
  }

  private paintEmoteSpriteAt(
    slot: Slot,
    index: number,
    spr: Sprite,
    span: EmoteSpan,
    x: number,
    y: number,
    paintW: number,
    paintH: number,
  ): void {
    let tex = this.resolveEmotePaintTexture(slot, index, spr);
    // A texture may have been purged after its Pixi source was destroyed.
    // Keep the key (and its ref count) but let TextureLru fetch a fresh asset.
    if (tex === Texture.EMPTY && slot.msgId) {
      this.scheduleEmoteLoad(slot, index, span, slot.msgId);
      tex = this.resolveEmotePaintTexture(slot, index, spr);
    }
    this.placeEmoteSprite(spr, tex, x, y, paintW, paintH);
  }

  /**
   * Width of painted BitmapText (measurement units × layout.scale).
   * Canvas measureTextWidth drifts from ChatFont/ChatNickFont advances.
   */
  private measureBitmapTextWidth(
    fontFamily: string,
    text: string,
    fontSize: number = this.fontSize,
  ): number {
    if (!text) {
      return 0;
    }
    try {
      const key = `${fontFamily}:${fontSize}`;
      let style = this.measureStyles.get(key);
      if (!style) {
        style = new TextStyle({ fontFamily, fontSize, fill: "#ffffff" });
        this.measureStyles.set(key, style);
        if (this.measureStyles.size > 16) {
          this.measureStyles.delete(this.measureStyles.keys().next().value!);
        }
      }
      const m = BitmapFontManager.measureText(text, style, false);
      const w = m.width * m.scale;
      if (w > 0) {
        return w;
      }
    } catch {
      // Font not installed yet.
    }
    const weight =
      fontFamily === "ChatNickFont"
        ? this.nickBoldScale
        : this.chatFontWeight;
    return measureTextWidth(
      this.chatFontFamily,
      qtWeightToCss(weight),
      fontSize,
      text,
    );
  }

  /** Effective size for CLEARCHAT / USERNOTICE / NOTICE pills (PRIVMSG unchanged). */
  private systemCloudFontSize(): number {
    return Math.max(1, this.fontSize - SYSTEM_CLOUD_FONT_DELTA);
  }

  private systemCloudLineHeight(fontSize: number): number {
    return measureFontMetrics(
      this.chatFontFamily,
      qtWeightToCss(this.chatFontWeight),
      fontSize,
    ).lineHeight;
  }

  /** Ellipsis nick to fit maxPx in ChatNickFont (optional trailing ':'). */
  private clipNickToWidth(
    nick: string,
    maxPx: number,
    withColon: boolean,
  ): string {
    const suffix = withColon ? ":" : "";
    const limit = Math.max(8, maxPx);
    if (
      this.measureBitmapTextWidth("ChatNickFont", `${nick}${suffix}`) <= limit
    ) {
      return `${nick}${suffix}`;
    }
    let lo = 0;
    let hi = nick.length;
    let best = withColon ? ":" : "..";
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      const candidate =
        mid <= 0
          ? withColon
            ? ":"
            : ".."
          : `${clipNick(nick, Math.max(2, mid))}${suffix}`;
      if (this.measureBitmapTextWidth("ChatNickFont", candidate) <= limit) {
        best = candidate;
        lo = mid + 1;
      } else {
        hi = mid - 1;
      }
    }
    return best;
  }

  private applyFontStylesToSlots(forceDirty: boolean): void {
    for (const view of this.viewPool.views) {
      view.time.style.fontSize = this.fontSize;
      view.time.style.lineHeight = this.lineHeight;
      view.nick.style.fontFamily = "ChatNickFont";
      view.nick.style.fontSize = this.fontSize;
      view.nick.style.lineHeight = this.lineHeight;
      view.body.style.fontSize = this.fontSize;
      view.body.style.lineHeight = this.lineHeight;
      view.bodyCont.style.fontSize = this.fontSize;
      view.bodyCont.style.lineHeight = this.lineHeight;
      view.replyHeader.style.fontSize = Math.max(
        8,
        Math.round(this.fontSize * 0.85),
      );
      view.replyHeader.style.fill = this.themeFills.timestamp;
      for (const mt of view.mentionTexts) {
        mt.style.fontSize = this.fontSize;
        mt.style.lineHeight = this.lineHeight;
      }
      for (const ht of view.hostTexts) {
        ht.style.fontSize = this.fontSize;
        ht.style.lineHeight = this.lineHeight;
        ht.style.fill = this.themeFills.timestamp;
      }
      for (const mt of view.modBtns) {
        mt.style.fontSize = this.fontSize;
        mt.style.lineHeight = this.lineHeight;
      }
      view.bitsLabel.style.fontSize = this.fontSize;
      view.bitsLabel.style.lineHeight = this.lineHeight;
      if (forceDirty) {
        dirtyBitmapText(view.time);
        dirtyBitmapText(view.nick);
        dirtyBitmapText(view.body);
        dirtyBitmapText(view.bodyCont);
        dirtyBitmapText(view.replyHeader);
        for (const mt of view.mentionTexts) {
          dirtyBitmapText(mt);
        }
        for (const ht of view.hostTexts) {
          dirtyBitmapText(ht);
        }
        for (const mt of view.modBtns) {
          dirtyBitmapText(mt);
        }
        dirtyBitmapText(view.bitsLabel);
        if (view.clipUi) {
          dirtyBitmapText(view.clipUi.duration);
          dirtyBitmapText(view.clipUi.title);
          dirtyBitmapText(view.clipUi.game);
          dirtyBitmapText(view.clipUi.foot);
        }
        for (const ct of view.caughtTexts) {
          dirtyBitmapText(ct);
        }
      }
    }
  }

  private reinstallChatFont(): void {
    this.measureStyles.clear();
    const atlasSize = atlasFontSize(this.chatFontSize);
    replaceBitmapFont("ChatFont", {
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
    this.measureStyles.clear();
    const atlasSize = atlasFontSize(this.chatFontSize);
    replaceBitmapFont("ChatNickFont", {
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
    if (this.ready) {
      resetBitmapTextGpuTree(this.app.stage, this.app.renderer.uid);
    }
  }

  scrollSnapshot(): ScrollSnapshot {
    return this.scroll.snapshot();
  }

  performanceTrace?: ChatPerformance;

  workspaceScroll(): WorkspaceScroll {
    return {
      atBottom: this.scroll.atBottom,
      anchor: this.scroll.captureAnchor(this.laidSlots()),
      rowsFromBottom: Math.max(0, this.scroll.bottom() - this.scroll.desired),
    };
  }

  restoreWorkspaceScroll(saved: WorkspaceScroll, fallback = false): boolean {
    if (saved.atBottom) { this.goToBottom(); return true; }
    const row = this.scroll.resolveAnchor(this.laidSlots(), saved.anchor);
    if (row === undefined && !fallback) return false;
    if (this.scroll.contentRows === 0) return false;
    // Cancel snapshot's pending bottom pin before restoring reading position.
    this.layoutSettlePinned = false;
    this.setDesired(row ?? Math.max(0, this.scroll.bottom() - saved.rowsFromBottom), false);
    return true;
  }

  goToBottom(): void {
    this.pauseFollowIntent = false;
    this.pendingBelow = 0;
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
    const start = (this.head - this.occupied + this.poolSize) % this.poolSize;
    let target: Slot | undefined;
    let prevSlot: Slot | undefined;
    for (let i = 0; i < this.occupied; i += 1) {
      const slot = this.slots[(start + i) % this.poolSize];
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
    this.scroll.setDesired(this.slotScrollRow(target), false);
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
    const start = (this.head - this.occupied + this.poolSize) % this.poolSize;
    for (let i = 0; i < this.occupied; i += 1) {
      const slot = this.slots[(start + i) % this.poolSize];
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

  private createRowView(): MessageRowView {
    const view = createMessageRowView({
      fontSize: this.fontSize, lineHeight: this.lineHeight,
      timestampFill: this.themeFills.timestamp, bodyFill: this.themeFills.body,
    });
    const { root } = view;
    root.on("pointerdown", (ev: FederatedPointerEvent) => {
      const owner = this.viewPool.ownerOf(view);
      view.pressToken = owner ? this.viewPool.tokenOf(owner) : undefined;
      view.pressPointerId = ev.pointerId;
    });
    const consumePress = (ev: FederatedPointerEvent): Slot | undefined => {
      const owner = this.viewPool.ownerOf(view);
      if (!owner || !view.painted || view.pressPointerId !== ev.pointerId ||
          view.pressToken !== this.viewPool.tokenOf(owner)) return undefined;
      view.pressToken = undefined;
      return owner;
    };
    root.on("pointertap", (ev: FederatedPointerEvent) => {
      if (ev.button !== 0) return;
      const owner = consumePress(ev);
      if (owner) this.onSlotTap(owner, ev);
    });
    root.on("rightclick", (ev: FederatedPointerEvent) => {
      const owner = consumePress(ev);
      if (owner) this.onSlotContext(owner, ev);
    });
    const cancelPress = () => { view.pressToken = undefined; view.pressPointerId = undefined; };
    root.on("pointerupoutside", cancelPress);
    root.on("pointercancel", cancelPress);
    root.on("rightupoutside", cancelPress);
    root.on("pointermove", (ev: FederatedPointerEvent) => {
      const owner = this.viewPool.ownerOf(view);
      if (owner && view.painted) this.onSlotMove(owner, ev);
    });
    root.on("pointerover", (ev: FederatedPointerEvent) => {
      const owner = this.viewPool.ownerOf(view);
      if (!owner || !view.painted || !owner.msgId) return;
      if (owner.systemCloudBounds) {
        const local = ev.getLocalPosition(root);
        if (this.pointInSystemCloud(owner, local.x, local.y)) this.setHoveredMsgId(owner.msgId);
      } else if (!owner.system && owner.login && !(owner.disabled && this.hideModerated)) {
        this.setHoveredMsgId(owner.msgId);
      }
    });
    root.on("pointerout", () => {
      const owner = this.viewPool.ownerOf(view);
      if (!owner || this.hoveredMsgId !== owner.msgId || this.hoverGuard?.()) return;
      this.clearHover();
    });
    this.app.stage.addChild(root);
    return view;
  }

  private bindRowView(slot: Slot, view: MessageRowView): void {
    view.painted = false;
    view.root.visible = false;
    view.root.renderable = false;
    view.root.y = slot.y;
    view.time.text = slot.timeText;
    view.time.style.fill = this.themeFills.timestamp;
    view.nick.tint = slot.nickTint;
    view.nickPaint = slot.nickPaint;
    this.resizeMediaSprites(slot, view.emotes,
      this.enableEmoteImages ? Math.min(slot.spansRaw.length, EMOTE_SLOTS_PER_ROW) : 0);
    view.emoteKeys.length = view.emotes.length;
    view.emoteKeys.fill("");
    if (this.enableEmoteImages) {
      for (let i = 0; i < view.emotes.length; i += 1) {
        const span = slot.spansRaw[i];
        if (span && span.provider !== "cheer-mask") this.scheduleEmoteLoad(slot, i, span, slot.msgId);
      }
    }
    if (!this.isSystemCloud(slot)) this.loadBadgeSprites(slot);
    this.scheduleViewportPaint();
  }

  private releaseRowView(slot: Slot, view: MessageRowView): void {
    this.mediaRepaintSlots.delete(slot);
    if (this.hoveredMsgId === slot.msgId) this.hoveredMsgId = "";
    view.root.visible = false;
    view.root.renderable = false;
    view.root.cursor = "default";
    view.painted = false;
    view.pressToken = undefined;
    view.pressPointerId = undefined;
    detachSpriteTexture(view.nickPaintSpr);
    view.nickPaintKey = "";
    view.nickPaint = null;
    for (const sprites of [view.emotes, view.badges, view.modIcons]) {
      for (const sprite of sprites) { detachSpriteTexture(sprite); sprite.destroy(); }
      sprites.length = 0;
    }
    if (view.clipUi) {
      const clip = view.clipUi;
      view.clipUi = null;
      releaseClipThumb(clip, this.textures);
      clip.root.destroy({ children: true, context: true, style: true });
    }
    for (const keys of [view.emoteKeys, view.badgeKeys]) {
      for (const key of keys) if (key) this.textures.release(key);
      keys.length = 0;
    }
    for (const texts of [view.mentionTexts, view.hostTexts, view.caughtTexts, view.modBtns]) {
      this.trimOverlayTexts(texts, 0);
    }
    if (view.highlightPainted) { view.highlight.clear(); view.highlightPainted = false; }
    if (view.linksPainted) { view.mentions.clear(); view.linksPainted = false; }
    if (view.cloudPaintBounds) { view.systemCloud.clear(); view.cloudPaintBounds = null; }
    if (view.disabledPaint) { view.disabledGfx.clear(); view.disabledPaint = null; }
    view.modBtnHits.length = 0;
    view.automodBtnHits.length = 0;
    view.replyHeader.visible = false;
    view.bitsLabel.visible = false;
  }

  async init(): Promise<void> {
    if (this.ready) {
      return;
    }
    this.reinstallChatFont();
    this.refreshFontMetrics();
    const stage = this.app.stage;
    stage.eventMode = "static";
    for (let i = 0; i < this.poolSize; i += 1) this.slots.push(createMessageRow());
    this.ready = true;
    this.resizeDebounce = trailingDebounce(() => {
      this.markLayoutFullPaint();
      this.layout();
    }, 100);
    this.app.renderer.on("resize", this.onRendererResize);
    if (!this.renderPrerenderHook) {
      this.renderPrerenderHook = (): void => {
        this.sanitizeBeforeRender();
      };
      this.app.renderer.runners.prerender.add(this.renderPrerenderHook);
      this.app.renderer.runners.renderStart.add(this.renderPrerenderHook);
    }
    this.patchRendererSanitize();
  }

  /** Последняя линия обороны: sanitize внутри render до collectRenderables. */
  private patchRendererSanitize(): void {
    if (this.rendererSanitizePatched) {
      return;
    }
    this.rendererSanitizePatched = true;
    const renderer = this.app.renderer;
    const origRender = renderer.render.bind(renderer);
    renderer.render = (options) => {
      this.sanitizeBeforeRender();
      return origRender(options);
    };
  }

  private onTexturesInvalidated(
    _id: string,
    doomed: readonly Texture[],
  ): void {
    const doomedSet = new Set(doomed);
    for (const slot of this.slots) {
      const view = this.viewPool.get(slot);
      if (!view) continue;
      for (const spr of view.emotes) {
        if (doomedSet.has(spr.texture)) {
          detachSpriteTexture(spr);
        }
      }
      for (const spr of view.badges) {
        if (doomedSet.has(spr.texture)) {
          detachSpriteTexture(spr);
        }
      }
      for (const spr of view.modIcons) {
        if (doomedSet.has(spr.texture)) {
          detachSpriteTexture(spr);
        }
      }
      if (doomedSet.has(view.nickPaintSpr.texture)) {
        detachSpriteTexture(view.nickPaintSpr);
        view.nickPaintKey = "";
        if (view.nick.text) {
          view.nick.visible = true;
        }
      }
      if (view.clipUi && doomedSet.has(view.clipUi.thumb.texture)) {
        detachSpriteTexture(view.clipUi.thumb);
      }
    }
  }

  /** Culled rows are checked again before they reenter the rendered set. */
  private sanitizeBeforeRender(): void {
    if (!this.ready) {
      return;
    }
    const tickerTime = this.app.ticker.lastTime;
    if (tickerTime === this.lastSanitizeTickerTime) {
      return;
    }
    this.lastSanitizeTickerTime = tickerTime;
    for (const slot of this.slots) {
      const view = this.viewPool.get(slot);
      if (!view) continue;
      if (!slot.msgId || !slot.visible || !view.root.renderable) {
        continue;
      }
      sanitizeStageSprites(view.root);
      if (
        view.nickPaintSpr.visible &&
        !isRenderableTexture(view.nickPaintSpr.texture)
      ) {
        view.nickPaintKey = "";
        if (view.nick.text) {
          view.nick.visible = true;
        }
      }
    }
  }

  reset(): void {
    this.cancelLayoutSettle();
    this.liveMsgIds.clear();
    this.deferredClearMsg.clear();
    this.boundChannel = "";
    this.channelLive = false;
    this.resetSlots();
    this.markLayoutFullPaint();
    this.layout(undefined, undefined, false);
  }

  setBoundChannel(channel: string): void {
    this.boundChannel = channel.trim().replace(/^#/, "").toLowerCase();
  }

  boundChannelLogin(): string {
    return this.boundChannel;
  }

  /** Bound live id set to ~2× pool so long sessions cannot grow without bound. */
  private rememberLiveMsgId(msgId: string): void {
    this.liveMsgIds.add(msgId);
    const cap = Math.max(256, this.poolSize * 2);
    if (this.liveMsgIds.size <= cap) {
      return;
    }
    this.liveMsgIds.clear();
    const start = (this.head - this.occupied + this.poolSize) % this.poolSize;
    for (let i = 0; i < this.occupied; i += 1) {
      const id = this.slots[(start + i) % this.poolSize]?.msgId;
      if (id) {
        this.liveMsgIds.add(id);
      }
    }
    // Current write may not be in occupied yet — keep the id we just recorded.
    this.liveMsgIds.add(msgId);
  }

  setChannelLive(live: boolean): void {
    if (this.channelLive === live) {
      return;
    }
    const prevTs = this.timestampsVisible();
    this.channelLive = live;
    if (!this.ready) {
      return;
    }
    if (this.timestampsVisible() !== prevTs) {
      this.invalidateAllWraps();
    }
    this.layout();
  }

  private timestampsVisible(): boolean {
    return (
      this.showTimestamps && !(this.hideTimestampsWhenLive && this.channelLive)
    );
  }

  destroy(): void {
    this.ready = false;
    this.measureStyles.clear();
    this.textures.setInvalidateListener(null);
    if (this.renderPrerenderHook) {
      this.app.renderer.runners.prerender.remove(this.renderPrerenderHook);
      this.app.renderer.runners.renderStart.remove(this.renderPrerenderHook);
      this.renderPrerenderHook = null;
    }
    this.cancelLayoutSettle();
    this.resizeDebounce?.cancel();
    this.resizeDebounce = null;
    this.app.renderer.off("resize", this.onRendererResize);
    window.clearTimeout(this.hoverPauseTimer);
    this.hoverPauseTimer = 0;
    this.pauseMouse = false;
    this.nickPaintResources.clear();
    this.emoteTicker.destroy();
    if (this.lastReadFadeRaf !== 0) {
      cancelAnimationFrame(this.lastReadFadeRaf);
      this.lastReadFadeRaf = 0;
    }
    if (this.mediaRepaintRaf !== 0) {
      cancelAnimationFrame(this.mediaRepaintRaf);
      this.mediaRepaintRaf = 0;
    }
    if (this.scrollRaf !== 0) {
      cancelAnimationFrame(this.scrollRaf);
      this.scrollRaf = 0;
    }
    if (this.viewportPaintRaf !== 0) {
      cancelAnimationFrame(this.viewportPaintRaf);
      this.viewportPaintRaf = 0;
    }
    this.mediaRepaintSlots.clear();
    this.clearSlots();
    this.viewPool.destroy();
  }

  applySnapshot(events: ChatEvent[]): void {
    const follow = this.scroll.atBottom;
    const anchors = follow ? undefined : this.captureScrollAnchors();
    this.beginLayoutSettle(follow);
    this.clearSlots();
    const start = Math.max(0, events.length - this.poolSize);
    this.loadingSnapshot = true;
    try {
      for (const event of events.slice(start)) {
        this.pushOne(event);
      }
    } finally {
      this.loadingSnapshot = false;
    }
    // Snapshot + deferred paints must snap; smooth follow would thrash the viewport.
    this.layout(follow ? undefined : anchors, undefined, false);
  }

  pushMany(events: ChatEvent[]): void {
    const anchors = this.captureScrollAnchors();
    const paintSlots = new Set<Slot>();
    let needFull = false;
    for (const event of events) {
      const result = this.pushOne(event);
      if (result.needFullLayout) {
        needFull = true;
      }
      if (result.slot) {
        paintSlots.add(result.slot);
      }
    }
    if (this.layoutSettling) {
      this.noteLayoutSettleActivity();
    }
    if (needFull) {
      // Visibility / stacking changed — reposition all, paint only new/updated rows.
      if (paintSlots.size > 0) {
        this.layout(anchors, paintSlots);
      } else {
        this.layout(anchors);
      }
      this.repaintHighlights();
      return;
    }
    if (paintSlots.size === 0) {
      return;
    }
    this.layout(anchors, paintSlots);
  }

  private clearSlots(): void {
    this.occupied = 0;
    this.head = 0;
    this.lastReadMsgId = "";
    this.lastReadFadeMsgId = "";
    this.lastReadFadeStart = 0;
    this.hoveredMsgId = "";
    this.pendingBelow = 0;
    if (this.lastReadFadeRaf !== 0) {
      cancelAnimationFrame(this.lastReadFadeRaf);
      this.lastReadFadeRaf = 0;
    }
    if (this.mediaRepaintRaf !== 0) {
      cancelAnimationFrame(this.mediaRepaintRaf);
      this.mediaRepaintRaf = 0;
    }
    if (this.viewportPaintRaf !== 0) {
      cancelAnimationFrame(this.viewportPaintRaf);
      this.viewportPaintRaf = 0;
    }
    this.mediaRepaintSlots.clear();
    for (const slot of this.slots) {
      this.clearSlot(slot);
    }
    this.bumpHighlightMarks();
    this.wantedViews.length = 0;
    this.viewPool.clear();
    for (const view of this.viewPool.views) {
      view.time.text = "";
      view.nick.text = "";
      view.body.text = "";
      view.bodyCont.text = "";
      view.replyHeader.text = "";
      view.bitsLabel.text = "";
    }
  }

  private resetSlots(): void {
    this.clearSlots();
    this.scroll.reset();
  }

  private pushOne(event: ChatEvent): { slot?: Slot; needFullLayout: boolean } {
    if (event.kind === "clearmsg") {
      return this.applyClearMsg(event);
    }
    if (event.kind === "clearchat") {
      const existing = this.findSlotByMsgId(event.id);
      if (!existing) {
        if (event.targetLogin) {
          this.disableByLogin(event.targetLogin);
        } else {
          this.disableAllUserMessages();
        }
      }
      if (this.hideModerationActions) {
        return { needFullLayout: true };
      }
      if (existing) {
        this.write(existing, event);
        this.bumpHighlightMarks();
        const deferred = this.applyDeferredClearFor(existing.msgId);
        if (deferred) {
          return deferred;
        }
        return { slot: existing, needFullLayout: true };
      }
      // Fall through: timeout/ban notice is a new ring row (stock Channel).
    } else if (event.kind === "userstate") {
      this.onViewerRoleChange?.();
      return { needFullLayout: false };
    } else if (event.kind === "roomstate") {
      // Legacy raw roomstate in old snapshots — skip; live path side-effects only.
      return { needFullLayout: false };
    } else if (event.kind === "automodHeld") {
      const existing = this.findSlotByMsgId(event.id);
      if (existing) {
        this.write(existing, event);
        this.bumpHighlightMarks();
        const deferred = this.applyDeferredClearFor(existing.msgId);
        if (deferred) {
          return deferred;
        }
        return { slot: existing, needFullLayout: true };
      }
    } else if (event.kind === "automodStatus") {
      const existing = this.findSlotByMsgId(event.targetId);
      if (existing && existing.automodMessageId) {
        existing.automodStatus = event.status;
        // Rebuild drawn body via a synthetic held update is handled by Rust
        // Replaced AutomodHeld; status-only events update chrome in place.
        this.paintClip(existing);
        this.bumpHighlightMarks();
        return { slot: existing, needFullLayout: true };
      }
      return { needFullLayout: false };
    } else if (
      event.kind === "notice" &&
      event.msgId === "suspicious_user_update" &&
      this.hideModerationActions
    ) {
      return { needFullLayout: false };
    }
    const slot = this.slots[this.head];
    this.write(slot, event);
    this.head = (this.head + 1) % this.poolSize;
    if (this.occupied < this.poolSize) {
      this.occupied += 1;
    }
    if (!this.loadingSnapshot && !this.scroll.atBottom) {
      this.pendingBelow += 1;
    }
    this.bumpHighlightMarks();
    const deferred = this.applyDeferredClearFor(slot.msgId);
    if (deferred) {
      return deferred;
    }
    return {
      slot,
      needFullLayout: event.kind === "clearchat",
    };
  }

  private queueDeferredClearMsg(
    event: Extract<ChatEvent, { kind: "clearmsg" }>,
  ): void {
    const id = event.targetId?.trim();
    if (!id) {
      return;
    }
    while (this.deferredClearMsg.size >= MessageRing.DEFERRED_CLEAR_CAP) {
      const oldest = this.deferredClearMsg.keys().next().value;
      if (oldest === undefined) {
        break;
      }
      this.deferredClearMsg.delete(oldest);
    }
    this.deferredClearMsg.set(id, event);
  }

  private applyDeferredClearFor(
    msgId: string,
  ): { slot?: Slot; needFullLayout: boolean } | null {
    if (!msgId) {
      return null;
    }
    const event = this.deferredClearMsg.get(msgId);
    if (!event) {
      return null;
    }
    this.deferredClearMsg.delete(msgId);
    return this.applyClearMsg(event);
  }

  private applyClearMsg(
    event: Extract<ChatEvent, { kind: "clearmsg" }>,
  ): { slot?: Slot; needFullLayout: boolean } {
    const target = this.findSlotByMsgId(event.targetId);
    if (!target) {
      this.queueDeferredClearMsg(event);
      return { needFullLayout: false };
    }
    this.disableById(event.targetId);
    if (this.hideDeletionActions || this.hideModerationActions) {
      return { needFullLayout: true };
    }
    const login = target.nickLogin || target.login || "";
    const deletedBody = target.copyText;
    const notice: ChatEvent = {
      kind: "notice",
      id: `${event.id}:del`,
      timestampMs: event.timestampMs,
      text: deletionNoticeText(
        login || t("chat.reply.unknown"),
        deletedBody,
        this.deletedMessageLengthLimit,
      ),
    };
    const slot = this.slots[this.head];
    this.write(slot, notice);
    slot.systemTextKind = "clearmsg";
    slot.clearLogin = login;
    slot.clearmsgBody = deletedBody;
    slot.clearDurationSec = undefined;
    slot.clearStackCount = 0;
    slot.clearSourceLogin = "";
    slot.clearModeratorLogin = "";
    this.head = (this.head + 1) % this.poolSize;
    if (this.occupied < this.poolSize) {
      this.occupied += 1;
    }
    this.bumpHighlightMarks();
    return { slot, needFullLayout: true };
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
    this.viewPool.release(slot);
    this.mediaRepaintSlots.delete(slot);
    resetMessageRow(slot);
  }

  private write(slot: Slot, event: ChatEvent): void {
    this.viewPool.release(slot);
    this.mediaRepaintSlots.delete(slot);
    slot.visible = true;
    slot.disabled =
      (event.kind === "privmsg" && !!event.disabled) ||
      (event.kind === "usernotice" &&
        event.privmsg?.kind === "privmsg" &&
        !!event.privmsg.disabled);
    slot.expanded = false;
    slot.collapsed = false;
    // PRIVMSG only — USERNOTICE/NOTICE/CLEARCHAT = System в эталоне
    slot.system =
      event.kind !== "privmsg" &&
      event.kind !== "automodHeld" &&
      event.kind !== "lowTrustMessage";
    slot.collapsible = event.kind === "privmsg" || event.kind === "lowTrustMessage";
    if (event.kind === "lowTrustHeader" || event.kind === "lowTrustMessage") {
      slot.lowTrustStatus = event.status;
    } else {
      slot.lowTrustStatus = "";
    }
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
        this.rememberLiveMsgId(slot.msgId);
      }
    }
    const drawn = this.line(event);
    slot.timeText = drawn.time;
    slot.nickRaw = drawn.nick;
    slot.nickTint = drawn.nickColor;
    if (event.kind === "privmsg") {
      slot.useNickStyle = true;
      slot.nickUserId = event.userId;
      slot.nickColorRaw = event.color;
      slot.nickLogin = event.login;
      slot.nickDisplay = event.displayName || event.login;
      slot.nickPaint = event.paint ?? null;
      const cacheColor = event.paint
        ? paintRepresentativeRgb(event.paint)
        : drawn.nickColor;
      this.nickColorCache.set(event.login, cacheColor);
      if (!event.paint) {
        slot.nickTint = drawn.nickColor;
      }
    } else if (event.kind === "automodHeld") {
      slot.useNickStyle = true;
      slot.nickUserId = event.authorUserId;
      slot.nickColorRaw = "";
      slot.nickLogin = event.authorLogin;
      slot.nickDisplay = event.authorDisplayName || event.authorLogin;
      slot.nickPaint = null;
      slot.login = event.authorLogin.toLowerCase();
    } else if (event.kind === "lowTrustMessage") {
      slot.useNickStyle = true;
      slot.nickUserId = event.userId;
      slot.nickColorRaw = "";
      slot.nickLogin = event.login;
      slot.nickDisplay = event.displayName || event.login;
      slot.nickPaint = null;
      slot.login = event.login.toLowerCase();
    } else {
      slot.useNickStyle = false;
      slot.nickUserId = "";
      slot.nickColorRaw = "";
      slot.nickLogin = "";
      slot.nickDisplay = "";
      slot.nickPaint = null;
    }
    slot.bodySource = drawn.body;
    slot.copyText = drawn.copyText;
    slot.linkSpans = drawn.links;
    slot.hostSpans = [];
    slot.clipCard = null;
    slot.clipCardRows = 0;
    slot.linkEnriched = false;
    slot.bodyRaw = this.displayBody(slot.bodySource, slot.linkSpans);
    // Recycled slots keep stale wrapLines; cull must see them as dirty.
    slot.wrapLines = [{ start: 0, end: 0 }];
    slot.wrapLineHeights = [];
    this.invalidateSlotWrap(slot);
    slot.leadLen = drawn.leadLen;
    if (event.kind === "privmsg") {
      slot.replyToId = event.replyToId ?? "";
      slot.replyToLogin = event.replyToLogin ?? "";
      slot.replyToText = event.replyToText ?? "";
      slot.isAction = event.action === true;
      slot.isWhisper = event.whisper === true;
    } else if (
      event.kind === "usernotice" &&
      event.privmsg &&
      event.privmsg.kind === "privmsg"
    ) {
      slot.replyToId = event.privmsg.replyToId ?? "";
      slot.replyToLogin = event.privmsg.replyToLogin ?? "";
      slot.replyToText = event.privmsg.replyToText ?? "";
      slot.isAction = event.privmsg.action === true;
      slot.isWhisper = false;
    } else {
      slot.replyToId = "";
      slot.replyToLogin = "";
      slot.replyToText = "";
      slot.isAction = false;
      slot.isWhisper = false;
    }
    slot.timestampMs = event.timestampMs;
    slot.spansRaw = drawn.spans;
    slot.mentionSpans = drawn.mentions;
    slot.badgesRaw = drawn.badges;
    slot.replyRows =
      !this.hideReplyContext && slot.replyToLogin.length > 0 ? 1 : 0;
    slot.lineCount = this.estimateSlotLineCount(slot);
    slot.highlightColor = drawn.highlightColor;
    slot.systemTextKind = "";
    slot.clearLogin = "";
    slot.clearDurationSec = undefined;
    slot.clearStackCount = 0;
    slot.clearSourceLogin = "";
    slot.clearModeratorLogin = "";
    slot.clearmsgBody = "";
    slot.usernoticeMsgId = "";
    slot.usernoticeSystemText = "";
    slot.usernoticeLogin = "";
    slot.usernoticeParams = null;
    slot.usernoticeInnerBody = "";
    slot.noticeMsgId = "";
    slot.noticeFallback = "";
    slot.noticeTimeoutSec = undefined;
    if (event.kind === "automodHeld") {
      slot.automodMessageId = event.messageId;
      slot.automodStatus = event.status;
      const author = event.authorDisplayName || event.authorLogin;
      const prefix = `${author}: `;
      const reason = (event.reason ?? "").trim();
      const status = event.status.toLowerCase();
      const pending = status === "pending";
      const head = pending
        ? reason
          ? t("chat.automod.heldReason", { reason })
          : t("chat.automod.held")
        : status === "allowed"
          ? t("chat.automod.allowed")
          : status === "expired"
            ? t("chat.automod.expired")
            : t("chat.automod.denied");
      const allowLabel = t("chat.automod.allow");
      const denyLabel = t("chat.automod.deny");
      const actionLine = pending ? `${allowLabel}  ${denyLabel}` : "";
      const shift =
        head.length +
        1 +
        (pending ? actionLine.length + 1 : 0) +
        prefix.length;
      slot.automodCaught = (event.caughtRanges ?? []).map((r) => ({
        start: r.start + shift,
        end: r.end + shift,
      }));
    } else {
      slot.automodMessageId = "";
      slot.automodStatus = "";
      slot.automodCaught = [];
    }
    if (event.kind === "clearchat") {
      slot.systemTextKind = "clearchat";
      slot.clearLogin = event.targetLogin ?? "";
      slot.clearDurationSec = event.durationSec;
      slot.clearStackCount = event.stackCount ?? 1;
      slot.clearSourceLogin = event.sourceLogin ?? "";
      slot.clearModeratorLogin = event.moderatorLogin ?? "";
    } else if (event.kind === "usernotice") {
      slot.systemTextKind = "usernotice";
      slot.usernoticeMsgId = event.msgId ?? "";
      slot.usernoticeSystemText = event.systemText;
      slot.usernoticeLogin = event.login ?? "";
      slot.usernoticeParams = event.params ?? null;
      if (event.privmsg && event.privmsg.kind === "privmsg") {
        const actionP = event.privmsg.action ? "* " : "";
        slot.usernoticeInnerBody = `${actionP}${event.privmsg.text}`;
      }
    } else if (event.kind === "notice") {
      slot.systemTextKind = "notice";
      slot.noticeMsgId = event.msgId ?? "";
      slot.noticeFallback = event.text;
      slot.noticeTimeoutSec = event.timeoutRemainingSec;
    }
    if (this.isSystemCloud(slot)) slot.badgesRaw = [];
  }

  private line(event: ChatEvent): Drawn {
    const time = formatTime(event.timestampMs, this.timestampFormat);
    switch (event.kind) {
      case "privmsg": {
        let prefix = "";
        let leadLen = 0;
        if (event.whisper) {
          prefix += whisperPrefix();
          leadLen = prefix.length;
        }
        if (event.action) {
          prefix += "* ";
        }
        const shift = prefix.length;
        return {
          time,
          nick: this.paintedNick(
            event.login,
            event.displayName || event.login,
          ),
          nickColor: resolveNickColor({
            color: event.color,
            userId: event.userId,
            colorize: this.colorizeNicknames,
            fallback: this.themeFills.nickFallback,
          }),
          body: `${prefix}${event.text}`,
          copyText: event.text,
          leadLen,
          spans: shiftSpans(event.emoteSpans ?? [], shift),
          links: shiftSpans(event.linkSpans ?? [], shift),
          mentions: shiftSpans(event.mentionSpans ?? [], shift),
          badges: badgesWithUrl(event.badges ?? []),
          highlightColor: event.highlightColor ?? "",
        };
      }
      case "usernotice": {
        const sys = usernoticeFormatted({
          systemText: event.systemText,
          login: event.login,
          msgId: event.msgId,
          params: event.params,
        });
        let body = sys.text;
        let spans: EmoteSpan[] = [];
        let links: LinkSpan[] = [];
        let mentions: MentionSpan[] = sys.mentions.slice();
        let badges: Badge[] = [];
        let highlightColor = "";
        let copyText = sys.text;
        let leadLen = 0;
        if (event.privmsg && event.privmsg.kind === "privmsg") {
          const inner = event.privmsg;
          let innerPrefix = "";
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
          mentions = [
            ...mentions,
            ...shiftSpans(inner.mentionSpans ?? [], shift),
          ];
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
      case "clearchat": {
        const fmt = clearchatFormatted(
          event.targetLogin,
          event.durationSec,
          event.stackCount,
          event.sourceLogin,
          event.moderatorLogin,
        );
        return {
          time,
          nick: "*",
          nickColor: this.themeFills.nickFallback,
          body: fmt.text,
          copyText: fmt.text,
          leadLen: 0,
          spans: [],
          links: [],
          mentions: fmt.mentions,
          badges: [],
          highlightColor: "",
        };
      }
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
      case "notice": {
        const fmt = noticeFormatted({
          text: event.text,
          msgId: event.msgId,
          timeoutRemainingSec: event.timeoutRemainingSec,
        });
        return {
          time,
          nick: "*",
          nickColor: this.themeFills.nickFallback,
          body: fmt.text,
          copyText: fmt.text,
          leadLen: 0,
          spans: [],
          links: [],
          mentions: fmt.mentions,
          badges: [],
          highlightColor: "",
        };
      }
      case "automodHeld": {
        const author = event.authorDisplayName || event.authorLogin;
        const prefix = `${author}: `;
        const reason = (event.reason ?? "").trim();
        const status = event.status.toLowerCase();
        const pending = status === "pending";
        const head = pending
          ? reason
            ? t("chat.automod.heldReason", { reason })
            : t("chat.automod.held")
          : status === "allowed"
            ? t("chat.automod.allowed")
            : status === "expired"
              ? t("chat.automod.expired")
              : t("chat.automod.denied");
        const allowLabel = t("chat.automod.allow");
        const denyLabel = t("chat.automod.deny");
        const actionLine = pending ? `${allowLabel}  ${denyLabel}` : "";
        const body = pending
          ? `${head}\n${actionLine}\n${prefix}${event.text}`
          : `${head}\n${prefix}${event.text}`;
        return {
          time,
          nick: "AutoMod",
          nickColor: 0x4488ff,
          body,
          copyText: `${author}: ${event.text}`,
          leadLen: 0,
          spans: [],
          links: [],
          mentions: [],
          badges: [],
          highlightColor: AUTOMOD_HIGHLIGHT,
        };
      }
      case "automodStatus":
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
      case "lowTrustHeader": {
        const body = `Suspicious User: ${event.detail}`;
        return {
          time,
          nick: "Suspicious User",
          nickColor: 0x0000ff,
          body,
          copyText: body,
          leadLen: 0,
          spans: [],
          links: [],
          mentions: [],
          badges: [],
          highlightColor: LOW_TRUST_HIGHLIGHT,
        };
      }
      case "lowTrustMessage": {
        const author = event.displayName || event.login;
        const body = `${author}: ${event.text}`;
        return {
          time,
          nick: author,
          nickColor: this.themeFills.nickFallback,
          body,
          copyText: body,
          leadLen: 0,
          spans: [],
          links: event.linkSpans ?? [],
          mentions: event.mentionSpans ?? [],
          badges: [],
          highlightColor: LOW_TRUST_HIGHLIGHT,
        };
      }
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

  private isSystemCloud(slot: MessageRow): boolean {
    return (
      slot.system &&
      !slot.useNickStyle &&
      !slot.isWhisper &&
      slot.bodyRaw.length > 0
    );
  }

  /** Width of one wrap line in ChatFont layout px (emote holes included). */
  private measureBodyLineWidth(
    slot: MessageRow,
    line: WrapLine,
    opts: WrapOptions,
    fontSize: number = this.fontSize,
  ): number {
    if (line.end <= line.start) {
      return 0;
    }
    const rendered = renderWrapped(
      slot.bodyRaw,
      [line],
      slot.spansRaw,
      opts,
    );
    return this.measureBitmapTextWidth("ChatFont", rendered, fontSize);
  }

  /** Geometry remains available when a message has no view. */
  private measureSlot(slot: MessageRow): void {
    if (this.isSystemCloud(slot)) {
      this.measureSystemCloud(slot);
      return;
    }
    slot.systemCloudBounds = null;
    const gap = Math.max(4, Math.round(TIME_GAP * this.fontScale));
    slot.timeWidth = this.timestampsVisible()
      ? this.measureBitmapTextWidth("ChatFont", formatTime(Date.UTC(2000, 0, 1, 23, 59, 59, 999), this.timestampFormat)) + gap
      : 0;
    slot.gutterWidth = this.modGutterWidth(slot);
    slot.replyRows = !this.hideReplyContext && slot.replyToLogin.length > 0 ? 1 : 0;
    slot.bodyY = slot.replyRows * this.lineHeight;
    const badgeN = this.visibleBadges(slot).length;
    const badgeBand = badgeN === 0 ? 0 : badgeN * this.badgeSize + (badgeN - 1) * BADGE_GAP;
    slot.nickX = slot.gutterWidth + slot.timeWidth + badgeBand;
    const nickColon = slot.useNickStyle && !slot.isAction && slot.nickRaw.length > 0;
    const nick = nickColon ? `${slot.nickRaw}:` : slot.nickRaw;
    const maxNickPx = Math.max(8, this.app.screen.width - slot.nickX - gap - 8 - MIN_BODY_COLS_AFTER_NICK * this.charWidth);
    slot.nickText = Math.max(this.measureBitmapTextWidth("ChatNickFont", nick), 8) > maxNickPx
      ? this.clipNickToWidth(slot.nickRaw, maxNickPx, nickColon)
      : nick;
    const nickW = Math.max(this.measureBitmapTextWidth("ChatNickFont", slot.nickText), 8);
    slot.bodyIndent = slot.nickX + nickW + gap;
    slot.bodyContIndent = slot.gutterWidth;
    slot.lineWidth = Math.max(1, Math.floor(this.app.screen.width - slot.bodyContIndent - 8));
    slot.firstLineWidth = Math.max(1, Math.floor(this.app.screen.width - slot.bodyIndent - 8));
    const opts = this.wrapOpts(slot, undefined, slot.firstLineWidth);
    const wrapped = wrapBody(slot.bodyRaw, slot.lineWidth, slot.spansRaw, opts);
    const maxLines = slot.collapsible && !slot.expanded ? this.collapseMessagesMinLines : 0;
    const { lines, collapsed } = collapseWrapLines(wrapped, maxLines, slot.bodyRaw,
      maxLines === 1 ? slot.firstLineWidth : slot.lineWidth, slot.spansRaw, opts);
    slot.collapsed = collapsed;
    slot.wrapLines = lines;
    slot.clipCardRows = slot.clipCard ? clipCardRowCount(this.lineHeight) : 0;
    const mentions = this.boldUsernames || this.colorUsernames
      ? this.mentionSpansForOverlay(slot.mentionSpans, lines) : [];
    slot.wrapLineHeights = wrapLineHeights(lines, slot.bodyRaw, slot.spansRaw,
      this.wrapOpts(slot, mentions, slot.firstLineWidth), this.lineHeight);
    slot.lineCount = slot.replyRows + slot.clipCardRows +
      Math.max(1, Math.ceil(this.slotBodyPixelHeight(slot) / this.lineHeight));
    slot.wrapReady = true;
  }

  private measureSystemCloud(slot: MessageRow): void {
    const padX = Math.max(6, Math.round(SYSTEM_CLOUD_PAD_X * this.fontScale));
    const padY = Math.max(1, Math.round(SYSTEM_CLOUD_PAD_Y * this.fontScale));
    const radius = Math.max(6, Math.round(SYSTEM_CLOUD_RADIUS * this.fontScale));
    const marginX = Math.max(4, Math.round(SYSTEM_CLOUD_MARGIN_X * this.fontScale));
    const fontSize = this.systemCloudFontSize();
    const lineHeight = this.systemCloudLineHeight(fontSize);
    slot.lineWidth = Math.max(1, Math.floor(this.app.screen.width - marginX - padX * 2));
    slot.firstLineWidth = slot.lineWidth;
    const opts = this.wrapOpts(slot, [], slot.lineWidth, fontSize);
    slot.wrapLines = wrapBody(slot.bodyRaw, slot.lineWidth, slot.spansRaw, opts);
    slot.collapsed = false;
    slot.replyRows = 0;
    slot.clipCardRows = 0;
    let maxLineW = 0;
    for (const line of slot.wrapLines) {
      maxLineW = Math.max(maxLineW, this.measureBodyLineWidth(slot, line, opts, fontSize));
    }
    slot.wrapLineHeights = wrapLineHeights(slot.wrapLines, slot.bodyRaw, slot.spansRaw, opts, lineHeight);
    const bodyPix = this.slotBodyPixelHeight(slot);
    slot.lineCount = Math.max(1, Math.ceil(bodyPix / this.lineHeight));
    const cloud = slot.systemCloudBounds ??
      (slot.systemCloudBounds = { x: 0, y: 0, w: 0, h: 0, radius: 0, lineHeight: 0, fontSize: 0 });
    cloud.x = marginX;
    cloud.y = 0;
    cloud.w = Math.min(this.app.screen.width - marginX, Math.max(1, Math.ceil(maxLineW)) + 2 * padX);
    cloud.h = bodyPix + 2 * padY;
    cloud.radius = radius;
    cloud.lineHeight = lineHeight;
    cloud.fontSize = fontSize;
    slot.bodyIndent = marginX + padX;
    slot.bodyContIndent = slot.bodyIndent;
    slot.bodyY = padY;
    slot.wrapReady = true;
  }

  private modGutterWidth(slot: MessageRow): number {
    if (!this.showModGutter(slot)) return 0;
    const count = Math.min(MOD_GUTTER_ICON_COUNT, modGutterActions().length);
    const iconSize = Math.max(14, Math.round(this.fontSize * 1.05));
    const padX = Math.max(2, Math.round(2 * this.fontScale));
    const gap = Math.max(4, Math.round(4 * this.fontScale));
    return count > 0 ? count * (iconSize + padX * 2) + (count - 1) * gap : 0;
  }

  private paintSystemCloud(slot: Slot): void {
    const view = this.viewPool.get(slot);
    if (!view) { return; }
    this.releaseSlotClipCard(slot);
    this.resizeMediaSprites(slot, view.modIcons, 0);
    const cloud = slot.systemCloudBounds!;
    const { x: cloudX, y: cloudY, w: cloudW, h: cloudH, radius,
      fontSize: cloudFontSize, lineHeight: cloudLineHeight } = cloud;
    const paneW = this.app.screen.width;
    const allocatedH = this.slotPixelHeight(slot);
    const textOriginX = slot.bodyIndent;
    const contentY = slot.bodyY;
    const lines = slot.wrapLines;
    const layoutOpts = this.wrapOpts(slot, [], slot.lineWidth, cloudFontSize);
    view.root.cursor = "default";

    view.time.visible = false;
    view.nick.visible = false;
    view.nickPaintSpr.visible = false;
    view.nick.text = "";
    view.replyHeader.visible = false;
    view.replyHeader.text = "";
    for (const spr of view.badges) {
      spr.visible = false;
    }
    for (const mt of view.modBtns) {
      mt.visible = false;
      mt.text = "";
    }
    for (const spr of view.modIcons) {
      spr.visible = false;
    }
    for (const ct of view.caughtTexts) {
      ct.visible = false;
      ct.text = "";
    }
    view.modBtnHits = [];
    view.automodBtnHits = [];
    view.bitsLabel.visible = false;
    view.bitsLabel.text = "";
    view.body.style.fontSize = cloudFontSize;
    view.body.style.lineHeight = cloudLineHeight;
    view.body.style.fill = SYSTEM_CLOUD_FG;
    view.bodyCont.style.fontSize = cloudFontSize;
    view.bodyCont.style.lineHeight = cloudLineHeight;
    view.bodyCont.style.fill = SYSTEM_CLOUD_FG;

    view.body.x = textOriginX;
    view.body.y = contentY;
    view.bodyCont.x = textOriginX;
    view.bodyCont.y = contentY + (slot.wrapLineHeights[0] ?? cloudLineHeight);

    const firstOnly = lines.length > 0 ? [lines[0]] : [{ start: 0, end: 0 }];
    const restLines = lines.slice(1);
    view.body.text = renderWrapped(
      slot.bodyRaw,
      firstOnly,
      slot.spansRaw,
      layoutOpts,
    );
    if (restLines.length === 0) {
      view.bodyCont.visible = false;
      view.bodyCont.text = "";
    } else {
      view.bodyCont.visible = true;
      view.bodyCont.text = renderWrappedContinuation(
        slot.bodyRaw,
        restLines,
        slot.wrapLineHeights,
        cloudLineHeight,
        slot.spansRaw,
        layoutOpts,
        false,
      );
    }

    const previousCloud = view.cloudPaintBounds;
    if (!previousCloud || previousCloud.x !== cloudX || previousCloud.y !== cloudY ||
        previousCloud.w !== cloudW || previousCloud.h !== cloudH || previousCloud.radius !== radius) {
      view.systemCloud.clear();
      view.systemCloud.roundRect(cloudX, cloudY, cloudW, cloudH, radius)
        .fill({ color: SYSTEM_CLOUD_BG, alpha: 1 });
      view.cloudPaintBounds = { x: cloudX, y: cloudY, w: cloudW, h: cloudH, radius };
    }

    if (view.root.hitArea instanceof Rectangle) {
      view.root.hitArea.width = paneW;
      view.root.hitArea.height = allocatedH;
    }

    this.paintHighlight(slot);
    this.clearSlotLinks(slot);
    for (const mt of view.mentionTexts) {
      mt.visible = false;
      mt.text = "";
    }
    for (const ht of view.hostTexts) {
      ht.visible = false;
      ht.text = "";
    }
    this.paintLinks(
      slot,
      textOriginX,
      textOriginX,
      contentY,
      layoutOpts,
      cloudLineHeight,
      cloudFontSize,
    );
    this.paintDisabled(slot);

    let prevX = 0;
    let prevY = 0;
    let hasPrev = false;
    let prevEnd = 0;
    for (let i = 0; i < view.emotes.length; i += 1) {
      const spr = view.emotes[i];
      const span = slot.spansRaw[i];
      if (!span || !this.enableEmoteImages || span.provider === "cheer-mask") {
        spr.visible = false;
        continue;
      }
      const paint = this.emotePaintSize(span, cloudFontSize);
      const zw = this.enableZeroWidthEmotes && span.zeroWidth === true;
      // Overlay only onto the last painted non-mask emote; lone ZW paints as a regular emote.
      if (stacksZeroWidth(slot.bodyRaw, prevEnd, span.start, zw, hasPrev)) {
        this.paintEmoteSpriteAt(slot, i, spr, span, prevX, prevY, paint.w, paint.h);
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
      this.paintEmoteSpriteAt(
        slot,
        i,
        spr,
        span,
        textOriginX + pos.col,
        this.lineMediaYForWrapLine(contentY, paint.h, pos.line, slot),
        paint.w,
        paint.h,
      );
      prevX = spr.x;
      prevY = spr.y;
      hasPrev = true;
      prevEnd = span.end;
    }
    view.bitsLabel.visible = false;
    view.bitsLabel.text = "";
  }

  private sanitizeSlotRenderableTextures(slot: Slot): void {
    const view = this.viewPool.get(slot);
    if (!view) { return; }
    cleanseSpriteTexture(view.nickPaintSpr);
    if (
      view.nickPaintSpr.visible &&
      !isRenderableTexture(view.nickPaintSpr.texture)
    ) {
      view.nickPaintKey = "";
      if (view.nick.text) {
        view.nick.visible = true;
      }
    }
    for (const spr of view.badges) {
      cleanseSpriteTexture(spr);
    }
    for (const spr of view.emotes) {
      cleanseSpriteTexture(spr);
    }
    for (const spr of view.modIcons) {
      cleanseSpriteTexture(spr);
    }
    if (view.clipUi) cleanseSpriteTexture(view.clipUi.thumb);
  }

  private paintClip(slot: Slot): void {
    if (!slot.wrapReady) this.measureSlot(slot);
    const view = this.viewPool.get(slot);
    if (!view) return;
    this.sanitizeSlotRenderableTextures(slot);
    if (this.isSystemCloud(slot)) {
      this.paintSystemCloud(slot);
      view.painted = true;
      view.root.visible = slot.visible;
      return;
    }
    view.time.style.fontSize = this.fontSize;
    view.time.style.lineHeight = this.lineHeight;
    view.nick.style.fontFamily = "ChatNickFont";
    view.nick.style.fontSize = this.fontSize;
    view.nick.style.lineHeight = this.lineHeight;
    view.body.style.fontSize = this.fontSize;
    view.body.style.lineHeight = this.lineHeight;
    view.bodyCont.style.fontSize = this.fontSize;
    view.bodyCont.style.lineHeight = this.lineHeight;
    view.bitsLabel.style.fontSize = this.fontSize;
    view.bitsLabel.style.lineHeight = this.lineHeight;
    this.clearSystemCloud(slot);
    view.body.style.fill = this.themeFills.body;
    view.bodyCont.style.fill = this.themeFills.body;
    const gutterW = this.paintModGutter(slot);
    const timeW = slot.timeWidth;
    const showReply = slot.replyRows > 0;
    const contentY = slot.bodyY;
    if (showReply) {
      view.replyHeader.visible = true;
      view.replyHeader.style.fontSize = Math.max(
        8,
        Math.round(this.fontSize * 0.85),
      );
      view.replyHeader.style.fill = this.themeFills.timestamp;
      view.replyHeader.x = 0;
      view.replyHeader.y = Math.max(
        0,
        (this.lineHeight - view.replyHeader.style.fontSize) / 2,
      );
    } else {
      view.replyHeader.visible = false;
      view.replyHeader.text = "";
    }
    for (const mt of view.modBtns) {
      if (mt.visible) {
        mt.y = contentY;
      }
    }
    view.time.x = gutterW;
    view.time.y = contentY;
    view.time.visible = this.timestampsVisible();
    const badgeVisible = this.visibleBadges(slot);
    for (let i = 0; i < view.badges.length; i += 1) {
      const spr = view.badges[i];
      const badge = badgeVisible[i];
      if (!badge) {
        spr.visible = false;
        continue;
      }
      if (!isRenderableTexture(spr.texture)) {
        spr.visible = false;
        spr.texture = Texture.EMPTY;
        continue;
      }
      spr.visible = true;
      spr.x = gutterW + timeW + i * (this.badgeSize + BADGE_GAP);
      spr.y = this.lineMediaY(contentY, this.badgeSize);
    }
    view.nick.x = slot.nickX;
    view.nick.y = contentY;
    view.nick.text = slot.nickText;
    this.applyNickPaintChrome(slot, contentY);
    const firstOriginX = slot.bodyIndent;
    const contOriginX = slot.bodyContIndent;
    view.body.x = firstOriginX;
    view.body.y = contentY;
    view.bodyCont.x = contOriginX;
    if (view.root.hitArea instanceof Rectangle) {
      view.root.hitArea.width = this.app.screen.width;
    }
    const fullWidthPx = slot.lineWidth;
    const firstWidthPx = slot.firstLineWidth;
    if (showReply) {
      view.replyHeader.x = contOriginX;
      view.replyHeader.text = clipReplyHeaderToWidth(
        formatReplyHeader(slot.replyToLogin, slot.replyToText),
        fullWidthPx,
        (s) => this.measureBitmapTextWidth("ChatFont", s),
      );
    }
    const layoutOpts = this.wrapOpts(slot, undefined, firstWidthPx);
    const lines = slot.wrapLines;
    const collapsed = slot.collapsed;
    view.root.cursor = collapsed || view.modBtnHits.length > 0 ? "pointer" : "default";
    const overlayMentions =
      this.boldUsernames || this.colorUsernames
        ? this.mentionSpansForOverlay(slot.mentionSpans, lines)
        : [];
    const renderOpts = this.wrapOpts(slot, overlayMentions, firstWidthPx);
    view.bodyCont.y = contentY + (slot.wrapLineHeights[0] ?? this.lineHeight);
    const firstOnly = lines.length > 0 ? [lines[0]] : [{ start: 0, end: 0 }];
    const restLines = lines.slice(1);
    view.body.text = withCollapsedEllipsis(
      renderWrapped(slot.bodyRaw, firstOnly, slot.spansRaw, renderOpts),
      collapsed && restLines.length === 0,
    );
    if (restLines.length === 0) {
      view.bodyCont.visible = false;
      view.bodyCont.text = "";
    } else {
      view.bodyCont.visible = true;
      view.bodyCont.text = renderWrappedContinuation(
        slot.bodyRaw,
        restLines,
        slot.wrapLineHeights,
        this.lineHeight,
        slot.spansRaw,
        renderOpts,
        collapsed,
      );
    }
    if (view.root.hitArea instanceof Rectangle) {
      view.root.hitArea.height = this.slotPixelHeight(slot);
    }
    this.paintHighlight(slot);
    this.clearSlotLinks(slot);
    this.paintLinks(slot, firstOriginX, contOriginX, contentY, layoutOpts);
    this.paintHostTexts(
      slot,
      firstOriginX,
      contOriginX,
      contentY,
      layoutOpts,
    );
    this.paintMentionTexts(
      slot,
      firstOriginX,
      contOriginX,
      contentY,
      lines,
      renderOpts,
      overlayMentions,
    );
    this.paintCaughtTexts(
      slot,
      firstOriginX,
      contOriginX,
      contentY,
      lines,
      renderOpts,
    );
    this.paintAutomodActions(slot, firstOriginX, contentY, lines);
    this.paintDisabled(slot);
    let prevX = 0;
    let prevY = 0;
    let hasPrev = false;
    let prevEnd = 0;
    let bitsLabelShown = false;
    for (let i = 0; i < view.emotes.length; i += 1) {
      const spr = view.emotes[i];
      const span = slot.spansRaw[i];
      if (!span || !this.enableEmoteImages || span.provider === "cheer-mask") {
        spr.visible = false;
        continue;
      }
      const paint = this.emotePaintSize(span, this.slotBodyFontSize(slot));
      const zw = this.enableZeroWidthEmotes && span.zeroWidth === true;
      // Overlay only onto the last painted non-mask emote; lone ZW paints as a regular emote.
      if (stacksZeroWidth(slot.bodyRaw, prevEnd, span.start, zw, hasPrev)) {
        this.paintEmoteSpriteAt(slot, i, spr, span, prevX, prevY, paint.w, paint.h);
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
      this.paintEmoteSpriteAt(
        slot,
        i,
        spr,
        span,
        wrapLineOriginX(firstOriginX, pos.line, contOriginX) + pos.col,
        this.lineMediaYForWrapLine(contentY, paint.h, pos.line, slot),
        paint.w,
        paint.h,
      );
      prevX = spr.x;
      prevY = spr.y;
      hasPrev = true;
      prevEnd = span.end;
      if (
        !bitsLabelShown &&
        this.stackBits &&
        span.bitsAmount != null &&
        span.bitsAmount > 0 &&
        span.bitsColor
      ) {
        const tint = parseCheerColor(span.bitsColor);
        if (tint != null) {
          view.bitsLabel.visible = true;
          view.bitsLabel.text = ` ${span.bitsAmount}`;
          view.bitsLabel.tint = tint;
          view.bitsLabel.x = spr.x + paint.w + 2;
          view.bitsLabel.y = this.wrapLineY(contentY, pos.line, slot);
          bitsLabelShown = true;
        }
      }
    }
    if (!bitsLabelShown) {
      view.bitsLabel.visible = false;
      view.bitsLabel.text = "";
    }
    this.paintSlotClipCard(slot);
    view.painted = true;
    view.root.visible = slot.visible;
  }

  private releaseSlotClipCard(slot: Slot): void {
    const view = this.viewPool.get(slot);
    if (!view) { return; }
    const clip = view.clipUi;
    if (!clip) return;
    view.clipUi = null;
    releaseClipThumb(clip, this.textures);
    clip.root.destroy({ children: true, context: true, style: true });
  }

  private paintSlotClipCard(slot: Slot): void {
    const view = this.viewPool.get(slot);
    if (!view) { return; }
    const token = this.viewPool.tokenOf(slot);
    if (!slot.clipCard || slot.clipCardRows <= 0) {
      this.releaseSlotClipCard(slot);
      return;
    }
    if (!view.clipUi) {
      view.clipUi = createClipCardWidgets(this.themeFills.timestamp);
      view.root.addChildAt(view.clipUi.root, view.root.getChildIndex(view.disabledGfx));
    }
    const clip = view.clipUi;
    const msgId = slot.msgId;
    const clipId = slot.clipCard?.clipId ?? "";
    paintClipCard({
      clip,
      info: slot.clipCard,
      clipCardRows: slot.clipCardRows,
      lineCount: slot.lineCount,
      lineHeight: this.lineHeight,
      bodyContIndent: slot.bodyContIndent,
      paneW: this.app.screen.width,
      fontSize: this.fontSize,
      mutedFill: this.themeFills.timestamp,
      textures: this.textures,
      measure: (text) => this.measureBitmapTextWidth("ChatFont", text),
      applySprite: applySpriteTexture,
      stillCurrent: () =>
        this.viewPool.owns(slot, view, token) &&
        slot.msgId === msgId &&
        !!slot.clipCard &&
        slot.clipCard.clipId === clipId &&
        view.clipUi === clip && clip.thumbKey === `clip:${clipId}`,
    });
  }

  private paintHighlight(slot: Slot): void {
    const view = this.viewPool.get(slot);
    if (!view) { return; }
    const cloud = slot.systemCloudBounds;
    let color: number | undefined;
    let alpha = 0;
    if (this.findHitId && slot.msgId === this.findHitId) {
      color = 0xf0ad4e;
      alpha = 0.28;
    } else {
      const parsed = parseHighlight(slot.highlightColor);
      if (parsed) {
        color = parsed.color;
        alpha = parsed.alpha;
      } else if (this.hoveredMsgId && slot.msgId === this.hoveredMsgId) {
        color = this.themeFills.hover;
        alpha = this.themeFills.hoverAlpha;
      } else if (!cloud && this.alternateMessages && slot.startRow % 2 === 1) {
        color = this.themeFills.alternate;
        alpha = this.themeFills.alternateAlpha;
      }
    }
    const separator = this.separateMessages && !cloud;
    const lastRead = this.showLastRead && !!this.lastReadMsgId &&
      slot.msgId === this.lastReadMsgId;
    if (color === undefined && !separator && !lastRead) {
      if (view.highlightPainted) {
        view.highlight.clear();
        view.highlightPainted = false;
      }
      return;
    }
    view.highlight.clear();
    view.highlightPainted = true;
    const h = this.slotPixelHeight(slot);
    const w = this.app.screen.width;
    if (color !== undefined) {
      if (cloud) {
        view.highlight
          .roundRect(cloud.x, cloud.y, cloud.w, cloud.h, cloud.radius)
          .fill({ color, alpha });
      } else {
        view.highlight
          .rect(0, 0, w, h)
          .fill({ color, alpha });
      }
    }
    if (separator) {
      view.highlight
        .moveTo(0, h - 0.5)
        .lineTo(w, h - 0.5)
        .stroke({ width: 1, color: this.themeFills.separator, alpha: 0.9 });
    }
    if (lastRead) {
      this.paintLastReadLine(view.highlight, w, h);
    }
  }

  private paintLastReadLine(gfx: Graphics, w: number, h: number): void {
    const y = h - 0.5;
    const color = this.lastReadColor;
    let alpha = 1;
    if (
      this.lastReadFadeMsgId === this.lastReadMsgId &&
      this.lastReadFadeStart > 0
    ) {
      const t = Math.min(1, (performance.now() - this.lastReadFadeStart) / 150);
      alpha = t;
    }
    if (this.lastReadPattern === "Solid") {
      gfx.moveTo(0, y).lineTo(w, y).stroke({ width: 1, color, alpha });
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
    gfx.stroke({ width: 1, color, alpha });
  }

  private clearSystemCloud(slot: Slot): void {
    const view = this.viewPool.get(slot);
    if (!view) { return; }
    if (view.cloudPaintBounds) {
      view.systemCloud.clear();
      view.cloudPaintBounds = null;
    }
  }

  private clearDisabledBackground(slot: Slot): void {
    const view = this.viewPool.get(slot);
    if (!view) { return; }
    if (view.disabledPaint) {
      view.disabledGfx.clear();
      view.disabledPaint = null;
    }
  }

  private paintDisabled(slot: Slot): void {
    const view = this.viewPool.get(slot);
    if (!view) { return; }
    const dim =
      slot.disabled || (this.fadeMessageHistory && slot.fromHistory);
    if (!dim) {
      this.clearDisabledBackground(slot);
      return;
    }
    const w = this.app.screen.width;
    const h = this.slotPixelHeight(slot);
    const color = this.themeFills.disabled;
    const alpha = this.themeFills.disabledAlpha;
    const previous = view.disabledPaint;
    if (
      previous && previous.w === w && previous.h === h &&
      previous.color === color && previous.alpha === alpha
    ) {
      return;
    }
    const paint = previous ?? (view.disabledPaint = { w: 0, h: 0, color: 0, alpha: 0 });
    paint.w = w;
    paint.h = h;
    paint.color = color;
    paint.alpha = alpha;
    view.disabledGfx.clear();
    view.disabledGfx
      .rect(0, 0, w, h)
      .fill({ color, alpha });
  }

  private clearSlotLinks(slot: Slot): void {
    const view = this.viewPool.get(slot);
    if (!view) { return; }
    if (view.linksPainted) {
      view.mentions.clear();
      view.linksPainted = false;
    }
  }

  /** Underline link spans (hit-test uses the same ranges). */
  private paintLinks(
    slot: Slot,
    firstOriginX: number,
    contOriginX: number,
    contentY: number,
    wrapOpts: WrapOptions,
    rowLineHeight: number = this.lineHeight,
    measureFontSize: number = this.fontSize,
  ): void {
    const view = this.viewPool.get(slot);
    if (!view) { return; }
    if (slot.linkSpans.length === 0) {
      return;
    }
    const linkColor = 0x3ea6ff;
    for (const span of slot.linkSpans) {
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
        const linkW = Math.max(
          1,
          this.measureBitmapTextWidth(
            "ChatFont",
            slot.bodyRaw.slice(a, b),
            measureFontSize,
          ),
        );
        const x0 =
          wrapLineOriginX(firstOriginX, start.line, contOriginX) + start.col;
        const rowH = slot.wrapLineHeights[start.line] ?? rowLineHeight;
        const y = this.wrapLineY(contentY, start.line, slot) + rowH - 2;
        view.linksPainted = true;
        view.mentions
          .moveTo(x0, y)
          .lineTo(x0 + linkW, y)
          .stroke({ width: 1, color: linkColor, alpha: 0.95 });
      }
    }
  }

  private resizeMediaSprites(slot: Slot, sprites: Sprite[], count: number): void {
    const view = this.viewPool.get(slot);
    if (!view) { return; }
    while (sprites.length > count) {
      const sprite = sprites.pop()!;
      detachSpriteTexture(sprite);
      sprite.destroy();
    }
    while (sprites.length < count) {
      const sprite = new Sprite(Texture.EMPTY);
      sprite.visible = false;
      sprite.eventMode = "none";
      const anchor = sprites === view.modIcons ? view.replyHeader
        : sprites === view.badges ? view.emotes[0] ?? view.clipUi?.root ?? view.disabledGfx
        : view.clipUi?.root ?? view.disabledGfx;
      view.root.addChildAt(sprite, view.root.getChildIndex(anchor));
      sprites.push(sprite);
    }
  }

  private overlayText(slot: Slot, texts: BitmapText[], index: number): BitmapText {
    const view = this.viewPool.get(slot);
    if (!view) { throw new Error("Message view is not bound"); }
    if (!texts[index]) {
      const text = new BitmapText({
        text: "",
        style: { fontFamily: "ChatFont", fontSize: this.fontSize, lineHeight: this.lineHeight, fill: 0xffffff },
      });
      text.eventMode = "none";
      text.visible = false;
      const anchor = texts === view.modBtns ? view.modIcons[0] ?? view.replyHeader
        : texts === view.mentionTexts ? view.hostTexts[0] ?? view.caughtTexts[0] ?? view.bitsLabel
        : texts === view.hostTexts ? view.caughtTexts[0] ?? view.bitsLabel
        : view.bitsLabel;
      view.root.addChildAt(text, view.root.getChildIndex(anchor));
      texts.push(text);
    }
    return texts[index];
  }

  private trimOverlayTexts(texts: BitmapText[], used: number): void {
    while (texts.length > used) texts.pop()!.destroy({ style: true });
  }

  private paintHostTexts(
    slot: Slot,
    firstOriginX: number,
    contOriginX: number,
    contentY: number,
    wrapOpts: WrapOptions,
  ): void {
    const view = this.viewPool.get(slot);
    if (!view) { return; }
    for (const ht of view.hostTexts) {
      ht.visible = false;
    }
    if (slot.hostSpans.length === 0) {
      this.trimOverlayTexts(view.hostTexts, 0);
      return;
    }
    let used = 0;
    for (const span of slot.hostSpans) {
      for (const line of slot.wrapLines) {
        if (used >= MENTION_SLOTS_PER_ROW) {
          return;
        }
        const a = Math.max(span.start, line.start);
        const b = Math.min(span.end, line.end);
        if (a >= b) {
          continue;
        }
        const pos = indexToLineCol(
          slot.bodyRaw,
          slot.wrapLines,
          a,
          slot.spansRaw,
          wrapOpts,
        );
        if (!pos) {
          continue;
        }
        const ht = this.overlayText(slot, view.hostTexts, used);
        used += 1;
        ht.text = slot.bodyRaw.slice(a, b);
        ht.style.fontFamily = "ChatFont";
        ht.style.fontSize = this.fontSize;
        ht.style.lineHeight = this.lineHeight;
        ht.style.fill = this.themeFills.timestamp;
        ht.x =
          wrapLineOriginX(firstOriginX, pos.line, contOriginX) + pos.col;
        ht.y = this.wrapLineY(contentY, pos.line, slot);
        ht.visible = true;
      }
    }
    this.trimOverlayTexts(view.hostTexts, used);
  }

  private paintMentionTexts(
    slot: Slot,
    firstOriginX: number,
    contOriginX: number,
    contentY: number,
    lines: readonly WrapLine[],
    wrapOpts: WrapOptions,
    overlayMentions: readonly MentionSpan[],
  ): void {
    const view = this.viewPool.get(slot);
    if (!view) { return; }
    for (const mt of view.mentionTexts) {
      mt.visible = false;
    }
    if (!this.boldUsernames && !this.colorUsernames) {
      this.trimOverlayTexts(view.mentionTexts, 0);
      return;
    }
    const fontFamily = this.boldUsernames ? "ChatNickFont" : "ChatFont";
    let used = 0;
    for (const span of overlayMentions) {
      for (const line of lines) {
        if (used >= MENTION_SLOTS_PER_ROW) {
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
        const mt = this.overlayText(slot, view.mentionTexts, used);
        used += 1;
        mt.text = slot.bodyRaw.slice(a, b);
        mt.style.fontFamily = fontFamily;
        mt.style.fontSize = this.fontSize;
        mt.style.lineHeight = this.lineHeight;
        mt.style.fill = 0xffffff;
        const cached = this.nickColorCache.get(span.login);
        mt.tint =
          this.colorUsernames && cached !== undefined
            ? cached
            : this.themeFills.body;
        mt.x =
          wrapLineOriginX(firstOriginX, pos.line, contOriginX) + pos.col;
        // Same row top as body. Explicit lineHeight so Pixi V-centers ChatNickFont
        // glyphs like ChatFont (unset lineHeight sat mentions above body).
        mt.y = this.wrapLineY(contentY, pos.line, slot);
        mt.visible = true;
      }
    }
    this.trimOverlayTexts(view.mentionTexts, used);
  }

  private paintCaughtTexts(
    slot: Slot,
    firstOriginX: number,
    contOriginX: number,
    contentY: number,
    lines: readonly WrapLine[],
    wrapOpts: WrapOptions,
  ): void {
    const view = this.viewPool.get(slot);
    if (!view) { return; }
    for (const ct of view.caughtTexts) {
      ct.visible = false;
    }
    if (slot.automodCaught.length === 0) {
      this.trimOverlayTexts(view.caughtTexts, 0);
      return;
    }
    let used = 0;
    for (const span of slot.automodCaught) {
      for (const line of lines) {
        if (used >= MENTION_SLOTS_PER_ROW) {
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
        const ct = this.overlayText(slot, view.caughtTexts, used);
        used += 1;
        ct.text = slot.bodyRaw.slice(a, b);
        ct.style.fontFamily = "ChatFont";
        ct.style.fontSize = this.fontSize;
        ct.style.lineHeight = this.lineHeight;
        ct.style.fill = 0xffffff;
        ct.tint = AUTOMOD_CAUGHT_COLOR;
        ct.x = wrapLineOriginX(firstOriginX, pos.line, contOriginX) + pos.col;
        ct.y = this.wrapLineY(contentY, pos.line, slot);
        ct.visible = true;
      }
    }
    this.trimOverlayTexts(view.caughtTexts, used);
  }

  private paintAutomodActions(
    slot: Slot,
    firstOriginX: number,
    contentY: number,
    lines: readonly WrapLine[],
  ): void {
    const view = this.viewPool.get(slot);
    if (!view) { return; }
    view.automodBtnHits = [];
    if (
      !slot.automodMessageId ||
      slot.automodStatus.toLowerCase() !== "pending"
    ) {
      this.trimOverlayTexts(view.modBtns, 0);
      return;
    }
    if (lines.length < 2) {
      this.trimOverlayTexts(view.modBtns, 0);
      return;
    }
    const allowLabel = t("chat.automod.allow");
    const denyLabel = t("chat.automod.deny");
    const gap = Math.max(8, Math.round(8 * this.fontScale));
    // Dedicated action row (line 1) so buttons never overflow the header.
    let x = firstOriginX;
    const y = contentY + this.lineHeight;
    const y1 = y + this.lineHeight;
    const btns: Array<{ label: string; action: "allow" | "deny"; color: number }> = [
      { label: allowLabel, action: "allow", color: 0x33cc66 },
      { label: denyLabel, action: "deny", color: 0xff5555 },
    ];
    for (let i = 0; i < btns.length; i += 1) {
      const def = btns[i]!;
      const mt = this.overlayText(slot, view.modBtns, i);
      mt.text = def.label;
      mt.visible = true;
      mt.style.fill = 0xffffff;
      mt.tint = def.color;
      mt.x = x;
      mt.y = y;
      const w = measureTextWidth(
        this.chatFontFamily,
        qtWeightToCss(this.chatFontWeight),
        this.fontSize,
        def.label,
      );
      view.automodBtnHits.push({
        x0: x,
        x1: x + w,
        y0: y,
        y1,
        action: def.action,
      });
      x += w + gap;
    }
    this.trimOverlayTexts(view.modBtns, btns.length);
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

  private layout(
    arg?:
      | ScrollAnchor
      | {
          target: ScrollAnchor | undefined;
          visual: ScrollAnchor | undefined;
          sealed: true;
        },
    paintOnly?: Set<Slot>,
    followSmooth?: boolean,
  ): void {
    if (!this.ready) {
      return;
    }
    const smooth = followSmooth ?? !this.layoutSettling;
    const anchors = this.isAnchorPair(arg)
      ? arg
      : this.captureScrollAnchors(arg);
    this.withPerfMeasure("crt-layout", () => {
      this.layoutInner(anchors, paintOnly, smooth);
    });
  }

  private markLayoutFullPaint(): void {
    this.invalidateAllWraps();
  }

  private invalidateSlotWrap(slot: Slot): void {
    slot.wrapReady = false;
    const view = this.viewPool.get(slot);
    if (view) {
      view.painted = false;
      view.pressToken = undefined;
      view.pressPointerId = undefined;
      view.root.visible = false;
      view.root.renderable = false;
    }
  }

  private invalidateAllWraps(): void {
    const start = (this.head - this.occupied + this.poolSize) % this.poolSize;
    for (let i = 0; i < this.occupied; i += 1) {
      const slot = this.slots[(start + i) % this.poolSize];
      if (slot.msgId) {
        this.invalidateSlotWrap(slot);
      }
    }
  }

  /** Wrap metrics present so paintClip can be skipped until width/font/theme change. */
  private slotWrapValid(slot: Slot): boolean {
    return slot.wrapReady && this.viewPool.get(slot)?.painted === true;
  }

  private slotYIntersects(slot: Slot, top: number, bottom: number): boolean {
    const y0 = slot.y;
    const y1 = y0 + this.slotPixelHeight(slot);
    return y1 >= top && y0 <= bottom;
  }

  /**
   * Stage-space Y band for paintClip. When pinned to bottom, use the end of the
   * current content stack so snapshot/layout paints the visible foot first.
   */
  private viewportPaintBand(contentHeightPx: number): {
    top: number;
    bottom: number;
  } {
    const viewH = this.app.screen.height;
    const bandPad = this.lineHeight * 8;
    let stageY = this.scroll.stageY(this.lineHeight);
    if (this.scroll.atBottom && contentHeightPx > viewH) {
      stageY = -(contentHeightPx - viewH);
    }
    return {
      top: -stageY - bandPad,
      bottom: -stageY + viewH + bandPad,
    };
  }

  private layoutInner(
    anchors: {
      target: ScrollAnchor | undefined;
      visual: ScrollAnchor | undefined;
      sealed: true;
    },
    paintOnly?: Set<Slot>,
    followSmooth = true,
  ): void {
    const start = (this.head - this.occupied + this.poolSize) % this.poolSize;
    this.updateSlotVisibility();
    let totalY = this.positionVisibleSlots();

    if (paintOnly) {
      let heightsChanged = false;
      for (let i = 0; i < this.occupied; i += 1) {
        const slot = this.slots[(start + i) % this.poolSize];
        if (!slot.visible || !paintOnly.has(slot)) {
          continue;
        }
        const prev = this.slotPixelHeight(slot);
        this.measureSlot(slot);
        if (this.slotPixelHeight(slot) !== prev) {
          heightsChanged = true;
        }
      }
      if (heightsChanged) {
        totalY = this.positionVisibleSlots();
      }
    } else {
      const paintBudgetMs = 14;
      const paintStarted = performance.now();
      let budgetHit = false;
      for (let iter = 0; iter < 4; iter += 1) {
        const band = this.viewportPaintBand(totalY);
        let heightsChanged = false;
        for (let i = 0; i < this.occupied; i += 1) {
          const slot = this.slots[(start + i) % this.poolSize];
          if (!slot.visible || slot.wrapReady) {
            continue;
          }
          if (!this.slotYIntersects(slot, band.top, band.bottom)) {
            continue;
          }
          if (performance.now() - paintStarted > paintBudgetMs) {
            budgetHit = true;
            break;
          }
          const prev = this.slotPixelHeight(slot);
          this.measureSlot(slot);
          if (this.slotPixelHeight(slot) !== prev) {
            heightsChanged = true;
          }
        }
        totalY = this.positionVisibleSlots();
        if (budgetHit || !heightsChanged) {
          break;
        }
      }
      if (budgetHit) {
        this.scheduleViewportPaint();
      }
    }

    const viewRows = this.app.screen.height / this.lineHeight;
    this.scroll.applyLayout(
      this.lineHeight > 0 ? totalY / this.lineHeight : 0,
      viewRows,
      this.laidSlots(),
      anchors.target,
      this.isPaused(),
      anchors.visual,
      true,
      followSmooth,
    );
    this.afterScrollChange();
    this.paintSlotsEnteringViewport();
  }

  private perfEnabled(): boolean {
    return this.perfOn;
  }

  private withPerfMeasure(name: string, fn: () => void): void {
    if ((!this.perfEnabled() && !this.performanceTrace?.active()) || typeof performance === "undefined") {
      fn();
      return;
    }
    const t0 = performance.now();
    fn();
    const ms = performance.now() - t0;
    this.performanceTrace?.operation(name, ms);
    const slowMs = name === "crt-layout" ? 32 : 16;
    if (
      ms > slowMs &&
      !(
        name === "crt-layout" &&
        (this.loadingSnapshot || this.layoutSettling)
      )
    ) {
      const now = performance.now();
      if (now - this.perfLogAt >= 1000) {
        this.perfLogAt = now;
        console.warn(`[crt-perf] ${name} ${ms.toFixed(1)}ms (>${slowMs}ms)`);
      }
    }
  }

  private afterScrollChange(): void {
    if (this.scroll.atBottom) {
      this.pendingBelow = 0;
    }
    this.applyStageY();
    this.notifyScroll();
    this.ensureScrollTick();
    this.scheduleViewportPaint();
  }

  private cancelLayoutSettle(): void {
    this.layoutSettleGen += 1;
    this.layoutSettling = false;
    this.layoutSettlePinned = false;
    this.layoutSettleQuietUntil = 0;
  }

  private noteLayoutSettleActivity(): void {
    if (!this.layoutSettling) {
      return;
    }
    this.layoutSettleQuietUntil =
      performance.now() + MessageRing.LAYOUT_SETTLE_QUIET_MS;
  }

  /**
   * After snapshot / history rewrite: snap follow growth while lazy paints and a short
   * live catch-up run, then one final bottom snap if the channel opened pinned.
   */
  private beginLayoutSettle(pinned: boolean): void {
    this.layoutSettling = true;
    this.layoutSettlePinned = pinned;
    const gen = ++this.layoutSettleGen;
    this.layoutSettleStartedAt = performance.now();
    this.noteLayoutSettleActivity();
    const tryFinish = (): void => {
      if (gen !== this.layoutSettleGen || !this.ready) {
        return;
      }
      const now = performance.now();
      const timedOut =
        now - this.layoutSettleStartedAt >= MessageRing.LAYOUT_SETTLE_MAX_MS;
      const paintsBusy =
        this.viewportPaintRaf !== 0 || this.mediaRepaintRaf !== 0;
      const quietBusy = now < this.layoutSettleQuietUntil;
      if (!timedOut && (paintsBusy || quietBusy)) {
        requestAnimationFrame(tryFinish);
        return;
      }
      requestAnimationFrame(() => {
        if (gen !== this.layoutSettleGen || !this.ready) {
          return;
        }
        const again = performance.now();
        const stillTimedOut =
          again - this.layoutSettleStartedAt >= MessageRing.LAYOUT_SETTLE_MAX_MS;
        if (
          !stillTimedOut &&
          (this.viewportPaintRaf !== 0 ||
            this.mediaRepaintRaf !== 0 ||
            again < this.layoutSettleQuietUntil)
        ) {
          requestAnimationFrame(tryFinish);
          return;
        }
        this.endLayoutSettle();
      });
    };
    requestAnimationFrame(tryFinish);
  }

  private endLayoutSettle(): void {
    const pinned = this.layoutSettlePinned;
    this.layoutSettling = false;
    this.layoutSettlePinned = false;
    this.layoutSettleQuietUntil = 0;
    if (!this.ready) {
      return;
    }
    // Only snap follow if we still own the pin; never kill a user mid-scroll tween.
    if (pinned && this.scroll.atBottom && !this.isPaused()) {
      this.scroll.goToBottom(false);
    }
    this.afterScrollChange();
  }

  private scheduleViewportPaint(): void {
    if (!this.ready || this.viewportPaintRaf !== 0) {
      return;
    }
    this.viewportPaintRaf = requestAnimationFrame(() => {
      this.viewportPaintRaf = 0;
      this.paintSlotsEnteringViewport();
    });
  }

  /** Lazy paintClip for scrollback rows that enter the viewport unpainted. */
  private paintSlotsEnteringViewport(): void {
    if (!this.ready || this.occupied === 0) return;
    let anchors: ReturnType<MessageRing["captureScrollAnchors"]> | undefined;
    const started = performance.now();
    let heightsChanged = false;
    let unfinished = false;
    for (const { owner: slot } of this.viewPool.bindings.values()) {
      if (!slot.msgId || !slot.visible || this.slotWrapValid(slot)) continue;
      if (performance.now() - started > 14) { unfinished = true; break; }
      if (!slot.wrapReady) anchors ??= this.captureScrollAnchors();
      const previous = this.slotPixelHeight(slot);
      this.paintClip(slot);
      if (previous !== this.slotPixelHeight(slot)) heightsChanged = true;
    }
    if (heightsChanged) this.repositionRootsFromCache(anchors);
    else this.applyStageY();
    if (unfinished) this.scheduleViewportPaint();
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
      if (!this.ready) {
        this.scrollRaf = 0;
        return;
      }
      this.withPerfMeasure("crt-scroll-tick", () => {
        const cont = this.scroll.tick(now);
        this.applyStageY();
        this.notifyScroll();
        this.paintSlotsEnteringViewport();
        if (cont && this.ready) {
          this.scrollRaf = requestAnimationFrame(step);
        } else {
          this.scrollRaf = 0;
          this.scheduleViewportPaint();
        }
      });
    };
    this.scrollRaf = requestAnimationFrame(step);
  }

  /** Borrowed geometry; anchors copy values before any row can be changed. */
  private laidSlots(): LaidSlot[] {
    const start = (this.head - this.occupied + this.poolSize) % this.poolSize;
    const gapRows =
      this.lineHeight > 0 ? this.messageGapPx() / this.lineHeight : 0;
    let shown = 0;
    for (let i = 0; i < this.occupied; i += 1) {
      const slot = this.slots[(start + i) % this.poolSize];
      if (this.isSlotHiddenByPrivacy(slot)) {
        continue;
      }
      const row = slot.scrollLayout;
      row.msgId = slot.msgId;
      row.startRow = this.slotScrollRow(slot);
      row.lineCount = this.lineHeight > 0 ? this.slotPixelHeight(slot) / this.lineHeight : 0;
      if (shown > 0) {
        this.laidBuf[shown - 1].lineCount += gapRows;
      }
      this.laidBuf[shown] = row;
      shown += 1;
    }
    this.laidBuf.length = shown;
    return this.laidBuf;
  }

  private applyStageY(): void {
    const stageY = this.scroll.stageY(this.lineHeight);
    this.app.stage.y = stageY;
    const padding = this.lineHeight * 8;
    const top = -stageY - padding;
    const bottom = -stageY + this.app.screen.height + padding;
    const target = this.viewportPaintBand(this.scroll.contentRows * this.lineHeight);
    this.wantedViews.length = 0;
    const start = (this.head - this.occupied + this.poolSize) % this.poolSize;
    for (let i = 0; i < this.occupied; i += 1) {
      const slot = this.slots[(start + i) % this.poolSize];
      if (slot.visible && (this.slotYIntersects(slot, top, bottom) ||
          this.slotYIntersects(slot, target.top, target.bottom))) this.wantedViews.push(slot);
    }
    this.viewPool.sync(this.wantedViews);
    for (const { owner: slot, view } of this.viewPool.bindings.values()) {
      const renderable = slot.visible && view.painted && this.slotYIntersects(slot, top, bottom);
      const entering = renderable && !view.root.renderable;
      view.root.y = slot.y;
      view.root.visible = slot.visible && view.painted;
      view.root.renderable = renderable;
      if (entering) {
        this.lastSanitizeTickerTime = Number.NaN;
        this.refreshMissingSlotMedia(slot);
      }
    }
  }

  renderStats(): { historyRows: number; views: number; boundViews: number } {
    return { historyRows: this.occupied, views: this.viewPool.views.size, boundViews: this.viewPool.bindings.size };
  }

  private refreshMissingSlotMedia(slot: Slot): void {
    const view = this.viewPool.get(slot);
    if (!view) { return; }
    if (view.badgeKeys.some((key, i) => key && !isRenderableTexture(view.badges[i].texture))) {
      this.loadBadgeSprites(slot);
    }
    if (this.enableEmoteImages && view.emoteKeys.some((key, i) => key && !isRenderableTexture(view.emotes[i].texture))) {
      this.repaintSlotMedia(slot);
    }
    if (slot.clipCard?.thumbnailUrl && (!view.clipUi || !isRenderableTexture(view.clipUi.thumb.texture))) {
      this.paintSlotClipCard(slot);
    }
  }

  private notifyScroll(): void {
    this.onScroll?.(this.scroll.snapshot());
  }

  private pointerShiftOnly(ev: FederatedPointerEvent): boolean {
    return ev.shiftKey && !ev.ctrlKey && !ev.altKey && !ev.metaKey;
  }

  private slotInReplyThread(slot: Slot): boolean {
    if (slot.replyToId) {
      return true;
    }
    const msgId = slot.msgId;
    if (!msgId) {
      return false;
    }
    const start = (this.head - this.occupied + this.poolSize) % this.poolSize;
    for (let i = 0; i < this.occupied; i += 1) {
      const other = this.slots[(start + i) % this.poolSize];
      if (other.msgId && other.replyToId === msgId) {
        return true;
      }
    }
    return false;
  }

  private makeSlotContext(
    slot: Slot,
    ev: FederatedPointerEvent,
    opts?: {
      login?: string;
      nick?: string;
      linkUrl?: string;
      imageUrl?: string;
      imageKind?: "" | "emote" | "badge";
      imageProvider?: string;
    },
  ): SlotContext {
    return {
      msgId: slot.msgId,
      channel: this.boundChannel,
      login: opts?.login ?? slot.login,
      authorLogin: slot.login,
      nick: opts?.nick ?? this.contextNick(slot),
      text: slot.copyText || slot.bodyRaw,
      fullText: formatFullCopyText({
        time: slot.timeText,
        nick: slot.nickRaw,
        body: slot.bodySource || slot.copyText,
        copyText: slot.copyText,
        system: slot.system,
        isAction: slot.isAction,
        isWhisper: slot.isWhisper,
        whisperPeer: slot.isWhisper ? this.selfLogin : undefined,
      }),
      clientX: ev.clientX,
      clientY: ev.clientY,
      disabled: slot.disabled,
      replyToId: slot.replyToId,
      linkUrl: opts?.linkUrl ?? "",
      imageUrl: opts?.imageUrl ?? "",
      imageKind: opts?.imageKind ?? "",
      imageProvider: opts?.imageProvider ?? "",
      inReplyThread: this.slotInReplyThread(slot),
      shiftOnly: this.pointerShiftOnly(ev),
    };
  }

  private onSlotTap(slot: Slot, ev: FederatedPointerEvent): void {
    const view = this.viewPool.get(slot);
    if (!view) { return; }
    // Pixi fires pointertap after rightclick; only LMB opens UserCard / links.
    if (ev.button !== 0) {
      return;
    }
    const automodAction = this.automodActionAt(slot, ev);
    if (automodAction && this.onAutomodAction && slot.automodMessageId) {
      this.onAutomodAction(
        automodAction,
        slot.automodMessageId,
        this.makeSlotContext(slot, ev),
      );
      return;
    }
    const modAction = this.modActionAt(slot, ev);
    if (modAction && this.onModAction && slot.login) {
      this.onModAction(modAction, this.makeSlotContext(slot, ev));
      return;
    }
    {
      const local = ev.getLocalPosition(view.root);
      if (slot.clipCard && view.clipUi && clipCardContains(view.clipUi, local.x, local.y)) {
        // Card is layout chrome, not a body link: always single-click open.
        const clipUrl = slot.clipCard.url;
        if (this.onOpenChatLink) {
          this.onOpenChatLink(clipUrl);
          return;
        }
        void invoke("open_chat_link", { url: clipUrl }).catch(() => undefined);
        return;
      }
    }
    if (slot.collapsed && !slot.expanded) {
      slot.expanded = true;
      // Invalidate wrap so layoutInner paints after sealed anchors are captured.
      this.invalidateSlotWrap(slot);
      this.layout();
      return;
    }
    if (this.nickAt(slot, ev) && slot.login && this.onNickClick) {
      this.onNickClick(this.makeSlotContext(slot, ev));
      return;
    }
    const mentionLogin = this.mentionLoginAt(slot, ev);
    if (mentionLogin && this.onNickClick) {
      this.onNickClick(
        this.makeSlotContext(slot, ev, {
          login: mentionLogin,
          nick: mentionLogin,
        }),
      );
      return;
    }
    const url = this.linkAt(slot, ev);
    if (!url) {
      return;
    }
    // Stock links.linksDoubleClickOnly: only links need dblclick; nick stays single.
    // Pixi may leave detail at 0; treat only detail >= 2 as double.
    if (this.linksDoubleClickOnly && !(ev.detail >= 2)) {
      return;
    }
    if (this.onOpenChatLink) {
      this.onOpenChatLink(url);
      return;
    }
    void invoke("open_chat_link", { url }).catch(() => undefined);
  }

  private onSlotContext(slot: Slot, ev: FederatedPointerEvent): void {
    const view = this.viewPool.get(slot);
    if (!view) { return; }
    if (!slot.msgId) {
      return;
    }
    if (this.nickAt(slot, ev) && slot.login && this.onNickRightClick) {
      ev.preventDefault();
      this.onNickRightClick(this.makeSlotContext(slot, ev), ev);
      return;
    }
    const mentionLogin = this.mentionLoginAt(slot, ev);
    if (mentionLogin && this.onNickRightClick) {
      ev.preventDefault();
      this.onNickRightClick(
        this.makeSlotContext(slot, ev, {
          login: mentionLogin,
          nick: mentionLogin,
        }),
        ev,
      );
      return;
    }
    if (!this.onContext) {
      return;
    }
    ev.preventDefault();
    const imageHit = this.imageHitAt(slot, ev);
    this.onContext(
      this.makeSlotContext(slot, ev, {
        linkUrl: (() => {
          const local = ev.getLocalPosition(view.root);
          if (slot.clipCard && view.clipUi && clipCardContains(view.clipUi, local.x, local.y)) {
            return slot.clipCard.url;
          }
          return this.linkAt(slot, ev) ?? "";
        })(),
        imageUrl: imageHit?.url ?? "",
        imageKind: imageHit?.kind ?? "",
        imageProvider: imageHit?.provider ?? "",
      }),
    );
  }

  private onSlotMove(slot: Slot, ev: FederatedPointerEvent): void {
    const view = this.viewPool.get(slot);
    if (!view) { return; }
    if (slot.systemCloudBounds && slot.msgId) {
      const local = ev.getLocalPosition(view.root);
      if (this.pointInSystemCloud(slot, local.x, local.y)) {
        this.setHoveredMsgId(slot.msgId);
      } else if (this.hoveredMsgId === slot.msgId && !this.hoverGuard?.()) {
        this.clearHover();
      }
    }
    if (this.automodActionAt(slot, ev) || this.modActionAt(slot, ev)) {
      view.root.cursor = "pointer";
      return;
    }
    if (this.nickAt(slot, ev) && slot.login) {
      view.root.cursor = "pointer";
      return;
    }
    if (this.mentionLoginAt(slot, ev)) {
      view.root.cursor = "pointer";
      return;
    }
    {
      const local = ev.getLocalPosition(view.root);
      if (slot.clipCard && view.clipUi && clipCardContains(view.clipUi, local.x, local.y)) {
        view.root.cursor = "pointer";
        return;
      }
    }
    if (slot.collapsed && !slot.expanded) {
      view.root.cursor = "pointer";
      return;
    }
    view.root.cursor = this.linkAt(slot, ev) ? "pointer" : "default";
  }

  private showModGutter(slot: MessageRow): boolean {
    if (!this.moderationMode || !this.canModerate) {
      return false;
    }
    if (!slot.collapsible || !slot.login || slot.system) {
      return false;
    }
    if (slot.automodMessageId) {
      return false;
    }
    if (this.selfLogin && slot.login === this.selfLogin) {
      return false;
    }
    return true;
  }

  /** Left moderation buttons; returns gutter width in px. */
  private paintModGutter(slot: Slot): number {
    const view = this.viewPool.get(slot);
    if (!view) { return 0; }
    view.modBtnHits = [];
    for (const mt of view.modBtns) {
      mt.visible = false;
    }
    for (const spr of view.modIcons) {
      spr.visible = false;
    }
    if (!this.showModGutter(slot)) {
      this.resizeMediaSprites(slot, view.modIcons, 0);
      return 0;
    }
    this.resizeMediaSprites(slot, view.modIcons, MOD_GUTTER_ICON_COUNT);
    const actions = modGutterActions();
    const iconSize = Math.max(14, Math.round(this.fontSize * 1.05));
    const padX = Math.max(2, Math.round(2 * this.fontScale));
    const btnGap = Math.max(4, Math.round(4 * this.fontScale));
    const color = "#ffaa88";
    let x = 0;
    for (let i = 0; i < MOD_GUTTER_ICON_COUNT; i += 1) {
      const action = actions[i];
      const spr = view.modIcons[i];
      if (!action || !spr) {
        continue;
      }
      const kind = action.label === "clock" ? "clock" : "ban";
      const tex = modGutterIconTexture(kind, iconSize, color);
      if (!isRenderableTexture(tex)) {
        spr.visible = false;
        continue;
      }
      applySpriteTexture(spr, tex, iconSize, iconSize);
      spr.x = x + padX;
      spr.y = this.lineMediaY(0, iconSize);
      const btnW = iconSize + padX * 2;
      view.modBtnHits.push({
        x0: x,
        x1: x + btnW,
        action: action.action,
      });
      x += btnW + btnGap;
    }
    return x > 0 ? Math.max(0, x - btnGap) : 0;
  }

  private modActionAt(slot: Slot, ev: FederatedPointerEvent): string | null {
    const view = this.viewPool.get(slot);
    if (!view) { return null; }
    if (view.modBtnHits.length === 0) {
      return null;
    }
    const local = ev.getLocalPosition(view.root);
    const y0 = slot.replyRows * this.lineHeight;
    if (local.y < y0 || local.y >= y0 + this.lineHeight) {
      return null;
    }
    for (const hit of view.modBtnHits) {
      if (local.x >= hit.x0 && local.x < hit.x1) {
        return hit.action;
      }
    }
    return null;
  }

  private automodActionAt(
    slot: Slot,
    ev: FederatedPointerEvent,
  ): "allow" | "deny" | null {
    const view = this.viewPool.get(slot);
    if (!view) { return null; }
    if (view.automodBtnHits.length === 0) {
      return null;
    }
    const local = ev.getLocalPosition(view.root);
    for (const hit of view.automodBtnHits) {
      if (
        local.x >= hit.x0 &&
        local.x < hit.x1 &&
        local.y >= hit.y0 &&
        local.y < hit.y1
      ) {
        return hit.action;
      }
    }
    return null;
  }

  private nickAt(slot: Slot, ev: FederatedPointerEvent): boolean {
    const view = this.viewPool.get(slot);
    if (!view) { return false; }
    if (!slot.login || slot.system || !slot.useNickStyle) {
      return false;
    }
    const local = ev.getLocalPosition(view.root);
    const nickW = Math.max(
      this.measureBitmapTextWidth("ChatNickFont", view.nick.text),
      8,
    );
    const y0 = slot.replyRows * this.lineHeight;
    return (
      local.x >= view.nick.x &&
      local.x < view.nick.x + nickW &&
      local.y >= y0 &&
      local.y < y0 + this.lineHeight
    );
  }

  private applyNickPaintChrome(slot: Slot, contentY: number): number {
    const view = this.viewPool.get(slot);
    if (!view) return Math.max(this.measureBitmapTextWidth("ChatNickFont", slot.nickText), 8);
    view.nickPaint = slot.nickPaint;
    return this.nickPaintResources.apply(view, contentY, {
      fontFamily: this.chatFontFamily,
      fontWeight: qtWeightToCss(this.nickBoldScale),
      fontSize: this.fontSize,
      measure: (text) => this.measureBitmapTextWidth("ChatNickFont", text),
    });
  }

  private bodyIndexAt(slot: Slot, localX: number, localY: number): number | null {
    return bodyIndexAt(slot, localX, localY, {
      lineHeight: this.lineHeight,
      fontSize: this.fontSize,
      bodyHeight: () => this.slotBodyPixelHeight(slot),
      wrapOptions: (cloud, size) => this.wrapOpts(slot, cloud ? [] : undefined, undefined, size),
    });
  }

  private pointInSystemCloud(slot: Slot, x: number, y: number): boolean {
    return inside(slot.systemCloudBounds, x, y);
  }

  private mentionLoginAt(slot: Slot, ev: FederatedPointerEvent): string | null {
    const view = this.viewPool.get(slot);
    if (!view) { return null; }
    if (slot.mentionSpans.length === 0) {
      return null;
    }
    const local = ev.getLocalPosition(view.root);
    const idx = this.bodyIndexAt(slot, local.x, local.y);
    if (idx === null) {
      return null;
    }
    const hit = slot.mentionSpans.find(
      (span) => idx >= span.start && idx < span.end,
    );
    return hit?.login ?? null;
  }

  private linkAt(slot: Slot, ev: FederatedPointerEvent): string | undefined {
    const view = this.viewPool.get(slot);
    if (!view) { return undefined; }
    const local = ev.getLocalPosition(view.root);
    const idx = this.bodyIndexAt(slot, local.x, local.y);
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
    const y = localY - stageY;
    if (y < 0) {
      return null;
    }
    const start = (this.head - this.occupied + this.poolSize) % this.poolSize;
    for (let i = 0; i < this.occupied; i += 1) {
      const slot = this.slots[(start + i) % this.poolSize];
      const view = this.viewPool.get(slot);
      if (!view?.painted) continue;
      if (!slot.msgId || !slot.visible) {
        continue;
      }
      if (slot.disabled && this.hideModerated) {
        continue;
      }
      const top = slot.y;
      const h = this.slotPixelHeight(slot);
      if (y < top || y >= top + h) {
        continue;
      }
      const slotLocalY = y - top;
      const badgeVisible = this.visibleBadges(slot);
      for (let b = 0; b < view.badges.length; b += 1) {
        const spr = view.badges[b];
        const badge = badgeVisible[b];
        if (!badge || !spr.visible) {
          continue;
        }
        if (!spriteHit(localX, slotLocalY, spr)) {
          continue;
        }
        return {
          text: badge.tooltip ?? badgeTooltipText(badge.set),
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

  /** Hit-test emote/badge под курсором для context menu (stock addImageContextMenuItems). */
  private imageHitAt(slot: Slot, ev: FederatedPointerEvent): ImageHit | null {
    const view = this.viewPool.get(slot);
    if (!view) { return null; }
    const local = ev.getLocalPosition(view.root);
    const localX = local.x;
    const slotLocalY = local.y;
    const badgeVisible = this.visibleBadges(slot);
    for (let b = 0; b < view.badges.length; b += 1) {
      const spr = view.badges[b];
      const badge = badgeVisible[b];
      if (!badge?.url || !spr.visible) {
        continue;
      }
      if (!spriteHit(localX, slotLocalY, spr)) {
        continue;
      }
      return { url: badge.url, kind: "badge", provider: badge.source };
    }
    if (this.enableEmoteImages) {
      for (let e = view.emotes.length - 1; e >= 0; e -= 1) {
        const spr = view.emotes[e];
        const span = slot.spansRaw[e];
        if (!span || !spr.visible) {
          continue;
        }
        if (!spriteHit(localX, slotLocalY, spr)) {
          continue;
        }
        const url = this.emoteLoadUrl(span);
        if (!url) {
          return null;
        }
        return { url, kind: "emote", provider: span.provider };
      }
      return null;
    }
    if (
      localX < 0 ||
      slotLocalY < 0 ||
      slotLocalY >= this.slotPixelHeight(slot)
    ) {
      return null;
    }
    const idx = this.bodyIndexAt(slot, localX, slotLocalY);
    if (idx === null) {
      return null;
    }
    for (const span of slot.spansRaw) {
      if (idx >= span.start && idx < span.end) {
        const url = this.emoteLoadUrl(span);
        if (!url) {
          return null;
        }
        return { url, kind: "emote", provider: span.provider };
      }
    }
    return null;
  }

  private emoteTooltipAt(
    slot: Slot,
    localX: number,
    slotLocalY: number,
  ): TooltipHit | null {
    const view = this.viewPool.get(slot);
    if (!view) { return null; }
    if (this.enableEmoteImages) {
      for (let e = view.emotes.length - 1; e >= 0; e -= 1) {
        const spr = view.emotes[e];
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
      localX < 0 ||
      slotLocalY < 0 ||
      slotLocalY >= this.slotPixelHeight(slot)
    ) {
      return null;
    }
    const idx = this.bodyIndexAt(slot, localX, slotLocalY);
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
      localX < 0 ||
      slotLocalY < 0 ||
      slotLocalY >= this.slotPixelHeight(slot)
    ) {
      return null;
    }
    const idx = this.bodyIndexAt(slot, localX, slotLocalY);
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

  /** Hover quick-actions / reply: screen rect of privmsg under pointer. */
  messageAnchorAt(clientX: number, clientY: number): {
    msgId: string;
    login: string;
    text: string;
    top: number;
    right: number;
    canReply: boolean;
  } | null {
    if (!this.ready) {
      return null;
    }
    void clientX;
    const canvas = this.app.canvas as HTMLCanvasElement;
    const rect = canvas.getBoundingClientRect();
    const localY = clientY - rect.top;
    const stageY = this.app.stage.y;
    const y = localY - stageY;
    if (y < 0) {
      return null;
    }
    const start = (this.head - this.occupied + this.poolSize) % this.poolSize;
    for (let i = 0; i < this.occupied; i += 1) {
      const slot = this.slots[(start + i) % this.poolSize];
      if (!slot.msgId || !slot.visible || slot.system || !slot.login) {
        continue;
      }
      if (slot.disabled && this.hideModerated) {
        continue;
      }
      const top = slot.y;
      const height = this.slotPixelHeight(slot);
      if (y >= top && y < top + height + this.messageGapPx()) {
        return {
          msgId: slot.msgId,
          login: slot.login,
          text: slot.copyText || slot.bodyRaw,
          top: rect.top + stageY + top,
          right: rect.right - 8,
          canReply:
            this.showReplyButton &&
            !slot.disabled &&
            Boolean(slot.login) &&
            Boolean(slot.msgId),
        };
      }
    }
    return null;
  }

  messageTopInViewport(msgId: string): number | null {
    const slot = this.findSlotByMsgId(msgId);
    return slot?.visible ? slot.y + this.app.stage.y : null;
  }

  /** Build SlotContext for a message id (quick-actions "more"). */
  contextForMsgId(msgId: string, clientX: number, clientY: number): SlotContext | null {
    const slot = this.findSlotByMsgId(msgId);
    if (!slot || !slot.msgId) {
      return null;
    }
    return {
      msgId: slot.msgId,
      channel: this.boundChannel,
      login: slot.login,
      authorLogin: slot.login,
      nick: this.contextNick(slot),
      text: slot.copyText || slot.bodyRaw,
      fullText: formatFullCopyText({
        time: slot.timeText,
        nick: slot.nickRaw,
        body: slot.bodySource || slot.copyText,
        copyText: slot.copyText,
        system: slot.system,
        isAction: slot.isAction,
        isWhisper: slot.isWhisper,
        whisperPeer: slot.isWhisper ? this.selfLogin : undefined,
      }),
      clientX,
      clientY,
      disabled: slot.disabled,
      replyToId: slot.replyToId,
      linkUrl: "",
      imageUrl: "",
      imageKind: "",
      imageProvider: "",
      inReplyThread: this.slotInReplyThread(slot),
      shiftOnly: false,
    };
  }

  /** @deprecated prefer messageAnchorAt */
  replyAnchorAt(clientX: number, clientY: number): {
    msgId: string;
    login: string;
    text: string;
    top: number;
    right: number;
  } | null {
    if (!this.showReplyButton) {
      return null;
    }
    const a = this.messageAnchorAt(clientX, clientY);
    if (!a?.canReply) {
      return null;
    }
    return {
      msgId: a.msgId,
      login: a.login,
      text: a.text,
      top: a.top,
      right: a.right,
    };
  }

  isReplyButtonEnabled(): boolean {
    return this.showReplyButton;
  }

  private messageGapPx(): number {
    return Math.max(2, Math.round(MESSAGE_GAP * this.fontScale));
  }

  private slotScrollRow(slot: Slot): number {
    return this.lineHeight > 0 ? slot.y / this.lineHeight : 0;
  }

  private emotePixelSize(fontSize: number = this.fontSize): number {
    return Math.max(
      1,
      Math.round(chatTextRowHeight(fontSize) * this.emoteScale),
    );
  }

  private emotePaintSize(
    span: EmoteSpan,
    fontSize: number = this.fontSize,
  ): { w: number; h: number } {
    return emoteDisplaySize(span, this.emotePixelSize(fontSize));
  }

  /** Body glyph size for a slot (cloud pills use fontSize − delta). */
  private slotBodyFontSize(slot: Slot): number {
    return slot.systemCloudBounds?.fontSize ?? this.fontSize;
  }

  private emoteLoadUrl(span: EmoteSpan): string {
    if (span.provider === "emoji") {
      return resolveEmojiUrl(span.emoteId, this.emojiSet);
    }
    return span.url;
  }

  private wrapOpts(
    slot?: MessageRow,
    maskMentions?: readonly MentionSpan[],
    firstLineMaxWidthPx?: number,
    fontSize: number = this.fontSize,
  ): WrapOptions {
    const images = this.enableEmoteImages;
    const emoteMinPx = images ? this.emotePixelSize(fontSize) : 0;
    const chrome = this.boldUsernames || this.colorUsernames;
    const mentions =
      slot && chrome && slot.mentionSpans.length > 0
        ? (maskMentions ?? slot.mentionSpans)
        : undefined;
    const cache = new Map<string, number>();
    const measureAdvance = (slice: string): number => {
      if (!slice) {
        return 0;
      }
      const hit = cache.get(slice);
      if (hit !== undefined) {
        return hit;
      }
      const w = this.measureBitmapTextWidth("ChatFont", slice, fontSize);
      cache.set(slice, w);
      return w;
    };
    const nickCache = new Map<string, number>();
    const measureMentionAdvance = this.boldUsernames
      ? (slice: string): number => {
          if (!slice) {
            return 0;
          }
          const hit = nickCache.get(slice);
          if (hit !== undefined) {
            return hit;
          }
          const w = this.measureBitmapTextWidth("ChatNickFont", slice, fontSize);
          nickCache.set(slice, w);
          return w;
        }
      : undefined;
    return {
      emoteMinPx,
      measureAdvance,
      measureMentionAdvance,
      maskEmotes: images,
      enableZeroWidth: images && this.enableZeroWidthEmotes,
      removeSpacesBetweenEmotes: images && this.removeSpacesBetweenEmotes,
      maskMentions: mentions,
      firstLineMaxWidthPx,
    };
  }

  private reloadVisibleEmotes(): void {
    const start = (this.head - this.occupied + this.poolSize) % this.poolSize;
    for (let i = 0; i < this.occupied; i += 1) {
      const slot = this.slots[(start + i) % this.poolSize];
      const view = this.viewPool.get(slot);
      if (!view) continue;
      if (!slot.msgId) {
        continue;
      }
      for (const spr of view.emotes) {
        spr.visible = false;
        spr.texture = Texture.EMPTY;
      }
      for (const key of view.emoteKeys) {
        if (key) {
          this.textures.release(key);
        }
      }
      this.resizeMediaSprites(slot, view.emotes, this.enableEmoteImages ? Math.min(slot.spansRaw.length, EMOTE_SLOTS_PER_ROW) : 0);
      view.emoteKeys = new Array(view.emotes.length).fill("");
      if (!this.enableEmoteImages) {
        continue;
      }
      const msgId = slot.msgId;
      for (let e = 0; e < view.emotes.length; e += 1) {
        const span = slot.spansRaw[e];
        if (!span || span.provider === "cheer-mask") {
          continue;
        }
        this.scheduleEmoteLoad(slot, e, span, msgId);
      }
    }
  }

  private snapEmotesToFirstFrame(): void {
    const start = (this.head - this.occupied + this.poolSize) % this.poolSize;
    for (let i = 0; i < this.occupied; i += 1) {
      const slot = this.slots[(start + i) % this.poolSize];
      const view = this.viewPool.get(slot);
      if (!view) continue;
      for (let e = 0; e < view.emotes.length; e += 1) {
        const key = view.emoteKeys[e];
        if (!key) {
          continue;
        }
        const spr = view.emotes[e];
        const span = slot.spansRaw[e];
        const tex = this.textures.frameAt(key, 0) ?? this.textures.get(key);
        if (isRenderableTexture(tex) && spr.visible && span) {
          const paint = this.emotePaintSize(span, this.slotBodyFontSize(slot));
          applySpriteTexture(spr, tex, paint.w, paint.h);
        } else if (spr.visible && !isRenderableTexture(spr.texture)) {
          cleanseSpriteTexture(spr);
        }
      }
    }
  }

  private tickEmoteFrames(): void {
    if (!this.ready || !this.animateEmotes || !this.enableEmoteImages) {
      return;
    }
    const pos = this.emoteTicker.position();
    const start = (this.head - this.occupied + this.poolSize) % this.poolSize;
    for (let i = 0; i < this.occupied; i += 1) {
      const slot = this.slots[(start + i) % this.poolSize];
      const view = this.viewPool.get(slot);
      if (!view) continue;
      if (!slot.visible) {
        continue;
      }
      for (let e = 0; e < view.emotes.length; e += 1) {
        const key = view.emoteKeys[e];
        if (!key || !this.textures.isAnimated(key)) {
          continue;
        }
        const spr = view.emotes[e];
        const span = slot.spansRaw[e];
        if (!spr.visible || !span) {
          continue;
        }
        const tex = this.textures.frameAt(key, pos);
        if (isRenderableTexture(tex) && spr.texture !== tex) {
          const paint = this.emotePaintSize(span, this.slotBodyFontSize(slot));
          applySpriteTexture(spr, tex, paint.w, paint.h);
        } else if (!isRenderableTexture(spr.texture)) {
          cleanseSpriteTexture(spr);
        }
      }
    }
  }
}

/** Force BitmapText GPU rebuild after BitmapFont.uninstall (same text/size skips update). */
function dirtyBitmapText(bt: BitmapText): void {
  const prev = bt.text;
  bt.text = prev.length > 0 ? "" : " ";
  bt.text = prev;
}

/** Pixi Cache.get warns if the key is missing; uninstall always gets first. */
function replaceBitmapFont(
  name: string,
  options: Parameters<typeof BitmapFont.install>[0],
): void {
  if (Cache.has(`${name}-bitmap`)) {
    BitmapFont.uninstall(name);
  }
  BitmapFont.install(options);
}

export function formatTime(ms: number, format: string): string {
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

function applySpriteTexture(
  spr: Sprite,
  tex: Texture,
  width: number,
  height: number,
): void {
  if (!isRenderableTexture(tex)) {
    spr.visible = false;
    spr.texture = Texture.EMPTY;
    return;
  }
  spr.visible = true;
  spr.texture = tex;
  spr.width = width;
  spr.height = height;
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
