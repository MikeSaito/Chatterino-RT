import {
  BitmapFont,
  BitmapFontManager,
  BitmapText,
  Cache,
  Container,
  FederatedPointerEvent,
  Graphics,
  Rectangle,
  Sprite,
  TextStyle,
  Texture,
  type Application,
} from "pixi.js";
import { invoke } from "@tauri-apps/api/core";
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
  AutomodRange,
  Badge,
  ChatEvent,
  EmoteSpan,
  LinkSpan,
  MentionSpan,
  NickPaint,
  UsernoticeParams,
} from "./types";
import {
  paintCacheKey,
  paintRepresentativeRgb,
  rasterizeNickPaint,
} from "./nickPaint";
import {
  clearchatFormatted,
  deletionNoticeText,
  formatReplyHeader,
  noticeFormatted,
  usernoticeFormatted,
  whisperPrefix,
} from "./chatSystemText";
import { t } from "../i18n/index.ts";
import { resolveEmojiUrl } from "./emoteUrl";
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
  hideClipCard,
  paintClipCard,
  releaseClipThumb,
  type ClipCardWidgets,
} from "./clipCardPixi";
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
  lineColToIndex,
  renderWrapped,
  withCollapsedEllipsis,
  wrapBody,
  wrapLineOriginX,
  type WrapLine,
  type WrapOptions,
} from "./wrap";

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

