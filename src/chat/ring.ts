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
import { TextureLru } from "./textures";
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
} from "./wrap";

const TIME_GAP = 8;
const BADGE_GAP = 2;
const MIN_BODY_CHARS = 24;

export type SlotContext = {
  msgId: string;
  login: string;
  nick: string;
  text: string;
  clientX: number;
  clientY: number;
};

type Slot = {
  root: Container;
  highlight: Graphics;
  mentions: Graphics;
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
  spansRaw: EmoteSpan[];
  linkSpans: LinkSpan[];
  mentionSpans: MentionSpan[];
  wrapLines: WrapLine[];
  lineCount: number;
  startRow: number;
  highlightColor: string;
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
  private readonly scroll = new ScrollModel();
  private readonly laidBuf: LaidSlot[] = [];
  private occupied = 0;
  private head = 0;
  private ready = false;
  private showTimestamps = true;
  private fontSize = FONT_SIZE;
  private lineHeight = LINE_HEIGHT;
  private charWidth = CHAR_WIDTH;
  private badgeSize = BADGE_SIZE;
  private onScroll: ((state: ScrollSnapshot) => void) | undefined;
  private onContext: ((ctx: SlotContext) => void) | undefined;

  constructor(
    private readonly app: Application,
    textures: TextureLru,
  ) {
    this.textures = textures;
  }

  setOnScroll(cb: (state: ScrollSnapshot) => void): void {
    this.onScroll = cb;
  }

  setOnContextMenu(cb: (ctx: SlotContext) => void): void {
    this.onContext = cb;
  }

  /** Масштаб шрифта и timestamps без destroy PIXI.Application. */
  applyDisplay(fontScale: number, showTimestamps: boolean): void {
    const scale = Math.min(4, Math.max(0.5, fontScale));
    this.showTimestamps = showTimestamps;
    this.fontSize = FONT_SIZE * scale;
    this.lineHeight = Math.max(1, Math.round(LINE_HEIGHT * scale));
    this.charWidth = CHAR_WIDTH * scale;
    this.badgeSize = Math.max(8, Math.round(BADGE_SIZE * scale));
    if (!this.ready) {
      return;
    }
    const emoteSize = Math.max(1, this.lineHeight - 4);
    for (const slot of this.slots) {
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
    this.layout();
  }

  scrollSnapshot(): ScrollSnapshot {
    return this.scroll.snapshot();
  }

  goToBottom(): void {
    this.scroll.goToBottom();
    this.applyStageY();
    this.notifyScroll();
  }

  setDesired(rows: number): void {
    this.scroll.setDesired(rows);
    this.applyStageY();
    this.notifyScroll();
  }

  handleWheel(ev: WheelEvent): void {
    ev.preventDefault();
    if (ev.ctrlKey) {
      return;
    }
    this.scroll.wheel(
      wheelDeltaRows(ev.deltaY, ev.deltaMode, this.lineHeight, this.scroll.viewRows),
    );
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
      root.addChild(hl, mentions, time, nick, body, ...badges, ...emotes);
      const slot: Slot = {
        root,
        highlight: hl,
        mentions,
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
        spansRaw: [],
        linkSpans: [],
        mentionSpans: [],
        wrapLines: [{ start: 0, end: 0 }],
        lineCount: 1,
        startRow: 0,
        highlightColor: "",
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
      this.hideById(event.targetId);
      return;
    }
    if (event.kind === "clearchat") {
      if (event.targetLogin) {
        this.hideByLogin(event.targetLogin);
      } else {
        this.resetSlots();
      }
    }
    const slot = this.slots[this.head];
    this.write(slot, event);
    this.head = (this.head + 1) % MESSAGE_POOL_SIZE;
    if (this.occupied < MESSAGE_POOL_SIZE) {
      this.occupied += 1;
    }
  }

  private hideById(id: string): void {
    let changed = false;
    for (const slot of this.slots) {
      if (slot.msgId === id) {
        this.clearSlot(slot);
        changed = true;
      }
    }
    if (changed) {
      this.compactLive();
    }
  }

  private hideByLogin(login: string): void {
    const needle = login.toLowerCase();
    let changed = false;
    for (const slot of this.slots) {
      if (slot.login === needle) {
        this.clearSlot(slot);
        changed = true;
      }
    }
    if (changed) {
      this.compactLive();
    }
  }

  private compactLive(): void {
    if (this.occupied === 0) {
      return;
    }
    const start = (this.head - this.occupied + MESSAGE_POOL_SIZE) % MESSAGE_POOL_SIZE;
    type Saved = {
      msgId: string;
      login: string;
      bodyRaw: string;
      nickRaw: string;
      copyText: string;
      spansRaw: EmoteSpan[];
      linkSpans: LinkSpan[];
      mentionSpans: MentionSpan[];
      badgesRaw: Badge[];
      highlightColor: string;
      time: string;
      nickColor: number;
      bodyFill: number;
      emoteUrls: { key: string; url: string }[];
      badgeUrls: { key: string; url: string }[];
    };
    const saved: Saved[] = [];
    for (let i = 0; i < this.occupied; i += 1) {
      const slot = this.slots[(start + i) % MESSAGE_POOL_SIZE];
      if (!slot.msgId) {
        continue;
      }
      const emoteUrls: { key: string; url: string }[] = [];
      for (let e = 0; e < slot.emoteKeys.length; e += 1) {
        const key = slot.emoteKeys[e];
        const span = slot.spansRaw[e];
        if (key && span) {
          emoteUrls.push({ key, url: span.url });
        }
      }
      const badgeUrls: { key: string; url: string }[] = [];
      for (let b = 0; b < slot.badgeKeys.length; b += 1) {
        const key = slot.badgeKeys[b];
        const badge = slot.badgesRaw[b];
        if (key && badge?.url) {
          badgeUrls.push({ key, url: badge.url });
        }
      }
      saved.push({
        msgId: slot.msgId,
        login: slot.login,
        bodyRaw: slot.bodyRaw,
        nickRaw: slot.nickRaw,
        copyText: slot.copyText,
        spansRaw: slot.spansRaw.slice(),
        linkSpans: slot.linkSpans.slice(),
        mentionSpans: slot.mentionSpans.slice(),
        badgesRaw: slot.badgesRaw.slice(),
        highlightColor: slot.highlightColor,
        time: slot.time.text,
        nickColor: slot.nick.tint,
        bodyFill: 0xefeff1,
        emoteUrls,
        badgeUrls,
      });
    }
    for (let i = 0; i < this.occupied; i += 1) {
      this.clearSlot(this.slots[(start + i) % MESSAGE_POOL_SIZE]);
    }
    this.occupied = 0;
    this.head = start;
    for (const data of saved) {
      const slot = this.slots[this.head];
      slot.root.visible = true;
      slot.msgId = data.msgId;
      slot.login = data.login;
      slot.time.text = data.time;
      slot.nickRaw = data.nickRaw;
      slot.nick.text = data.nickRaw;
      slot.nick.tint = data.nickColor;
      slot.bodyRaw = data.bodyRaw;
      slot.copyText = data.copyText;
      slot.spansRaw = data.spansRaw;
      slot.linkSpans = data.linkSpans;
      slot.mentionSpans = data.mentionSpans;
      slot.badgesRaw = data.badgesRaw;
      slot.highlightColor = data.highlightColor;
      for (const key of data.emoteUrls.map((x) => x.key)) {
        slot.emoteKeys.push(key);
        this.textures.acquire(key);
      }
      for (const key of data.badgeUrls.map((x) => x.key)) {
        slot.badgeKeys.push(key);
        this.textures.acquire(key);
      }
      for (let e = 0; e < data.emoteUrls.length; e += 1) {
        const item = data.emoteUrls[e];
        const spr = slot.emotes[e];
        if (!item || !spr) {
          continue;
        }
        void this.textures.load(item.key, item.url).then((tex) => {
          if (tex && slot.msgId === data.msgId) {
            applySpriteTexture(spr, tex, this.lineHeight - 4);
          }
        });
      }
      for (let b = 0; b < data.badgeUrls.length; b += 1) {
        const item = data.badgeUrls[b];
        const spr = slot.badges[b];
        if (!item || !spr) {
          continue;
        }
        void this.textures.load(item.key, item.url).then((tex) => {
          if (tex && slot.msgId === data.msgId) {
            applySpriteTexture(spr, tex, this.badgeSize);
          }
        });
      }
      this.head = (this.head + 1) % MESSAGE_POOL_SIZE;
      this.occupied += 1;
    }
    this.layout();
  }

  private clearSlot(slot: Slot): void {
    for (const key of slot.emoteKeys) {
      this.textures.release(key);
    }
    for (const key of slot.badgeKeys) {
      this.textures.release(key);
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
    slot.spansRaw = [];
    slot.linkSpans = [];
    slot.mentionSpans = [];
    slot.wrapLines = [{ start: 0, end: 0 }];
    slot.lineCount = 1;
    slot.startRow = 0;
    slot.highlightColor = "";
    slot.highlight.clear();
    slot.mentions.clear();
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
      this.textures.release(key);
    }
    for (const key of slot.badgeKeys) {
      this.textures.release(key);
    }
    slot.emoteKeys = [];
    slot.badgeKeys = [];
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
      slot.emoteKeys.push(key);
      this.textures.acquire(key);
      void this.textures.load(key, span.url).then((tex) => {
        if (tex && slot.msgId === msgId) {
          applySpriteTexture(spr, tex, this.lineHeight - 4);
        }
      });
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
      void this.textures.load(key, badge.url).then((tex) => {
        if (tex && slot.msgId === msgId) {
          applySpriteTexture(spr, tex, this.badgeSize);
        }
      });
    }
  }

  private line(event: ChatEvent): Drawn {
    const time = formatTime(event.timestampMs);
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
    const timeW = this.showTimestamps ? 5 * this.charWidth + TIME_GAP : 0;
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
    const lines = wrapBody(
      slot.bodyRaw,
      maxBodyChars(this.app.screen.width, bodyX, this.charWidth),
      slot.spansRaw,
    );
    slot.wrapLines = lines;
    slot.lineCount = lines.length;
    slot.body.text = renderWrapped(slot.bodyRaw, lines, slot.spansRaw);
    if (slot.root.hitArea instanceof Rectangle) {
      slot.root.hitArea.height = slot.lineCount * this.lineHeight;
    }
    this.paintHighlight(slot);
    this.paintMentions(slot, bodyX);
    let prevX = 0;
    let prevY = 0;
    let hasPrev = false;
    for (let i = 0; i < slot.emotes.length; i += 1) {
      const spr = slot.emotes[i];
      const span = slot.spansRaw[i];
      if (!span) {
        spr.visible = false;
        continue;
      }
      if (span.zeroWidth && hasPrev) {
        spr.visible = true;
        spr.x = prevX;
        spr.y = prevY;
        continue;
      }
      const pos = indexToLineCol(slot.bodyRaw, lines, span.start, slot.spansRaw);
      if (!pos) {
        spr.visible = false;
        continue;
      }
      spr.visible = true;
      spr.x = bodyX + pos.col * this.charWidth;
      spr.y = 1 + pos.line * this.lineHeight;
      prevX = spr.x;
      prevY = spr.y;
      hasPrev = true;
    }
  }

  private paintHighlight(slot: Slot): void {
    slot.highlight.clear();
    const parsed = parseHighlight(slot.highlightColor);
    if (!parsed) {
      return;
    }
    slot.highlight
      .rect(0, 0, this.app.screen.width, slot.lineCount * this.lineHeight)
      .fill({ color: parsed.color, alpha: parsed.alpha });
  }

  private paintMentions(slot: Slot, bodyX: number): void {
    slot.mentions.clear();
    for (const span of slot.mentionSpans) {
      for (const line of slot.wrapLines) {
        const a = Math.max(span.start, line.start);
        const b = Math.min(span.end, line.end);
        if (a >= b) {
          continue;
        }
        const start = indexToLineCol(slot.bodyRaw, slot.wrapLines, a, slot.spansRaw);
        const end = indexToLineCol(
          slot.bodyRaw,
          slot.wrapLines,
          Math.max(a, b - 1),
          slot.spansRaw,
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
      slot.root.visible = live;
      if (!live) {
        continue;
      }
      slot.root.y = row * this.lineHeight;
      this.paintClip(slot);
      slot.startRow = row;
      row += slot.lineCount;
    }
    const viewRows = this.app.screen.height / this.lineHeight;
    this.scroll.applyLayout(row, viewRows, this.laidSlots(), resolved);
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
    });
  }

  private onSlotMove(slot: Slot, ev: FederatedPointerEvent): void {
    slot.root.cursor = this.linkAt(slot, ev) ? "pointer" : "default";
  }

  private linkAt(slot: Slot, ev: FederatedPointerEvent): string | undefined {
    const local = ev.getLocalPosition(slot.root);
    if (local.x < slot.body.x || local.y < 0) {
      return undefined;
    }
    const col = Math.floor((local.x - slot.body.x) / this.charWidth);
    const line = Math.floor(local.y / this.lineHeight);
    const idx = lineColToIndex(slot.bodyRaw, slot.wrapLines, line, col, slot.spansRaw);
    if (idx === null) {
      return undefined;
    }
    const hit = slot.linkSpans.find((span) => idx >= span.start && idx < span.end);
    return hit?.url;
  }
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

function formatTime(ms: number): string {
  const d = new Date(ms);
  if (Number.isNaN(d.getTime())) {
    return "--:--";
  }
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
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
