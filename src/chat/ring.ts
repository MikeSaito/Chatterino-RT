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
  CHAR_WIDTH,
  EMOTE_SLOTS_PER_ROW,
  FONT_SIZE,
  LINE_HEIGHT,
  MESSAGE_POOL_SIZE,
} from "../constants";
import type { Badge, ChatEvent, EmoteSpan, LinkSpan, MentionSpan } from "./types";
import { EmoteFrameTicker, TextureLru } from "./textures";
import {
  ScrollModel,
  wheelDeltaRows,
  type LaidSlot,
  type ScrollAnchor,
  type ScrollSnapshot,
} from "./scroll";
import {
  clipNick,
  indexToLineCol,
  lineColToIndex,
  renderWrapped,
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
  /** System/timeout-like: не гасить при room CLEARCHAT (как MessageFlag::System). */
  system: boolean;
};

type Drawn = {
  time: string;
  nick: string;
  nickColor: number;
  body: string;
  copyText: string;
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
  private ready = false;
  private showTimestamps = true;
  private timestampFormat = "hh:mm";
  private fontSize = FONT_SIZE;
  private lineHeight = LINE_HEIGHT;
  private charWidth = CHAR_WIDTH;
  private badgeSize = BADGE_SIZE;
  private emoteScale = 1;
  private enableEmoteImages = true;
  private enableZeroWidthEmotes = true;
  private animateEmotes = true;
  private findHitId = "";
  private hideModerated = false;
  private hideModerationActions = false;
  private showReplyButton = false;
  private alternateMessages = false;
  private separateMessages = false;
  private pauseMouse = false;
  private pauseKey = false;
  private pauseFollowIntent = false;
  private pauseOnHoverSec = 0;
  private pauseModifier: PauseModifier = "None";
  private wheelMultiplier = 1;
  private hoverPauseTimer = 0;
  private onScroll: ((state: ScrollSnapshot) => void) | undefined;
  private onContext: ((ctx: SlotContext) => void) | undefined;
  private onNickClick: ((ctx: SlotContext) => void) | undefined;

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

  setOnContextMenu(cb: (ctx: SlotContext) => void): void {
    this.onContext = cb;
  }

  setOnNickClick(cb: (ctx: SlotContext) => void): void {
    this.onNickClick = cb;
  }

  configureScrollBehaviour(opts: {
    pauseOnHoverSec: number;
    pauseModifier: string;
    wheelMultiplier: number;
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
      this.applyStageY();
      this.notifyScroll();
      return;
    }
    const snap = this.scroll.snapshot();
    if (snap.overflow && snap.desired >= snap.bottom - 1e-3) {
      this.scroll.goToBottom();
      this.applyStageY();
      this.notifyScroll();
    }
  }

  /** Масштаб шрифта, timestamps, emotes и hideModerated без destroy PIXI.Application. */
  applyDisplay(
    fontScale: number,
    showTimestamps: boolean,
    hideModerated = false,
    timestampFormat = "hh:mm",
    alternateMessages = false,
    separateMessages = false,
    hideModerationActions = false,
    showReplyButton = false,
    emotes?: {
      scale?: number;
      images?: boolean;
      zeroWidth?: boolean;
      animate?: boolean;
      animateOnlyFocused?: boolean;
    },
  ): void {
    const scale = Math.min(4, Math.max(0.5, fontScale));
    const prevAnimate = this.animateEmotes;
    const prevImages = this.enableEmoteImages;
    this.showTimestamps = showTimestamps;
    this.hideModerated = hideModerated;
    this.timestampFormat = timestampFormat === "Disable" ? "hh:mm" : timestampFormat;
    this.alternateMessages = alternateMessages;
    this.separateMessages = separateMessages;
    this.hideModerationActions = hideModerationActions;
    this.showReplyButton = showReplyButton;
    this.emoteScale = clampEmoteScale(emotes?.scale ?? this.emoteScale);
    this.enableEmoteImages = emotes?.images ?? this.enableEmoteImages;
    this.enableZeroWidthEmotes = emotes?.zeroWidth ?? this.enableZeroWidthEmotes;
    this.animateEmotes = emotes?.animate ?? this.animateEmotes;
    this.emoteTicker.configure({
      animate: this.animateEmotes,
      onlyFocused: emotes?.animateOnlyFocused ?? false,
    });
    this.fontSize = FONT_SIZE * scale;
    this.lineHeight = Math.max(1, Math.round(LINE_HEIGHT * scale));
    this.charWidth = CHAR_WIDTH * scale;
    this.badgeSize = Math.max(8, Math.round(BADGE_SIZE * scale));
    if (!this.ready) {
      return;
    }
    const emoteSize = this.emotePixelSize();
    for (const slot of this.slots) {
      if (slot.msgId && slot.timestampMs) {
        slot.time.text = formatTime(slot.timestampMs, this.timestampFormat);
      }
      slot.time.style.fontSize = this.fontSize;
      slot.nick.style.fontSize = this.fontSize;
      slot.body.style.fontSize = this.fontSize;
      slot.body.style.lineHeight = this.lineHeight;
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
      prevImages !== this.enableEmoteImages
    ) {
      if (!this.animateEmotes) {
        this.snapEmotesToFirstFrame();
      }
      this.reloadVisibleEmotes();
    }
    this.layout();
  }

  scrollSnapshot(): ScrollSnapshot {
    return this.scroll.snapshot();
  }

  goToBottom(): void {
    this.pauseFollowIntent = false;
    this.scroll.goToBottom();
    this.applyStageY();
    this.notifyScroll();
  }

  setDesired(rows: number): void {
    this.pauseFollowIntent = false;
    this.scroll.setDesired(rows);
    this.applyStageY();
    this.notifyScroll();
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
    this.scroll.setDesired(target.startRow);
    this.applyStageY();
    this.notifyScroll();
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
    this.scroll.wheel(rows);
    if (!this.isPaused()) {
      this.pauseFollowIntent = false;
    }
    this.applyStageY();
    this.notifyScroll();
  }

  async init(): Promise<void> {
    if (this.ready) {
      return;
    }
    this.installChatFont();
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
        style: { fontFamily: "ChatFont", fontSize: this.fontSize, fill: 0xadadc0 },
      });
      const nick = new BitmapText({
        text: "",
        style: { fontFamily: "ChatFont", fontSize: this.fontSize, fill: 0xffffff },
      });
      const body = new BitmapText({
        text: "",
        style: {
          fontFamily: "ChatFont",
          fontSize: this.fontSize,
          fill: 0xefeff1,
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
      const badges: Sprite[] = [];
      for (let b = 0; b < BADGE_SLOTS_PER_ROW; b += 1) {
        const spr = new Sprite(Texture.EMPTY);
        spr.visible = false;
        spr.eventMode = "none";
        spr.y = (this.lineHeight - this.badgeSize) / 2;
        badges.push(spr);
      }
      // disabled overlay last — поверх текста/эмодзи как MessageLayout fillRect
      root.addChild(hl, mentions, time, nick, body, ...badges, ...emotes, disabledGfx);
      const slot: Slot = {
        root,
        highlight: hl,
        mentions,
        disabledGfx,
        time,
        nick,
        body,
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
        system: false,
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
    this.resetSlots();
    this.layout();
  }

  applySnapshot(events: ChatEvent[]): void {
    const follow = this.scroll.atBottom;
    const anchor = this.scroll.captureAnchor(this.laidSlots());
    this.clearSlots();
    const start = Math.max(0, events.length - MESSAGE_POOL_SIZE);
    for (const event of events.slice(start)) {
      this.pushOne(event);
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
    for (const slot of this.slots) {
      this.clearSlot(slot);
    }
  }

  private resetSlots(): void {
    this.clearSlots();
    this.scroll.reset();
  }

  private pushOne(event: ChatEvent): void {
    if (event.kind === "clearmsg") {
      this.disableById(event.targetId);
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
    if (event.kind === "roomstate") {
      // Legacy raw roomstate in old snapshots — skip; live path emits Notice.
      return;
    }
    const slot = this.slots[this.head];
    this.write(slot, event);
    this.head = (this.head + 1) % MESSAGE_POOL_SIZE;
    if (this.occupied < MESSAGE_POOL_SIZE) {
      this.occupied += 1;
    }
  }

  /** Soft-delete: MessageFlag::Disabled, слот остаётся (Chatterino Channel). */
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
    slot.system = false;
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
  }

  private write(slot: Slot, event: ChatEvent): void {
    slot.root.visible = true;
    slot.disabled = false;
    slot.disabledGfx.clear();
    // PRIVMSG only — USERNOTICE/NOTICE/CLEARCHAT = System в эталоне
    slot.system = event.kind !== "privmsg";
    if (event.kind === "usernotice" && event.privmsg && event.privmsg.kind === "privmsg") {
      slot.msgId = event.privmsg.id;
      slot.login = event.privmsg.login.toLowerCase();
    } else {
      slot.msgId = event.id;
      slot.login = eventLogin(event);
    }
    const drawn = this.line(event);
    slot.time.text = drawn.time;
    slot.nickRaw = drawn.nick;
    slot.nick.text = drawn.nick;
    slot.nick.tint = drawn.nickColor;
    slot.bodyRaw = drawn.body;
    slot.copyText = drawn.copyText;
    slot.replyToId =
      event.kind === "privmsg" && event.replyToId ? event.replyToId : "";
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
        void this.textures.load(key, span.url, wantAnimate).then((tex) => {
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

  private line(event: ChatEvent): Drawn {
    const time = formatTime(event.timestampMs, this.timestampFormat);
    switch (event.kind) {
      case "privmsg": {
        let prefix = "";
        if (event.replyToLogin) {
          prefix += `@${event.replyToLogin} `;
        }
        if (event.action) {
          prefix += "* ";
        }
        const shift = prefix.length;
        return {
          time,
          nick: event.displayName || event.login,
          nickColor: parseColor(event.color),
          body: `${prefix}${event.text}`,
          copyText: event.text,
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
        if (event.privmsg && event.privmsg.kind === "privmsg") {
          const inner = event.privmsg;
          let innerPrefix = "";
          if (inner.replyToLogin) {
            innerPrefix += `@${inner.replyToLogin} `;
          }
          if (inner.action) {
            innerPrefix += "* ";
          }
          const sep = body.length > 0 ? " " : "";
          const shift = body.length + sep.length + innerPrefix.length;
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
          nickColor: 0xadadc0,
          body,
          copyText,
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
          nickColor: 0xadadc0,
          body: clearchatText(event.targetLogin, event.durationSec),
          copyText: clearchatText(event.targetLogin, event.durationSec),
          spans: [],
          links: [],
          mentions: [],
          badges: [],
          highlightColor: "",
        };
      case "roomstate":
        return {
          time,
          nick: "*",
          nickColor: 0xadadc0,
          body: `emote:${event.emoteOnly} subs:${event.subsOnly} slow:${event.slowSec}`,
          copyText: "",
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
          nickColor: 0xadadc0,
          body: event.text,
          copyText: event.text,
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
          nickColor: 0xadadc0,
          body: event.kind,
          copyText: "",
          spans: [],
          links: [],
          mentions: [],
          badges: [],
          highlightColor: "",
        };
    }
  }

  private paintClip(slot: Slot): void {
    const timeSample = this.showTimestamps
      ? formatTime(Date.UTC(2000, 0, 1, 23, 59, 59, 999), this.timestampFormat)
      : "";
    const timeW = this.showTimestamps
      ? Math.max(5, timeSample.length) * this.charWidth + TIME_GAP
      : 0;
    slot.time.x = 0;
    slot.time.visible = this.showTimestamps;
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
      paneW - timeW - badgeBand - TIME_GAP - 8 - MIN_BODY_CHARS * this.charWidth,
    );
    const nickMaxChars = Math.max(2, Math.floor(nickMaxPx / this.charWidth));
    slot.nick.text = clipNick(slot.nickRaw, nickMaxChars);
    const nickW = Math.max(slot.nick.text.length * this.charWidth, 8);
    const bodyX = timeW + badgeBand + nickW + TIME_GAP;
    slot.body.x = bodyX;
    if (slot.root.hitArea instanceof Rectangle) {
      slot.root.hitArea.width = this.app.screen.width;
    }
    const wrapOpts = this.wrapOpts();
    const lines = wrapBody(
      slot.bodyRaw,
      maxBodyChars(this.app.screen.width, bodyX, this.charWidth),
      slot.spansRaw,
      wrapOpts,
    );
    slot.wrapLines = lines;
    slot.lineCount = lines.length;
    slot.body.text = renderWrapped(slot.bodyRaw, lines, slot.spansRaw, wrapOpts);
    if (slot.root.hitArea instanceof Rectangle) {
      slot.root.hitArea.height = slot.lineCount * this.lineHeight;
    }
    this.paintHighlight(slot);
    this.paintMentions(slot, bodyX);
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
        wrapOpts,
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
      return;
    }
    const parsed = parseHighlight(slot.highlightColor);
    if (parsed) {
      slot.highlight.rect(0, 0, w, h).fill({ color: parsed.color, alpha: parsed.alpha });
      return;
    }
    if (this.alternateMessages && slot.startRow % 2 === 1) {
      slot.highlight.rect(0, 0, w, h).fill({ color: 0xffffff, alpha: 0.04 });
    }
    if (this.separateMessages) {
      slot.highlight
        .moveTo(0, h - 0.5)
        .lineTo(w, h - 0.5)
        .stroke({ width: 1, color: 0x2a2a2d, alpha: 0.9 });
    }
  }

  private paintDisabled(slot: Slot): void {
    slot.disabledGfx.clear();
    // Chatterino Dark messages.disabled = #99191919 (MessageLayout fillRect)
    if (!slot.disabled) {
      return;
    }
    slot.disabledGfx
      .rect(0, 0, this.app.screen.width, slot.lineCount * this.lineHeight)
      .fill({ color: 0x191919, alpha: 0x99 / 255 });
  }

  private paintMentions(slot: Slot, bodyX: number): void {
    slot.mentions.clear();
    const wrapOpts = this.wrapOpts();
    for (const span of slot.mentionSpans) {
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
    this.applyStageY();
    this.notifyScroll();
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

  private installChatFont(): void {
    // Один atlas на жизнь окна: glyphs при max scale, BitmapText fontSize масштабирует вниз.
    BitmapFont.install({
      name: "ChatFont",
      style: {
        fontFamily: "Consolas, Cascadia Mono, monospace",
        fontSize: FONT_SIZE * 2,
        fill: "#efeff1",
      },
      chars: [
        ["\u0020", "\u007e"],
        ["\u0400", "\u04FF"],
      ],
    });
  }

  private onSlotTap(slot: Slot, ev: FederatedPointerEvent): void {
    if (this.nickAt(slot, ev) && slot.login && this.onNickClick) {
      this.onNickClick({
        msgId: slot.msgId,
        login: slot.login,
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
    const url = this.linkAt(slot, ev);
    if (!url) {
      return;
    }
    void invoke("open_chat_link", { url }).catch(() => undefined);
  }

  private onSlotContext(slot: Slot, ev: FederatedPointerEvent): void {
    if (!slot.msgId || !this.onContext) {
      return;
    }
    ev.preventDefault();
    this.onContext({
      msgId: slot.msgId,
      login: slot.login,
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
    slot.root.cursor = this.linkAt(slot, ev) ? "pointer" : "default";
  }

  private nickAt(slot: Slot, ev: FederatedPointerEvent): boolean {
    if (!slot.login || slot.system || !slot.nickRaw) {
      return false;
    }
    const local = ev.getLocalPosition(slot.root);
    const nickW = Math.max(slot.nick.text.length * this.charWidth, 8);
    return (
      local.x >= slot.nick.x &&
      local.x < slot.nick.x + nickW &&
      local.y >= 0 &&
      local.y < this.lineHeight
    );
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
      this.wrapOpts(),
    );
    if (idx === null) {
      return undefined;
    }
    const hit = slot.linkSpans.find((span) => idx >= span.start && idx < span.end);
    return hit?.url;
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

  private wrapOpts(): WrapOptions {
    const images = this.enableEmoteImages;
    const emoteMinCols =
      images && this.charWidth > 0
        ? Math.max(1, Math.ceil(this.emotePixelSize() / this.charWidth))
        : 0;
    return {
      emoteMinCols,
      maskEmotes: images,
      enableZeroWidth: images && this.enableZeroWidthEmotes,
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
        void this.textures.load(key, span.url, wantAnimate).then((tex) => {
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

function clearchatText(login: string | undefined, durationSec: number | undefined): string {
  if (!login) {
    return "чат очищен";
  }
  if (durationSec !== undefined) {
    return `${login} тайм-аут ${durationSec}с`;
  }
  return `${login} забанен`;
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

function parseColor(color: string): number {
  const m = /^#?([0-9a-fA-F]{6})$/.exec(color);
  if (!m) {
    return 0xbf94ff;
  }
  return Number.parseInt(m[1], 16);
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

function maxBodyChars(paneWidth: number, bodyX: number, charWidth: number): number {
  return Math.floor(Math.max(1, paneWidth - bodyX - 8) / charWidth);
}