type Slot = {
  root: Container;
  highlight: Graphics;
  systemCloud: Graphics;
  mentions: Graphics;
  disabledGfx: Graphics;
  time: BitmapText;
  nick: BitmapText;
  /** Gradient nick overlay (7TV paint); BitmapText hidden when visible. */
  nickPaintSpr: Sprite;
  nickPaint: NickPaint | null;
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
  badgesRaw: Badge[];
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
  automodMessageId: string;
  automodStatus: string;
  automodCaught: AutomodRange[];
  caughtTexts: BitmapText[];
  clipUi: ClipCardWidgets;
  msgId: string;
  login: string;
  /** Текст до host-display transform (whisper/action lead). */
  bodySource: string;
  /** Painted body (may lowercase link hosts). */
  bodyRaw: string;
  nickRaw: string;
  copyText: string;
  replyToId: string;
  timestampMs: number;
  spansRaw: EmoteSpan[];
  linkSpans: LinkSpan[];
  hostSpans: HostSpanRange[];
  mentionSpans: MentionSpan[];
  clipCard: ClipCardInfo | null;
  clipCardRows: number;
  /** True after title/host rewrite; displayBody must not rebuild from bodySource. */
  linkEnriched: boolean;
  wrapLines: WrapLine[];
  /** false until paintClip finishes metrics for current bodyRaw. */
  wrapReady: boolean;
  lineCount: number;
  /** Pixel origin of first body wrap line (ceil-aligned to char grid). */
  bodyIndent: number;
  /** Pixel origin of wrap lines 2+ (under timestamp / after mod gutter). */
  bodyContIndent: number;
  /** Left-aligned system cloud bounds (null when not a cloud). */
  systemCloudBounds: {
    x: number;
    y: number;
    w: number;
    h: number;
    radius: number;
  } | null;
  /** Rows occupied by reply header above the main line. */
  replyRows: number;
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
  replyToText: string;
  isAction: boolean;
  isWhisper: boolean;
  /** Символы до reply/action + copyText (Whisper: / system lead usernotice). */
  leadLen: number;
  /** Rebuild CLEARCHAT/CLEARMSG/USERNOTICE/NOTICE body on locale change. */
  systemTextKind: "" | "clearchat" | "clearmsg" | "usernotice" | "notice";
  clearLogin: string;
  clearDurationSec: number | undefined;
  clearStackCount: number;
  clearmsgBody: string;
  usernoticeMsgId: string;
  usernoticeSystemText: string;
  usernoticeLogin: string;
  usernoticeParams: UsernoticeParams | null;
  /** Attached USERNOTICE privmsg body (action prefix included); survives locale switch. */
  usernoticeInnerBody: string;
  noticeMsgId: string;
  noticeFallback: string;
  noticeTimeoutSec: number | undefined;
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
  private readonly poolSize: number;
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
  /** Live msg ids this channel session (survive gap recovery snapshot). */
  private liveMsgIds = new Set<string>();
  private showReplyButton = true;
  private moderationMode = false;
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
  private readonly nickPaintTextures = new Map<string, Texture>();
  private readonly nickPaintTextureOrder: string[] = [];
  private static readonly NICK_PAINT_LRU = 64;
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
    this.emoteTicker.subscribe(() => this.tickEmoteFrames());
    this.perfOn =
      import.meta.env.DEV === true ||
      (typeof localStorage !== "undefined" &&
        localStorage.getItem("crt-debug") === "1");
  }

  setOnScroll(cb: (state: ScrollSnapshot) => void): void {
    this.onScroll = cb;
  }


  peekLinkEnrichment(msgId: string): {
    bodySource: string;
    links: LinkSpan[];
    spans: EmoteSpan[];
    mentions: MentionSpan[];
  } | null {
    const slot = this.findSlotByMsgId(msgId);
    if (!slot || !slot.bodySource || slot.linkSpans.length === 0) {
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
    slot.bodyRaw = payload.body;
    slot.linkSpans = payload.links;
    slot.hostSpans = payload.hosts;
    slot.spansRaw = payload.spans;
    slot.mentionSpans = payload.mentions;
    slot.clipCard = payload.clip;
    slot.clipCardRows = payload.clip ? clipCardRowCount(this.lineHeight) : 0;
    slot.linkEnriched = true;
    // Only this row needs wrap recompute; dual-anchor layout preserves scroll.
    slot.wrapReady = false;
    this.layout(undefined, new Set([slot]));
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

  private visibleBadges(slot: Slot): Badge[] {
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
      let lineCountChanged = false;
      for (const s of batch) {
        if (!s.msgId || !s.root.visible) {
          continue;
        }
        const prev = s.lineCount;
        this.repositionSlotMedia(s);
        if (s.lineCount !== prev) {
          lineCountChanged = true;
        }
      }
      if (lineCountChanged) {
        this.repositionRootsFromCache(anchors);
      }
    });
  }

  /**
   * After texture load: refresh emote/badge placement without re-wrapping body.
   * Falls back to paintClip only when wrap metrics are missing.
   */
  private repositionSlotMedia(slot: Slot): void {
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
    for (const mt of slot.modBtns) {
      if (mt.visible) {
        mt.y = contentY;
      }
    }
    for (const spr of slot.modIcons) {
      if (spr.visible) {
        spr.y = this.lineMediaY(contentY, spr.height || this.fontSize);
      }
    }
    const badgeVisible = this.visibleBadges(slot);
    for (let i = 0; i < slot.badges.length; i += 1) {
      const spr = slot.badges[i];
      const badge = badgeVisible[i];
      if (!badge) {
        spr.visible = false;
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
    let bitsLabelShown = false;
    for (let i = 0; i < slot.emotes.length; i += 1) {
      const spr = slot.emotes[i];
      const span = slot.spansRaw[i];
      if (!span || !this.enableEmoteImages || span.provider === "cheer-mask") {
        spr.visible = false;
        continue;
      }
      const paint = this.emotePaintSize(span);
      const zw = this.enableZeroWidthEmotes && span.zeroWidth === true;
      if (zw && hasPrev) {
        spr.visible = true;
        spr.x = prevX;
        spr.y = prevY;
        if (spr.texture !== Texture.EMPTY) {
          applySpriteTexture(spr, spr.texture, paint.w, paint.h);
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
      spr.x =
        wrapLineOriginX(firstOriginX, pos.line, contOriginX) + pos.col;
      spr.y = this.lineMediaY(contentY, paint.h, pos.line);
      if (spr.texture !== Texture.EMPTY) {
        applySpriteTexture(spr, spr.texture, paint.w, paint.h);
      }
      prevX = spr.x;
      prevY = spr.y;
      hasPrev = true;
      if (
        !bitsLabelShown &&
        this.stackBits &&
        span.bitsAmount != null &&
        span.bitsAmount > 0 &&
        span.bitsColor
      ) {
        const tint = parseCheerColor(span.bitsColor);
        if (tint != null) {
          slot.bitsLabel.visible = true;
          slot.bitsLabel.text = ` ${span.bitsAmount}`;
          slot.bitsLabel.tint = tint;
          slot.bitsLabel.x = spr.x + paint.w + 2;
          slot.bitsLabel.y = contentY + pos.line * this.lineHeight;
          bitsLabelShown = true;
        }
      }
    }
    if (!bitsLabelShown) {
      slot.bitsLabel.visible = false;
      slot.bitsLabel.text = "";
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
    const start = (this.head - this.occupied + this.poolSize) % this.poolSize;
    const visible: Slot[] = [];
    for (let i = 0; i < this.occupied; i += 1) {
      const slot = this.slots[(start + i) % this.poolSize];
      const live = slot.msgId.length > 0;
      const show = live && !(this.hideModerated && slot.disabled);
      slot.root.visible = show;
      if (show) {
        visible.push(slot);
      }
    }
    const gapPx = this.messageGapPx();
    let y = 0;
    for (let i = 0; i < visible.length; i += 1) {
      const slot = visible[i];
      slot.startRow = i;
      slot.root.y = y;
      y += slot.lineCount * this.lineHeight;
      if (i + 1 < visible.length) {
        y += gapPx;
      }
    }
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

  private loadBadgeSprites(slot: Slot): void {
    for (const key of slot.badgeKeys) {
      if (key) {
        this.textures.release(key);
      }
    }
    slot.badgeKeys = new Array(slot.badges.length).fill("");
    for (const spr of slot.badges) {
      spr.visible = false;
      spr.texture = Texture.EMPTY;
    }
    const visible = this.visibleBadges(slot);
    const msgId = slot.msgId;
    for (let i = 0; i < slot.badges.length; i += 1) {
      const spr = slot.badges[i];
      const badge = visible[i];
      if (!badge || !badge.url) {
        continue;
      }
      const key = `badge:${badge.url}`;
      slot.badgeKeys[i] = key;
      this.textures.acquire(key);
      void this.textures.load(key, badge.url, false).then((tex) => {
        if (tex && slot.msgId === msgId && slot.badgeKeys[i] === key) {
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
      if (!slot.msgId) {
        continue;
      }
      if (slot.disabled && this.hideModerated) {
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
      this.clearNickPaintTextures();
      this.reinstallNickFont();
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
      slot.nick.style.fontFamily = "ChatNickFont";
      slot.nick.style.fontSize = this.fontSize;
      if (slot.useNickStyle) {
        slot.nickRaw = this.paintedNick(slot.nickLogin, slot.nickDisplay);
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
          releaseClipThumb(slot.clipUi, this.textures);
          hideClipCard(slot.clipUi);
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
      slot.time.style.fill = this.themeFills.timestamp;
      slot.body.style.fill = this.themeFills.body;
      slot.bodyCont.style.fill = this.themeFills.body;
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
      dirtyBitmapText(slot.bodyCont);
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
    this.chatFontFamily = family;
    this.chatFontSize = size;
    this.chatFontWeight = weight;
    if (!changed && this.atlasDesignSize > 0) {
      return;
    }
    this.clearNickPaintTextures();
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
    showReplyButton = true,
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
    const occStart = (this.head - this.occupied + this.poolSize) % this.poolSize;
    for (let i = 0; i < this.occupied; i += 1) {
      const slot = this.slots[(occStart + i) % this.poolSize];
      if (slot.msgId && slot.timestampMs) {
        slot.time.text = formatTime(slot.timestampMs, this.timestampFormat);
      }
      for (const spr of slot.badges) {
        spr.y = this.lineMediaY(0, this.badgeSize);
        if (spr.visible && spr.texture !== Texture.EMPTY) {
          applySpriteTexture(spr, spr.texture, this.badgeSize, this.badgeSize);
        }
      }
      for (let e = 0; e < slot.emotes.length; e += 1) {
        const spr = slot.emotes[e];
        const span = slot.spansRaw[e];
        if (spr.visible && spr.texture !== Texture.EMPTY && span) {
          const paint = this.emotePaintSize(span);
          applySpriteTexture(spr, spr.texture, paint.w, paint.h);
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

  /**
   * Width of painted BitmapText (measurement units × layout.scale).
   * Canvas measureTextWidth drifts from ChatFont/ChatNickFont advances.
   */
  private measureBitmapTextWidth(fontFamily: string, text: string): number {
    if (!text) {
      return 0;
    }
    try {
      const style = new TextStyle({
        fontFamily,
        fontSize: this.fontSize,
        fill: "#ffffff",
      });
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
      this.fontSize,
      text,
    );
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
    const start = (this.head - this.occupied + this.poolSize) % this.poolSize;
    for (let i = 0; i < this.occupied; i += 1) {
      const slot = this.slots[(start + i) % this.poolSize];
      slot.time.style.fontSize = this.fontSize;
      slot.time.style.lineHeight = this.lineHeight;
      slot.nick.style.fontFamily = "ChatNickFont";
      slot.nick.style.fontSize = this.fontSize;
      slot.nick.style.lineHeight = this.lineHeight;
      slot.body.style.fontSize = this.fontSize;
      slot.body.style.lineHeight = this.lineHeight;
      slot.bodyCont.style.fontSize = this.fontSize;
      slot.bodyCont.style.lineHeight = this.lineHeight;
      slot.replyHeader.style.fontSize = Math.max(
        8,
        Math.round(this.fontSize * 0.85),
      );
      slot.replyHeader.style.fill = this.themeFills.timestamp;
      for (const mt of slot.mentionTexts) {
        mt.style.fontSize = this.fontSize;
        mt.style.lineHeight = this.lineHeight;
      }
      for (const ht of slot.hostTexts) {
        ht.style.fontSize = this.fontSize;
        ht.style.lineHeight = this.lineHeight;
        ht.style.fill = this.themeFills.timestamp;
      }
      for (const mt of slot.modBtns) {
        mt.style.fontSize = this.fontSize;
        mt.style.lineHeight = this.lineHeight;
      }
      slot.bitsLabel.style.fontSize = this.fontSize;
      slot.bitsLabel.style.lineHeight = this.lineHeight;
      if (forceDirty && slot.msgId) {
        dirtyBitmapText(slot.time);
        dirtyBitmapText(slot.nick);
        dirtyBitmapText(slot.body);
        dirtyBitmapText(slot.bodyCont);
        dirtyBitmapText(slot.replyHeader);
        for (const mt of slot.mentionTexts) {
          dirtyBitmapText(mt);
        }
        for (const ht of slot.hostTexts) {
          dirtyBitmapText(ht);
        }
        for (const mt of slot.modBtns) {
          dirtyBitmapText(mt);
        }
        dirtyBitmapText(slot.bitsLabel);
      }
    }
  }

  private reinstallChatFont(): void {
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
  }

  scrollSnapshot(): ScrollSnapshot {
    return this.scroll.snapshot();
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

  async init(): Promise<void> {
    if (this.ready) {
      return;
    }
    this.reinstallChatFont();
    this.refreshFontMetrics();
    const stage = this.app.stage;
    stage.eventMode = "static";
    for (let i = 0; i < this.poolSize; i += 1) {
      const root = new Container();
      root.visible = false;
      root.eventMode = "static";
      root.hitArea = new Rectangle(0, 0, 1, this.lineHeight);
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
          fontSize: this.fontSize,
          lineHeight: this.lineHeight,
          fill: this.themeFills.timestamp,
        },
      });
      const nick = new BitmapText({
        text: "",
        style: {
          fontFamily: "ChatNickFont",
          fontSize: this.fontSize,
          lineHeight: this.lineHeight,
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
          fontSize: this.fontSize,
          fill: this.themeFills.body,
          lineHeight: this.lineHeight,
        },
      });
      body.eventMode = "none";
      const bodyCont = new BitmapText({
        text: "",
        style: {
          fontFamily: "ChatFont",
          fontSize: this.fontSize,
          fill: this.themeFills.body,
          lineHeight: this.lineHeight,
        },
      });
      bodyCont.visible = false;
      bodyCont.eventMode = "none";
      const replyHeader = new BitmapText({
        text: "",
        style: {
          fontFamily: "ChatFont",
          fontSize: Math.max(8, Math.round(this.fontSize * 0.85)),
          fill: this.themeFills.timestamp,
        },
      });
      replyHeader.visible = false;
      replyHeader.eventMode = "none";
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
            lineHeight: this.lineHeight,
            fill: 0xffffff,
          },
        });
        mt.visible = false;
        mt.eventMode = "none";
        mentionTexts.push(mt);
      }
      const hostTexts: BitmapText[] = [];
      for (let h = 0; h < MENTION_SLOTS_PER_ROW; h += 1) {
        const ht = new BitmapText({
          text: "",
          style: {
            fontFamily: "ChatFont",
            fontSize: this.fontSize,
            lineHeight: this.lineHeight,
            fill: this.themeFills.timestamp,
          },
        });
        ht.visible = false;
        ht.eventMode = "none";
        hostTexts.push(ht);
      }
      const bitsLabel = new BitmapText({
        text: "",
        style: {
          fontFamily: "ChatFont",
          fontSize: this.fontSize,
          lineHeight: this.lineHeight,
          fill: 0x9c34ff,
        },
      });
      bitsLabel.visible = false;
      bitsLabel.eventMode = "none";
      const badges: Sprite[] = [];
      for (let b = 0; b < BADGE_SLOTS_PER_ROW; b += 1) {
        const spr = new Sprite(Texture.EMPTY);
        spr.visible = false;
        spr.eventMode = "none";
        spr.y = this.lineMediaY(0, this.badgeSize);
        badges.push(spr);
      }
      const modBtns: BitmapText[] = [];
      for (let m = 0; m < MOD_ACTION_SLOTS_PER_ROW; m += 1) {
        const mt = new BitmapText({
          text: "",
          style: {
            fontFamily: "ChatFont",
            fontSize: this.fontSize,
            lineHeight: this.lineHeight,
            fill: 0xffaa88,
          },
        });
        mt.visible = false;
        mt.eventMode = "none";
        modBtns.push(mt);
      }
      const modIcons: Sprite[] = [];
      for (let m = 0; m < MOD_GUTTER_ICON_COUNT; m += 1) {
        const spr = new Sprite(Texture.EMPTY);
        spr.visible = false;
        spr.eventMode = "none";
        modIcons.push(spr);
      }
      const caughtTexts: BitmapText[] = [];
      for (let c = 0; c < MENTION_SLOTS_PER_ROW; c += 1) {
        const ct = new BitmapText({
          text: "",
          style: {
            fontFamily: "ChatFont",
            fontSize: this.fontSize,
            lineHeight: this.lineHeight,
            fill: 0xffffff,
          },
        });
        ct.visible = false;
        ct.eventMode = "none";
        caughtTexts.push(ct);
      }
      const clipUi = createClipCardWidgets(this.themeFills.timestamp);
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
        clipUi.root,
        disabledGfx,
      );
      const slot: Slot = {
        root,
        highlight: hl,
        systemCloud,
        mentions,
        disabledGfx,
        time,
        nick,
        nickPaintSpr,
        nickPaint: null,
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
        badgesRaw: [],
        modBtns,
        modIcons,
        modBtnHits: [],
        automodBtnHits: [],
        automodMessageId: "",
        automodStatus: "",
        automodCaught: [],
        caughtTexts,
        clipUi,
        msgId: "",
        login: "",
        bodySource: "",
        bodyRaw: "",
        nickRaw: "",
        copyText: "",
        replyToId: "",
        timestampMs: 0,
        spansRaw: [],
        linkSpans: [],
        hostSpans: [],
        mentionSpans: [],
        clipCard: null,
        clipCardRows: 0,
        linkEnriched: false,
        wrapLines: [{ start: 0, end: 0 }],
        wrapReady: false,
        lineCount: 1,
        bodyIndent: 0,
        bodyContIndent: 0,
        systemCloudBounds: null,
        replyRows: 0,
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
        replyToText: "",
        isAction: false,
        isWhisper: false,
        leadLen: 0,
        systemTextKind: "",
        clearLogin: "",
        clearDurationSec: undefined,
        clearStackCount: 0,
        clearmsgBody: "",
        usernoticeMsgId: "",
        usernoticeSystemText: "",
        usernoticeLogin: "",
        usernoticeParams: null,
        usernoticeInnerBody: "",
        noticeMsgId: "",
        noticeFallback: "",
        noticeTimeoutSec: undefined,
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
      root.on("pointerover", (ev: FederatedPointerEvent) => {
        if (!slot.msgId) {
          return;
        }
        if (slot.systemCloudBounds) {
          const local = ev.getLocalPosition(slot.root);
          if (this.pointInSystemCloud(slot, local.x, local.y)) {
            this.setHoveredMsgId(slot.msgId);
          }
          return;
        }
        if (
          !slot.system &&
          slot.login &&
          !(slot.disabled && this.hideModerated)
        ) {
          this.setHoveredMsgId(slot.msgId);
        }
      });
      root.on("pointerout", () => {
        if (this.hoveredMsgId !== slot.msgId) {
          return;
        }
        if (this.hoverGuard?.()) {
          return;
        }
        this.clearHover();
      });
      stage.addChild(root);
      this.slots.push(slot);
    }
    this.ready = true;
    this.resizeDebounce = trailingDebounce(() => {
      this.markLayoutFullPaint();
      this.layout();
    }, 100);
    this.app.renderer.on("resize", this.onRendererResize);
  }

  reset(): void {
    this.cancelLayoutSettle();
    this.liveMsgIds.clear();
    this.channelLive = false;
    this.resetSlots();
    this.markLayoutFullPaint();
    this.layout(undefined, undefined, false);
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
    this.cancelLayoutSettle();
    this.resizeDebounce?.cancel();
    this.resizeDebounce = null;
    this.app.renderer.off("resize", this.onRendererResize);
    window.clearTimeout(this.hoverPauseTimer);
    this.hoverPauseTimer = 0;
    this.pauseMouse = false;
    this.clearNickPaintTextures();
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
  }

  private resetSlots(): void {
    this.clearSlots();
    this.scroll.reset();
  }

  private pushOne(event: ChatEvent): { slot?: Slot; needFullLayout: boolean } {
    if (event.kind === "clearmsg") {
      const target = this.findSlotByMsgId(event.targetId);
      if (!target) {
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
      this.head = (this.head + 1) % this.poolSize;
      if (this.occupied < this.poolSize) {
        this.occupied += 1;
      }
      this.bumpHighlightMarks();
      return { slot, needFullLayout: true };
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
    return {
      slot,
      needFullLayout: event.kind === "clearchat",
    };
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
    releaseClipThumb(slot.clipUi, this.textures);
    hideClipCard(slot.clipUi);
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
    slot.bodyCont.text = "";
    slot.bodyCont.visible = false;
    slot.msgId = "";
    slot.login = "";
    slot.bodySource = "";
    slot.bodyRaw = "";
    slot.nickRaw = "";
    slot.copyText = "";
    slot.replyToId = "";
    slot.timestampMs = 0;
    slot.spansRaw = [];
    slot.linkSpans = [];
    slot.hostSpans = [];
    slot.mentionSpans = [];
    slot.clipCard = null;
    slot.clipCardRows = 0;
    slot.linkEnriched = false;
    slot.modBtnHits = [];
    slot.automodBtnHits = [];
    slot.automodMessageId = "";
    slot.automodStatus = "";
    slot.automodCaught = [];
    for (const mt of slot.modBtns) {
      mt.visible = false;
      mt.text = "";
    }
    for (const spr of slot.modIcons) {
      spr.visible = false;
      spr.texture = Texture.EMPTY;
    }
    for (const ct of slot.caughtTexts) {
      ct.visible = false;
      ct.text = "";
    }
    slot.wrapLines = [{ start: 0, end: 0 }];
    slot.wrapReady = false;
    slot.lineCount = 1;
    slot.bodyIndent = 0;
    slot.bodyContIndent = 0;
    slot.replyRows = 0;
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
    slot.nickPaint = null;
    slot.nickPaintKey = "";
    slot.nickPaintSpr.visible = false;
    slot.nickPaintSpr.texture = Texture.EMPTY;
    slot.nick.visible = true;
    slot.replyToLogin = "";
    slot.replyToText = "";
    slot.isAction = false;
    slot.isWhisper = false;
    slot.leadLen = 0;
    slot.systemTextKind = "";
    slot.clearLogin = "";
    slot.clearDurationSec = undefined;
    slot.clearStackCount = 0;
    slot.clearmsgBody = "";
    slot.usernoticeMsgId = "";
    slot.usernoticeSystemText = "";
    slot.usernoticeLogin = "";
    slot.usernoticeParams = null;
    slot.usernoticeInnerBody = "";
    slot.noticeMsgId = "";
    slot.noticeFallback = "";
    slot.noticeTimeoutSec = undefined;
    slot.replyHeader.visible = false;
    slot.replyHeader.text = "";
    slot.highlight.clear();
    slot.systemCloud.clear();
    slot.systemCloudBounds = null;
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
    for (const ht of slot.hostTexts) {
      ht.visible = false;
      ht.text = "";
    }
    for (const mt of slot.modBtns) {
      mt.visible = false;
      mt.text = "";
    }
    for (const spr of slot.modIcons) {
      spr.visible = false;
      spr.texture = Texture.EMPTY;
    }
    for (const ct of slot.caughtTexts) {
      ct.visible = false;
      ct.text = "";
    }
    slot.modBtnHits = [];
    slot.automodBtnHits = [];
    slot.bitsLabel.visible = false;
    slot.bitsLabel.text = "";
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
    slot.system = event.kind !== "privmsg" && event.kind !== "automodHeld";
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
      slot.nickPaint = event.paint ?? null;
      const cacheColor = event.paint
        ? paintRepresentativeRgb(event.paint)
        : drawn.nickColor;
      this.nickColorCache.set(event.login, cacheColor);
      if (!event.paint) {
        slot.nick.tint = drawn.nickColor;
      }
    } else if (event.kind === "automodHeld") {
      slot.useNickStyle = true;
      slot.nickUserId = event.authorUserId;
      slot.nickColorRaw = "";
      slot.nickLogin = event.authorLogin;
      slot.nickDisplay = event.authorDisplayName || event.authorLogin;
      slot.nickPaint = null;
      slot.login = event.authorLogin.toLowerCase();
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
    releaseClipThumb(slot.clipUi, this.textures);
    hideClipCard(slot.clipUi);
    slot.clipCard = null;
    slot.clipCardRows = 0;
    slot.linkEnriched = false;
    slot.bodyRaw = this.displayBody(slot.bodySource, slot.linkSpans);
    // Recycled slots keep stale wrapLines; cull must see them as dirty.
    slot.wrapLines = [{ start: 0, end: 0 }];
    slot.wrapReady = false;
    slot.lineCount = 1;
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
    slot.highlightColor = drawn.highlightColor;
    slot.systemTextKind = "";
    slot.clearLogin = "";
    slot.clearDurationSec = undefined;
    slot.clearStackCount = 0;
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
        if (span.provider === "cheer-mask") {
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
            const paint = this.emotePaintSize(span);
            applySpriteTexture(spr, tex, paint.w, paint.h);
            this.repaintSlotMedia(slot);
          }
        });
      }
    }
    if (this.isSystemCloud(slot)) {
      slot.badgesRaw = [];
    } else {
      this.loadBadgeSprites(slot);
    }
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

  private isSystemCloud(slot: Slot): boolean {
    return (
      slot.system &&
      !slot.useNickStyle &&
      !slot.isWhisper &&
      slot.bodyRaw.length > 0
    );
  }

  /** Width of one wrap line in ChatFont layout px (emote holes included). */
  private measureBodyLineWidth(
    slot: Slot,
    line: WrapLine,
    opts: WrapOptions,
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
    return this.measureBitmapTextWidth("ChatFont", rendered);
  }

  /**
   * Left-aligned pill for CLEARCHAT / CLEARMSG / USERNOTICE / NOTICE
   * (Twitch web-style system “cloud”).
   */
  private paintSystemCloud(slot: Slot): void {
    releaseClipThumb(slot.clipUi, this.textures);
    hideClipCard(slot.clipUi);
    const padX = Math.max(6, Math.round(SYSTEM_CLOUD_PAD_X * this.fontScale));
    const padY = Math.max(1, Math.round(SYSTEM_CLOUD_PAD_Y * this.fontScale));
    const radius = Math.max(6, Math.round(SYSTEM_CLOUD_RADIUS * this.fontScale));
    const marginX = Math.max(
      4,
      Math.round(SYSTEM_CLOUD_MARGIN_X * this.fontScale),
    );
    const paneW = this.app.screen.width;

    slot.time.visible = false;
    slot.nick.visible = false;
    slot.nickPaintSpr.visible = false;
    slot.nick.text = "";
    slot.replyHeader.visible = false;
    slot.replyHeader.text = "";
    for (const spr of slot.badges) {
      spr.visible = false;
    }
    for (const mt of slot.modBtns) {
      mt.visible = false;
      mt.text = "";
    }
    for (const spr of slot.modIcons) {
      spr.visible = false;
    }
    for (const ct of slot.caughtTexts) {
      ct.visible = false;
      ct.text = "";
    }
    slot.modBtnHits = [];
    slot.automodBtnHits = [];
    slot.bitsLabel.visible = false;
    slot.bitsLabel.text = "";
    slot.body.style.fill = SYSTEM_CLOUD_FG;
    slot.bodyCont.style.fill = SYSTEM_CLOUD_FG;

    // Left margin only: cloud hugs text and stays left-aligned (not centered).
    const maxInner = Math.max(1, Math.floor(paneW - marginX - padX * 2));
    // Mentions stay in body fill (lavender); no nick-colored overlays inside the cloud.
    const layoutOpts = this.wrapOpts(slot, [], maxInner);
    const lines = wrapBody(
      slot.bodyRaw,
      maxInner,
      slot.spansRaw,
      layoutOpts,
    );
    slot.collapsed = false;
    slot.root.cursor = "default";
    slot.wrapLines = lines;
    slot.wrapReady = true;
    slot.replyRows = 0;

    let maxLineW = 0;
    for (const line of lines) {
      maxLineW = Math.max(
        maxLineW,
        this.measureBodyLineWidth(slot, line, layoutOpts),
      );
    }
    const textRows = Math.max(1, lines.length);
    const textBlockW = Math.max(1, Math.ceil(maxLineW));
    const cloudW = Math.min(paneW - marginX, textBlockW + 2 * padX);
    // Hug text rows; vertical pad may slightly use message gap below.
    slot.lineCount = textRows;
    const allocatedH = slot.lineCount * this.lineHeight;
    const cloudX = marginX;
    const cloudY = 0;
    const cloudH = textRows * this.lineHeight + 2 * padY;
    const textOriginX = cloudX + padX;
    const contentY = cloudY + padY;

    slot.bodyIndent = textOriginX;
    slot.bodyContIndent = textOriginX;
    slot.body.x = textOriginX;
    slot.body.y = contentY;
    slot.bodyCont.x = textOriginX;
    slot.bodyCont.y = contentY + this.lineHeight;

    const firstOnly = lines.length > 0 ? [lines[0]] : [{ start: 0, end: 0 }];
    const restLines = lines.slice(1);
    slot.body.text = renderWrapped(
      slot.bodyRaw,
      firstOnly,
      slot.spansRaw,
      layoutOpts,
    );
    dirtyBitmapText(slot.body);
    if (restLines.length === 0) {
      slot.bodyCont.visible = false;
      slot.bodyCont.text = "";
    } else {
      slot.bodyCont.visible = true;
      slot.bodyCont.text = renderWrapped(
        slot.bodyRaw,
        restLines,
        slot.spansRaw,
        layoutOpts,
      );
      dirtyBitmapText(slot.bodyCont);
    }

    slot.systemCloudBounds = {
      x: cloudX,
      y: cloudY,
      w: cloudW,
      h: cloudH,
      radius,
    };
    slot.systemCloud.clear();
    slot.systemCloud
      .roundRect(cloudX, cloudY, cloudW, cloudH, radius)
      .fill({ color: SYSTEM_CLOUD_BG, alpha: 1 });

    if (slot.root.hitArea instanceof Rectangle) {
      slot.root.hitArea.width = paneW;
      slot.root.hitArea.height = allocatedH;
    }

    this.paintHighlight(slot);
    slot.mentions.clear();
    for (const mt of slot.mentionTexts) {
      mt.visible = false;
      mt.text = "";
    }
    for (const ht of slot.hostTexts) {
      ht.visible = false;
      ht.text = "";
    }
    this.paintLinks(
      slot,
      textOriginX,
      textOriginX,
      contentY,
      layoutOpts,
    );
    this.paintDisabled(slot);

    let prevX = 0;
    let prevY = 0;
    let hasPrev = false;
    for (let i = 0; i < slot.emotes.length; i += 1) {
      const spr = slot.emotes[i];
      const span = slot.spansRaw[i];
      if (!span || !this.enableEmoteImages || span.provider === "cheer-mask") {
        spr.visible = false;
        continue;
      }
      const paint = this.emotePaintSize(span);
      const zw = this.enableZeroWidthEmotes && span.zeroWidth === true;
      if (zw && hasPrev) {
        spr.visible = true;
        spr.x = prevX;
        spr.y = prevY;
        if (spr.texture !== Texture.EMPTY) {
          applySpriteTexture(spr, spr.texture, paint.w, paint.h);
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
      spr.x = textOriginX + pos.col;
      spr.y = this.lineMediaY(contentY, paint.h, pos.line);
      if (spr.texture !== Texture.EMPTY) {
        applySpriteTexture(spr, spr.texture, paint.w, paint.h);
      }
      prevX = spr.x;
      prevY = spr.y;
      hasPrev = true;
    }
    slot.bitsLabel.visible = false;
    slot.bitsLabel.text = "";
  }

  private paintClip(slot: Slot): void {
    slot.time.style.fontSize = this.fontSize;
    slot.time.style.lineHeight = this.lineHeight;
    slot.nick.style.fontFamily = "ChatNickFont";
    slot.nick.style.fontSize = this.fontSize;
    slot.nick.style.lineHeight = this.lineHeight;
    slot.body.style.fontSize = this.fontSize;
    slot.body.style.lineHeight = this.lineHeight;
    slot.bodyCont.style.fontSize = this.fontSize;
    slot.bodyCont.style.lineHeight = this.lineHeight;
    slot.bitsLabel.style.fontSize = this.fontSize;
    slot.bitsLabel.style.lineHeight = this.lineHeight;
    if (this.isSystemCloud(slot)) {
      this.paintSystemCloud(slot);
      return;
    }
    slot.systemCloud.clear();
    slot.systemCloudBounds = null;
    slot.body.style.fill = this.themeFills.body;
    slot.bodyCont.style.fill = this.themeFills.body;
    const gap = Math.max(4, Math.round(TIME_GAP * this.fontScale));
    const timeSample = this.timestampsVisible()
      ? formatTime(Date.UTC(2000, 0, 1, 23, 59, 59, 999), this.timestampFormat)
      : "";
    const timeW = this.timestampsVisible()
      ? this.measureBitmapTextWidth("ChatFont", timeSample) + gap
      : 0;
    const gutterW = this.paintModGutter(slot);
    const showReply =
      !this.hideReplyContext && slot.replyToLogin.length > 0;
    const replyRows = showReply ? 1 : 0;
    const contentY = replyRows * this.lineHeight;
    if (showReply) {
      slot.replyHeader.visible = true;
      slot.replyHeader.style.fontSize = Math.max(
        8,
        Math.round(this.fontSize * 0.85),
      );
      slot.replyHeader.style.fill = this.themeFills.timestamp;
      slot.replyHeader.x = 0;
      slot.replyHeader.y = Math.max(
        0,
        (this.lineHeight - slot.replyHeader.style.fontSize) / 2,
      );
    } else {
      slot.replyHeader.visible = false;
      slot.replyHeader.text = "";
    }
    for (const mt of slot.modBtns) {
      if (mt.visible) {
        mt.y = contentY;
      }
    }
    slot.time.x = gutterW;
    slot.time.y = contentY;
    slot.time.visible = this.timestampsVisible();
    const badgeVisible = this.visibleBadges(slot);
    const badgeN = badgeVisible.length;
    const badgeBand =
      badgeN === 0 ? 0 : badgeN * this.badgeSize + (badgeN - 1) * BADGE_GAP;
    for (let i = 0; i < slot.badges.length; i += 1) {
      const spr = slot.badges[i];
      const badge = badgeVisible[i];
      if (!badge) {
        spr.visible = false;
        continue;
      }
      spr.visible = true;
      spr.x = gutterW + timeW + i * (this.badgeSize + BADGE_GAP);
      spr.y = this.lineMediaY(contentY, this.badgeSize);
    }
    slot.nick.x = gutterW + timeW + badgeBand;
    slot.nick.y = contentY;
    const paneW = this.app.screen.width;
    // Stock MessageLayout does not ellipsis nicks for body budget. At high zoom,
    // reserving MIN_BODY_CHARS * charWidth starved the nick column (shown as "..").
    // Clip only when the full nick cannot leave at least one body column.
    const prefixW = gutterW + timeW + badgeBand;
    const nickColon =
      slot.useNickStyle && !slot.isAction && slot.nickRaw.length > 0;
    const nickForWidth = nickColon ? `${slot.nickRaw}:` : slot.nickRaw;
    const fullNickW = Math.max(
      this.measureBitmapTextWidth("ChatNickFont", nickForWidth),
      8,
    );
    const maxNickPx = Math.max(
      8,
      paneW - prefixW - gap - 8 - MIN_BODY_COLS_AFTER_NICK * this.charWidth,
    );
    if (fullNickW > maxNickPx) {
      slot.nick.text = this.clipNickToWidth(
        slot.nickRaw,
        maxNickPx,
        nickColon,
      );
    } else {
      slot.nick.text = nickForWidth;
    }
    dirtyBitmapText(slot.nick);
    const nickW = this.applyNickPaintChrome(slot, contentY);
    const firstOriginX = gutterW + timeW + badgeBand + nickW + gap;
    const contOriginX = gutterW;
    // Split body: first wrap line after nick; lines 2+ under timestamp (no space-pad).
    slot.body.x = firstOriginX;
    slot.body.y = contentY;
    slot.bodyCont.x = contOriginX;
    slot.bodyCont.y = contentY + this.lineHeight;
    if (slot.root.hitArea instanceof Rectangle) {
      slot.root.hitArea.width = this.app.screen.width;
    }
    const edgePad = 8;
    const fullWidthPx = Math.max(1, Math.floor(paneW - contOriginX - edgePad));
    const firstWidthPx = Math.max(1, Math.floor(paneW - firstOriginX - edgePad));
    if (showReply) {
      slot.replyHeader.x = contOriginX;
      slot.replyHeader.text = clipReplyHeaderToWidth(
        formatReplyHeader(slot.replyToLogin, slot.replyToText),
        fullWidthPx,
        (s) => this.measureBitmapTextWidth("ChatFont", s),
      );
      dirtyBitmapText(slot.replyHeader);
    }
    const layoutOpts = this.wrapOpts(slot, undefined, firstWidthPx);
    const wrapped = wrapBody(
      slot.bodyRaw,
      fullWidthPx,
      slot.spansRaw,
      layoutOpts,
    );
    const maxLines =
      slot.collapsible && !slot.expanded ? this.collapseMessagesMinLines : 0;
    const collapseWidth =
      maxLines === 1 ? firstWidthPx : fullWidthPx;
    const { lines, collapsed } = collapseWrapLines(
      wrapped,
      maxLines,
      slot.bodyRaw,
      collapseWidth,
      slot.spansRaw,
      layoutOpts,
    );
    slot.collapsed = collapsed;
    slot.root.cursor =
      collapsed || slot.modBtnHits.length > 0 ? "pointer" : "default";
    slot.wrapLines = lines;
    slot.wrapReady = true;
    if (slot.clipCard) {
      slot.clipCardRows = clipCardRowCount(this.lineHeight);
    } else {
      slot.clipCardRows = 0;
    }
    slot.lineCount = replyRows + lines.length + slot.clipCardRows;
    slot.bodyIndent = firstOriginX;
    slot.bodyContIndent = contOriginX;
    slot.replyRows = replyRows;
    const overlayMentions =
      this.boldUsernames || this.colorUsernames
        ? this.mentionSpansForOverlay(slot.mentionSpans, lines)
        : [];
    const renderOpts = this.wrapOpts(slot, overlayMentions, firstWidthPx);
    const firstOnly = lines.length > 0 ? [lines[0]] : [{ start: 0, end: 0 }];
    const restLines = lines.slice(1);
    slot.body.text = withCollapsedEllipsis(
      renderWrapped(slot.bodyRaw, firstOnly, slot.spansRaw, renderOpts),
      collapsed && restLines.length === 0,
    );
    dirtyBitmapText(slot.body);
    if (restLines.length === 0) {
      slot.bodyCont.visible = false;
      slot.bodyCont.text = "";
    } else {
      slot.bodyCont.visible = true;
      slot.bodyCont.text = withCollapsedEllipsis(
        renderWrapped(slot.bodyRaw, restLines, slot.spansRaw, renderOpts),
        collapsed,
      );
      dirtyBitmapText(slot.bodyCont);
    }
    if (slot.root.hitArea instanceof Rectangle) {
      slot.root.hitArea.height = slot.lineCount * this.lineHeight;
    }
    this.paintHighlight(slot);
    slot.mentions.clear();
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
    let bitsLabelShown = false;
    for (let i = 0; i < slot.emotes.length; i += 1) {
      const spr = slot.emotes[i];
      const span = slot.spansRaw[i];
      if (!span || !this.enableEmoteImages || span.provider === "cheer-mask") {
        spr.visible = false;
        continue;
      }
      const paint = this.emotePaintSize(span);
      const zw = this.enableZeroWidthEmotes && span.zeroWidth === true;
      if (zw && hasPrev) {
        spr.visible = true;
        spr.x = prevX;
        spr.y = prevY;
        if (spr.texture !== Texture.EMPTY) {
          applySpriteTexture(spr, spr.texture, paint.w, paint.h);
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
      spr.x =
        wrapLineOriginX(firstOriginX, pos.line, contOriginX) + pos.col;
      spr.y = this.lineMediaY(contentY, paint.h, pos.line);
      if (spr.texture !== Texture.EMPTY) {
        applySpriteTexture(spr, spr.texture, paint.w, paint.h);
      }
      prevX = spr.x;
      prevY = spr.y;
      hasPrev = true;
      if (
        !bitsLabelShown &&
        this.stackBits &&
        span.bitsAmount != null &&
        span.bitsAmount > 0 &&
        span.bitsColor
      ) {
        const tint = parseCheerColor(span.bitsColor);
        if (tint != null) {
          slot.bitsLabel.visible = true;
          slot.bitsLabel.text = ` ${span.bitsAmount}`;
          slot.bitsLabel.tint = tint;
          slot.bitsLabel.x = spr.x + paint.w + 2;
          slot.bitsLabel.y = contentY + pos.line * this.lineHeight;
          bitsLabelShown = true;
        }
      }
    }
    if (!bitsLabelShown) {
      slot.bitsLabel.visible = false;
      slot.bitsLabel.text = "";
    }
    this.paintSlotClipCard(slot);
  }

  private paintSlotClipCard(slot: Slot): void {
    const msgId = slot.msgId;
    const clipId = slot.clipCard?.clipId ?? "";
    paintClipCard({
      clip: slot.clipUi,
      info: slot.clipCard,
      clipCardRows: slot.clipCardRows,
      lineCount: slot.lineCount,
      lineHeight: this.lineHeight,
      bodyContIndent: slot.bodyContIndent,
      bodyIndent: slot.bodyIndent,
      paneW: this.app.screen.width,
      fontSize: this.fontSize,
      mutedFill: this.themeFills.timestamp,
      textures: this.textures,
      measure: (text) => this.measureBitmapTextWidth("ChatFont", text),
      applySprite: applySpriteTexture,
      stillCurrent: () =>
        slot.msgId === msgId &&
        !!slot.clipCard &&
        slot.clipCard.clipId === clipId &&
        slot.clipUi.thumbKey === `clip:${clipId}`,
    });
  }

  private paintHighlight(slot: Slot): void {
    slot.highlight.clear();
    const cloud = slot.systemCloudBounds;
    const h = slot.lineCount * this.lineHeight;
    const w = this.app.screen.width;
    if (this.findHitId && slot.msgId === this.findHitId) {
      if (cloud) {
        slot.highlight
          .roundRect(cloud.x, cloud.y, cloud.w, cloud.h, cloud.radius)
          .fill({ color: 0xf0ad4e, alpha: 0.28 });
      } else {
        slot.highlight.rect(0, 0, w, h).fill({ color: 0xf0ad4e, alpha: 0.28 });
      }
    } else {
      const parsed = parseHighlight(slot.highlightColor);
      if (parsed) {
        if (cloud) {
          slot.highlight
            .roundRect(cloud.x, cloud.y, cloud.w, cloud.h, cloud.radius)
            .fill({ color: parsed.color, alpha: parsed.alpha });
        } else {
          slot.highlight
            .rect(0, 0, w, h)
            .fill({ color: parsed.color, alpha: parsed.alpha });
        }
      } else if (this.hoveredMsgId && slot.msgId === this.hoveredMsgId) {
        if (cloud) {
          slot.highlight
            .roundRect(cloud.x, cloud.y, cloud.w, cloud.h, cloud.radius)
            .fill({
              color: this.themeFills.hover,
              alpha: this.themeFills.hoverAlpha,
            });
        } else {
          slot.highlight.rect(0, 0, w, h).fill({
            color: this.themeFills.hover,
            alpha: this.themeFills.hoverAlpha,
          });
        }
      } else if (!cloud && this.alternateMessages && slot.startRow % 2 === 1) {
        slot.highlight
          .rect(0, 0, w, h)
          .fill({
            color: this.themeFills.alternate,
            alpha: this.themeFills.alternateAlpha,
          });
      }
    }
    if (this.separateMessages && !slot.systemCloudBounds) {
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

  /** Underline link spans (hit-test uses the same ranges). */
  private paintLinks(
    slot: Slot,
    firstOriginX: number,
    contOriginX: number,
    contentY: number,
    wrapOpts: WrapOptions,
  ): void {
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
          this.measureBitmapTextWidth("ChatFont", slot.bodyRaw.slice(a, b)),
        );
        const x0 =
          wrapLineOriginX(firstOriginX, start.line, contOriginX) + start.col;
        const y =
          contentY + start.line * this.lineHeight + this.lineHeight - 2;
        slot.mentions
          .moveTo(x0, y)
          .lineTo(x0 + linkW, y)
          .stroke({ width: 1, color: linkColor, alpha: 0.95 });
      }
    }
  }

  /** Dimmed `(host)` suffix after resolved link titles. */
  private paintHostTexts(
    slot: Slot,
    firstOriginX: number,
    contOriginX: number,
    contentY: number,
    wrapOpts: WrapOptions,
  ): void {
    for (const ht of slot.hostTexts) {
      ht.visible = false;
    }
    if (slot.hostSpans.length === 0) {
      return;
    }
    let used = 0;
    for (const span of slot.hostSpans) {
      for (const line of slot.wrapLines) {
        if (used >= slot.hostTexts.length) {
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
        const ht = slot.hostTexts[used];
        used += 1;
        ht.text = slot.bodyRaw.slice(a, b);
        ht.style.fontFamily = "ChatFont";
        ht.style.fontSize = this.fontSize;
        ht.style.lineHeight = this.lineHeight;
        ht.style.fill = this.themeFills.timestamp;
        ht.x =
          wrapLineOriginX(firstOriginX, pos.line, contOriginX) + pos.col;
        ht.y = contentY + pos.line * this.lineHeight;
        ht.visible = true;
        dirtyBitmapText(ht);
      }
    }
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
        mt.x =
          wrapLineOriginX(firstOriginX, pos.line, contOriginX) + pos.col;
        mt.y = contentY + pos.line * this.lineHeight;
        mt.visible = true;
        dirtyBitmapText(mt);
      }
    }
  }

  private paintCaughtTexts(
    slot: Slot,
    firstOriginX: number,
    contOriginX: number,
    contentY: number,
    lines: readonly WrapLine[],
    wrapOpts: WrapOptions,
  ): void {
    for (const ct of slot.caughtTexts) {
      ct.visible = false;
      ct.text = "";
    }
    if (slot.automodCaught.length === 0) {
      return;
    }
    let used = 0;
    for (const span of slot.automodCaught) {
      for (const line of lines) {
        if (used >= slot.caughtTexts.length) {
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
        const ct = slot.caughtTexts[used]!;
        used += 1;
        ct.text = slot.bodyRaw.slice(a, b);
        ct.style.fontFamily = "ChatFont";
        ct.style.fontSize = this.fontSize;
        ct.style.fill = 0xffffff;
        ct.tint = AUTOMOD_CAUGHT_COLOR;
        ct.x = wrapLineOriginX(firstOriginX, pos.line, contOriginX) + pos.col;
        ct.y = contentY + pos.line * this.lineHeight;
        ct.visible = true;
        dirtyBitmapText(ct);
      }
    }
  }

  private paintAutomodActions(
    slot: Slot,
    firstOriginX: number,
    contentY: number,
    lines: readonly WrapLine[],
  ): void {
    slot.automodBtnHits = [];
    if (
      !slot.automodMessageId ||
      slot.automodStatus.toLowerCase() !== "pending"
    ) {
      return;
    }
    if (lines.length < 2) {
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
      const mt = slot.modBtns[i];
      if (!mt) {
        break;
      }
      mt.text = def.label;
      mt.visible = true;
      mt.style.fill = 0xffffff;
      mt.tint = def.color;
      mt.x = x;
      mt.y = y;
      dirtyBitmapText(mt);
      const w = measureTextWidth(
        this.chatFontFamily,
        qtWeightToCss(this.chatFontWeight),
        this.fontSize,
        def.label,
      );
      slot.automodBtnHits.push({
        x0: x,
        x1: x + w,
        y0: y,
        y1,
        action: def.action,
      });
      x += w + gap;
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

  private invalidateAllWraps(): void {
    const start = (this.head - this.occupied + this.poolSize) % this.poolSize;
    for (let i = 0; i < this.occupied; i += 1) {
      const slot = this.slots[(start + i) % this.poolSize];
      if (slot.msgId) {
        slot.wrapReady = false;
      }
    }
  }

  /** Wrap metrics present so paintClip can be skipped until width/font/theme change. */
  private slotWrapValid(slot: Slot): boolean {
    return slot.wrapReady;
  }

  private slotYIntersects(slot: Slot, top: number, bottom: number): boolean {
    const y0 = slot.root.y;
    const y1 = y0 + Math.max(1, slot.lineCount) * this.lineHeight;
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
    const visible: Slot[] = [];
    for (let i = 0; i < this.occupied; i += 1) {
      const slot = this.slots[(start + i) % this.poolSize];
      const live = slot.msgId.length > 0;
      const show = live && !(this.hideModerated && slot.disabled);
      slot.root.visible = show;
      if (show) {
        visible.push(slot);
      }
    }
    const gapPx = this.messageGapPx();

    const placeY = (): number => {
      let y = 0;
      for (let i = 0; i < visible.length; i += 1) {
        const slot = visible[i];
        slot.startRow = i;
        slot.root.y = y;
        y += slot.lineCount * this.lineHeight;
        if (i + 1 < visible.length) {
          y += gapPx;
        }
      }
      return y;
    };

    let totalY = placeY();

    if (paintOnly) {
      let heightsChanged = false;
      for (const slot of visible) {
        if (!paintOnly.has(slot)) {
          continue;
        }
        const prev = slot.lineCount;
        this.paintClip(slot);
        if (slot.lineCount !== prev) {
          heightsChanged = true;
        }
      }
      if (heightsChanged) {
        totalY = placeY();
      }
    } else {
      const paintBudgetMs = 10;
      const paintStarted = performance.now();
      let budgetHit = false;
      for (let iter = 0; iter < 4; iter += 1) {
        const band = this.viewportPaintBand(totalY);
        let heightsChanged = false;
        for (const slot of visible) {
          if (this.slotWrapValid(slot)) {
            continue;
          }
          if (!this.slotYIntersects(slot, band.top, band.bottom)) {
            continue;
          }
          if (performance.now() - paintStarted > paintBudgetMs) {
            budgetHit = true;
            break;
          }
          const prev = slot.lineCount;
          this.paintClip(slot);
          if (slot.lineCount !== prev) {
            heightsChanged = true;
          }
        }
        totalY = placeY();
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
  }

  private perfEnabled(): boolean {
    return this.perfOn;
  }

  private withPerfMeasure(name: string, fn: () => void): void {
    if (!this.perfEnabled() || typeof performance === "undefined") {
      fn();
      return;
    }
    const t0 = performance.now();
    fn();
    const ms = performance.now() - t0;
    if (ms > 16) {
      const now = performance.now();
      if (now - this.perfLogAt >= 1000) {
        this.perfLogAt = now;
        console.warn(`[crt-perf] ${name} ${ms.toFixed(1)}ms (>16ms)`);
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
    if (!this.ready || this.occupied === 0) {
      return;
    }
    const start = (this.head - this.occupied + this.poolSize) % this.poolSize;
    const gapPx = this.messageGapPx();
    let contentH = 0;
    let shown = 0;
    for (let i = 0; i < this.occupied; i += 1) {
      const slot = this.slots[(start + i) % this.poolSize];
      if (!slot.root.visible) {
        continue;
      }
      if (shown > 0) {
        contentH += gapPx;
      }
      contentH += slot.lineCount * this.lineHeight;
      shown += 1;
    }
    const band = this.viewportPaintBand(contentH);
    // Anchors must be taken before paintClip mutates lineCount under stale root.y.
    const anchors = this.captureScrollAnchors();
    const paintStarted = performance.now();
    const paintBudgetMs = 8;
    let heightsChanged = false;
    let unfinished = false;
    for (let i = 0; i < this.occupied; i += 1) {
      const slot = this.slots[(start + i) % this.poolSize];
      if (!slot.msgId || !slot.root.visible) {
        continue;
      }
      if (this.slotWrapValid(slot)) {
        continue;
      }
      if (!this.slotYIntersects(slot, band.top, band.bottom)) {
        continue;
      }
      if (performance.now() - paintStarted > paintBudgetMs) {
        unfinished = true;
        break;
      }
      const prev = slot.lineCount;
      this.paintClip(slot);
      if (slot.lineCount !== prev) {
        heightsChanged = true;
      }
    }
    if (heightsChanged) {
      this.repositionRootsFromCache(anchors);
    }
    if (unfinished) {
      this.scheduleViewportPaint();
    }
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

  private laidSlots(): LaidSlot[] {
    const start = (this.head - this.occupied + this.poolSize) % this.poolSize;
    this.laidBuf.length = 0;
    const shown: Slot[] = [];
    for (let i = 0; i < this.occupied; i += 1) {
      const slot = this.slots[(start + i) % this.poolSize];
      if (slot.msgId.length === 0) {
        continue;
      }
      if (this.hideModerated && slot.disabled) {
        continue;
      }
      shown.push(slot);
    }
    const gapRows =
      this.lineHeight > 0 ? this.messageGapPx() / this.lineHeight : 0;
    for (let i = 0; i < shown.length; i += 1) {
      const slot = shown[i];
      this.laidBuf.push({
        msgId: slot.msgId,
        startRow: this.slotScrollRow(slot),
        lineCount: slot.lineCount + (i + 1 < shown.length ? gapRows : 0),
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
      login: opts?.login ?? slot.login,
      authorLogin: slot.login,
      nick: opts?.nick ?? this.contextNick(slot),
      text: slot.copyText || slot.bodyRaw,
      fullText: formatFullCopyText({
        time: slot.time.text,
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
      const local = ev.getLocalPosition(slot.root);
      if (slot.clipCard && clipCardContains(slot.clipUi, local.x, local.y)) {
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
      slot.wrapReady = false;
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
          const local = ev.getLocalPosition(slot.root);
          if (slot.clipCard && clipCardContains(slot.clipUi, local.x, local.y)) {
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
    if (slot.systemCloudBounds && slot.msgId) {
      const local = ev.getLocalPosition(slot.root);
      if (this.pointInSystemCloud(slot, local.x, local.y)) {
        this.setHoveredMsgId(slot.msgId);
      } else if (this.hoveredMsgId === slot.msgId && !this.hoverGuard?.()) {
        this.clearHover();
      }
    }
    if (this.automodActionAt(slot, ev) || this.modActionAt(slot, ev)) {
      slot.root.cursor = "pointer";
      return;
    }
    if (this.nickAt(slot, ev) && slot.login) {
      slot.root.cursor = "pointer";
      return;
    }
    if (this.mentionLoginAt(slot, ev)) {
      slot.root.cursor = "pointer";
      return;
    }
    {
      const local = ev.getLocalPosition(slot.root);
      if (slot.clipCard && clipCardContains(slot.clipUi, local.x, local.y)) {
        slot.root.cursor = "pointer";
        return;
      }
    }
    if (slot.collapsed && !slot.expanded) {
      slot.root.cursor = "pointer";
      return;
    }
    slot.root.cursor = this.linkAt(slot, ev) ? "pointer" : "default";
  }

  private showModGutter(slot: Slot): boolean {
    if (!this.moderationMode) {
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
    slot.modBtnHits = [];
    for (const mt of slot.modBtns) {
      mt.visible = false;
      mt.text = "";
    }
    for (const spr of slot.modIcons) {
      spr.visible = false;
    }
    if (!this.showModGutter(slot)) {
      return 0;
    }
    const actions = modGutterActions();
    const iconSize = Math.max(14, Math.round(this.fontSize * 1.05));
    const padX = Math.max(2, Math.round(2 * this.fontScale));
    const btnGap = Math.max(4, Math.round(4 * this.fontScale));
    const color = "#ffaa88";
    let x = 0;
    for (let i = 0; i < MOD_GUTTER_ICON_COUNT; i += 1) {
      const action = actions[i];
      const spr = slot.modIcons[i];
      if (!action || !spr) {
        continue;
      }
      const kind = action.label === "clock" ? "clock" : "ban";
      const tex = modGutterIconTexture(kind, iconSize, color);
      spr.texture = tex;
      spr.width = iconSize;
      spr.height = iconSize;
      spr.visible = true;
      spr.x = x + padX;
      spr.y = this.lineMediaY(0, iconSize);
      const btnW = iconSize + padX * 2;
      slot.modBtnHits.push({
        x0: x,
        x1: x + btnW,
        action: action.action,
      });
      x += btnW + btnGap;
    }
    return x > 0 ? Math.max(0, x - btnGap) : 0;
  }

  private modActionAt(slot: Slot, ev: FederatedPointerEvent): string | null {
    if (slot.modBtnHits.length === 0) {
      return null;
    }
    const local = ev.getLocalPosition(slot.root);
    const y0 = slot.replyRows * this.lineHeight;
    if (local.y < y0 || local.y >= y0 + this.lineHeight) {
      return null;
    }
    for (const hit of slot.modBtnHits) {
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
    if (slot.automodBtnHits.length === 0) {
      return null;
    }
    const local = ev.getLocalPosition(slot.root);
    for (const hit of slot.automodBtnHits) {
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
    if (!slot.login || slot.system || !slot.useNickStyle) {
      return false;
    }
    const local = ev.getLocalPosition(slot.root);
    const nickW = Math.max(
      this.measureBitmapTextWidth("ChatNickFont", slot.nick.text),
      8,
    );
    const y0 = slot.replyRows * this.lineHeight;
    return (
      local.x >= slot.nick.x &&
      local.x < slot.nick.x + nickW &&
      local.y >= y0 &&
      local.y < y0 + this.lineHeight
    );
  }

  /** Show gradient Sprite or keep BitmapText; returns nick column width (BitmapText). */
  private applyNickPaintChrome(slot: Slot, contentY: number): number {
    const text = slot.nick.text;
    const baseW = Math.max(
      this.measureBitmapTextWidth("ChatNickFont", text),
      8,
    );
    if (!slot.nickPaint || !text) {
      slot.nick.visible = true;
      slot.nickPaintSpr.visible = false;
      slot.nickPaintSpr.texture = Texture.EMPTY;
      slot.nickPaintKey = "";
      return baseW;
    }
    const family = this.chatFontFamily || "Segoe UI";
    const weight = qtWeightToCss(this.nickBoldScale);
    const key = paintCacheKey(
      slot.nickPaint,
      text,
      this.fontSize,
      family,
      weight,
    );
    if (
      key === slot.nickPaintKey &&
      slot.nickPaintSpr.visible &&
      slot.nickPaintSpr.texture !== Texture.EMPTY
    ) {
      this.touchNickPaintLru(key);
      const pad =
        (slot.nickPaintSpr.texture as Texture & { __crtPad?: number })
          .__crtPad ?? 1;
      slot.nickPaintSpr.x = slot.nick.x - pad;
      slot.nickPaintSpr.y = contentY - pad;
      slot.nick.visible = false;
      return baseW;
    }
    let tex = this.nickPaintTextures.get(key);
    let pad = 1;
    if (!tex) {
      const raster = rasterizeNickPaint({
        paint: slot.nickPaint,
        text,
        fontSize: this.fontSize,
        fontFamily: family,
        fontWeight: weight,
      });
      if (!raster) {
        slot.nick.visible = true;
        slot.nickPaintSpr.visible = false;
        return baseW;
      }
      pad = raster.pad;
      tex = Texture.from(raster.canvas);
      (tex as Texture & { __crtPad?: number }).__crtPad = pad;
      this.nickPaintTextures.set(key, tex);
      this.nickPaintTextureOrder.push(key);
      this.evictNickPaintTextures();
    } else {
      pad = (tex as Texture & { __crtPad?: number }).__crtPad ?? 1;
      this.touchNickPaintLru(key);
    }
    slot.nickPaintKey = key;
    slot.nickPaintSpr.texture = tex;
    slot.nickPaintSpr.x = slot.nick.x - pad;
    slot.nickPaintSpr.y = contentY - pad;
    slot.nickPaintSpr.visible = true;
    slot.nick.visible = false;
    return baseW;
  }

  private touchNickPaintLru(key: string): void {
    const at = this.nickPaintTextureOrder.indexOf(key);
    if (at >= 0) {
      this.nickPaintTextureOrder.splice(at, 1);
    }
    this.nickPaintTextureOrder.push(key);
  }

  private evictNickPaintTextures(): void {
    let guard = this.nickPaintTextureOrder.length;
    while (
      this.nickPaintTextureOrder.length > MessageRing.NICK_PAINT_LRU &&
      guard > 0
    ) {
      guard -= 1;
      const old = this.nickPaintTextureOrder.shift();
      if (!old) {
        break;
      }
      let inUse = false;
      for (const slot of this.slots) {
        if (slot.nickPaintKey === old && slot.nickPaintSpr.visible) {
          inUse = true;
          break;
        }
      }
      if (inUse) {
        this.nickPaintTextureOrder.push(old);
        continue;
      }
      const doomed = this.nickPaintTextures.get(old);
      this.nickPaintTextures.delete(old);
      if (doomed && doomed !== Texture.EMPTY) {
        try {
          doomed.destroy(true);
        } catch {
          /* already gone */
        }
      }
    }
  }

  private clearNickPaintTextures(): void {
    for (const slot of this.slots) {
      slot.nickPaintKey = "";
      slot.nickPaintSpr.visible = false;
      slot.nickPaintSpr.texture = Texture.EMPTY;
      slot.nick.visible = true;
    }
    for (const tex of this.nickPaintTextures.values()) {
      if (tex !== Texture.EMPTY) {
        try {
          tex.destroy(true);
        } catch {
          /* */
        }
      }
    }
    this.nickPaintTextures.clear();
    this.nickPaintTextureOrder.length = 0;
  }

  /** Map pointer in slot-local coords to a UTF-16 index in bodyRaw. */
  private bodyIndexAt(
    slot: Slot,
    localX: number,
    slotLocalY: number,
  ): number | null {
    if (slot.systemCloudBounds) {
      if (!this.pointInSystemCloud(slot, localX, slotLocalY)) {
        return null;
      }
    }
    const contentY = slot.systemCloudBounds
      ? slot.body.y
      : slot.replyRows * this.lineHeight;
    if (
      slotLocalY < contentY ||
      slotLocalY >= contentY + slot.wrapLines.length * this.lineHeight
    ) {
      return null;
    }
    const bodyLine = Math.floor((slotLocalY - contentY) / this.lineHeight);
    if (bodyLine < 0 || bodyLine >= slot.wrapLines.length) {
      return null;
    }
    const originX = wrapLineOriginX(
      slot.bodyIndent,
      bodyLine,
      slot.bodyContIndent,
    );
    if (localX < originX) {
      return null;
    }
    const xPx = localX - originX;
    return lineColToIndex(
      slot.bodyRaw,
      slot.wrapLines,
      bodyLine,
      xPx,
      slot.spansRaw,
      this.wrapOpts(slot, slot.systemCloudBounds ? [] : undefined),
    );
  }

  private pointInSystemCloud(
    slot: Slot,
    localX: number,
    localY: number,
  ): boolean {
    const b = slot.systemCloudBounds;
    if (!b) {
      return false;
    }
    return (
      localX >= b.x &&
      localX < b.x + b.w &&
      localY >= b.y &&
      localY < b.y + b.h
    );
  }

  private mentionLoginAt(slot: Slot, ev: FederatedPointerEvent): string | null {
    if (slot.mentionSpans.length === 0) {
      return null;
    }
    const local = ev.getLocalPosition(slot.root);
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
    const local = ev.getLocalPosition(slot.root);
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
      if (!slot.msgId || !slot.root.visible) {
        continue;
      }
      if (slot.disabled && this.hideModerated) {
        continue;
      }
      const top = slot.root.y;
      const h = slot.lineCount * this.lineHeight;
      if (y < top || y >= top + h) {
        continue;
      }
      const slotLocalY = y - top;
      const badgeVisible = this.visibleBadges(slot);
      for (let b = 0; b < slot.badges.length; b += 1) {
        const spr = slot.badges[b];
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
    const local = ev.getLocalPosition(slot.root);
    const localX = local.x;
    const slotLocalY = local.y;
    const badgeVisible = this.visibleBadges(slot);
    for (let b = 0; b < slot.badges.length; b += 1) {
      const spr = slot.badges[b];
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
      for (let e = slot.emotes.length - 1; e >= 0; e -= 1) {
        const spr = slot.emotes[e];
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
      slotLocalY >= slot.lineCount * this.lineHeight
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
      localX < 0 ||
      slotLocalY < 0 ||
      slotLocalY >= slot.lineCount * this.lineHeight
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
      slotLocalY >= slot.lineCount * this.lineHeight
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
      if (!slot.msgId || slot.system || !slot.login) {
        continue;
      }
      if (slot.disabled && this.hideModerated) {
        continue;
      }
      const top = slot.root.y;
      const h = slot.lineCount * this.lineHeight + this.messageGapPx();
      if (y >= top && y < top + h) {
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

  /** Build SlotContext for a message id (quick-actions "more"). */
  contextForMsgId(msgId: string, clientX: number, clientY: number): SlotContext | null {
    const slot = this.findSlotByMsgId(msgId);
    if (!slot || !slot.msgId) {
      return null;
    }
    return {
      msgId: slot.msgId,
      login: slot.login,
      authorLogin: slot.login,
      nick: this.contextNick(slot),
      text: slot.copyText || slot.bodyRaw,
      fullText: formatFullCopyText({
        time: slot.time.text,
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
    return this.lineHeight > 0 ? slot.root.y / this.lineHeight : 0;
  }

  private emotePixelSize(): number {
    return Math.max(
      1,
      Math.round(chatTextRowHeight(this.fontSize) * this.emoteScale),
    );
  }

  private emotePaintSize(span: EmoteSpan): { w: number; h: number } {
    return emoteDisplaySize(span, this.emotePixelSize());
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
    firstLineMaxWidthPx?: number,
  ): WrapOptions {
    const images = this.enableEmoteImages;
    const emoteMinPx = images ? this.emotePixelSize() : 0;
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
      const w = this.measureBitmapTextWidth("ChatFont", slice);
      cache.set(slice, w);
      return w;
    };
    return {
      emoteMinPx,
      measureAdvance,
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
        if (!span || span.provider === "cheer-mask") {
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
            const paint = this.emotePaintSize(span);
            applySpriteTexture(spr, tex, paint.w, paint.h);
            this.repaintSlotMedia(slot);
          }
        });
      }
    }
  }

  private snapEmotesToFirstFrame(): void {
    const start = (this.head - this.occupied + this.poolSize) % this.poolSize;
    for (let i = 0; i < this.occupied; i += 1) {
      const slot = this.slots[(start + i) % this.poolSize];
      for (let e = 0; e < slot.emotes.length; e += 1) {
        const key = slot.emoteKeys[e];
        if (!key) {
          continue;
        }
        const spr = slot.emotes[e];
        const span = slot.spansRaw[e];
        const tex = this.textures.frameAt(key, 0) ?? this.textures.get(key);
        if (tex && spr.visible && span) {
          const paint = this.emotePaintSize(span);
          applySpriteTexture(spr, tex, paint.w, paint.h);
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
      if (!slot.root.visible) {
        continue;
      }
      for (let e = 0; e < slot.emotes.length; e += 1) {
        const key = slot.emoteKeys[e];
        if (!key || !this.textures.isAnimated(key)) {
          continue;
        }
        const spr = slot.emotes[e];
        const span = slot.spansRaw[e];
        if (!spr.visible || !span) {
          continue;
        }
        const tex = this.textures.frameAt(key, pos);
        if (tex && spr.texture !== tex) {
          const paint = this.emotePaintSize(span);
          applySpriteTexture(spr, tex, paint.w, paint.h);
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

function parseCheerColor(raw: string | undefined): number | null {
  const hex = (raw ?? "").trim();
  const m = /^#?([0-9a-fA-F]{6})$/.exec(hex);
  if (m) {
    return Number.parseInt(m[1], 16);
  }
  return null;
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

function eventLogin(event: ChatEvent): string {
  if (event.kind === "privmsg") {
    return event.login.toLowerCase();
  }
  if (event.kind === "automodHeld") {
    return event.authorLogin.toLowerCase();
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

function applySpriteTexture(
  spr: Sprite,
  tex: Texture,
  width: number,
  height: number,
): void {
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

function badgeTooltipText(set: string): string {
  return set
    .split(/[-_]/)
    .filter((part) => part.length > 0)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1).toLowerCase())
    .join(" ");
}

function clipReplyHeaderToWidth(
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
  const chars = Array.from(text);
  let lo = 0;
  let hi = chars.length;
  let best = ellipsis;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const candidate = chars.slice(0, mid).join("");
    if (measure(candidate) <= budget) {
      best = `${candidate}${ellipsis}`;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return best;
}
