import {
  BitmapFont,
  BitmapText,
  Container,
  FederatedPointerEvent,
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
import type { Badge, ChatEvent, EmoteSpan, LinkSpan } from "./types";
import { TextureLru } from "./textures";
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

type Slot = {
  root: Container;
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
  spansRaw: EmoteSpan[];
  linkSpans: LinkSpan[];
  wrapLines: WrapLine[];
  lineCount: number;
};

type Drawn = {
  time: string;
  nick: string;
  nickColor: number;
  body: string;
  spans: EmoteSpan[];
  links: LinkSpan[];
  badges: Badge[];
};

export class MessageRing {
  private readonly slots: Slot[] = [];
  private readonly textures: TextureLru;
  private occupied = 0;
  private head = 0;
  private ready = false;

  constructor(
    private readonly app: Application,
    textures: TextureLru,
  ) {
    this.textures = textures;
  }

  async init(): Promise<void> {
    if (this.ready) {
      return;
    }
    BitmapFont.install({
      name: "ChatFont",
      style: {
        fontFamily: "Consolas, Cascadia Mono, monospace",
        fontSize: FONT_SIZE,
        fill: "#efeff1",
      },
      chars: [
        ["\u0020", "\u007e"],
        ["\u0400", "\u04FF"],
      ],
    });
    const stage = this.app.stage;
    stage.eventMode = "static";
    for (let i = 0; i < MESSAGE_POOL_SIZE; i += 1) {
      const root = new Container();
      root.visible = false;
      root.eventMode = "static";
      root.hitArea = new Rectangle(0, 0, 1, LINE_HEIGHT);
      const time = new BitmapText({
        text: "",
        style: { fontFamily: "ChatFont", fontSize: FONT_SIZE, fill: 0xadadc0 },
      });
      const nick = new BitmapText({
        text: "",
        style: { fontFamily: "ChatFont", fontSize: FONT_SIZE, fill: 0xffffff },
      });
      const body = new BitmapText({
        text: "",
        style: {
          fontFamily: "ChatFont",
          fontSize: FONT_SIZE,
          fill: 0xefeff1,
          lineHeight: LINE_HEIGHT,
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
        spr.y = (LINE_HEIGHT - BADGE_SIZE) / 2;
        badges.push(spr);
      }
      root.addChild(time, nick, body, ...badges, ...emotes);
      const slot: Slot = {
        root,
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
        spansRaw: [],
        linkSpans: [],
        wrapLines: [{ start: 0, end: 0 }],
        lineCount: 1,
      };
      root.on("pointertap", (ev: FederatedPointerEvent) => {
        this.onSlotTap(slot, ev);
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
    this.resetSlots();
    const start = Math.max(0, events.length - MESSAGE_POOL_SIZE);
    this.pushMany(events.slice(start));
  }

  pushMany(events: ChatEvent[]): void {
    for (const event of events) {
      this.pushOne(event);
    }
    this.layout();
  }

  private resetSlots(): void {
    this.occupied = 0;
    this.head = 0;
    for (const slot of this.slots) {
      this.clearSlot(slot);
    }
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
    for (const slot of this.slots) {
      if (slot.msgId === id) {
        this.clearSlot(slot);
      }
    }
  }

  private hideByLogin(login: string): void {
    const needle = login.toLowerCase();
    for (const slot of this.slots) {
      if (slot.login === needle) {
        this.clearSlot(slot);
      }
    }
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
    slot.spansRaw = [];
    slot.linkSpans = [];
    slot.wrapLines = [{ start: 0, end: 0 }];
    slot.lineCount = 1;
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
    slot.msgId = event.id;
    slot.login = eventLogin(event);
    const drawn = this.line(event);
    slot.time.text = drawn.time;
    slot.nickRaw = drawn.nick;
    slot.nick.text = drawn.nick;
    slot.nick.tint = drawn.nickColor;
    slot.bodyRaw = drawn.body;
    slot.spansRaw = drawn.spans;
    slot.linkSpans = drawn.links;
    slot.badgesRaw = drawn.badges;
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
        if (tex && slot.msgId === event.id) {
          applySpriteTexture(spr, tex, LINE_HEIGHT - 4);
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
        if (tex && slot.msgId === event.id) {
          applySpriteTexture(spr, tex, BADGE_SIZE);
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
          spans: shiftSpans(event.emoteSpans ?? [], shift),
          links: shiftSpans(event.linkSpans ?? [], shift),
          badges: badgesWithUrl(event.badges ?? []),
        };
      }
      case "usernotice": {
        let body = event.systemText;
        let spans: EmoteSpan[] = [];
        let links: LinkSpan[] = [];
        let badges: Badge[] = [];
        if (event.privmsg && event.privmsg.kind === "privmsg") {
          const inner = event.privmsg;
          const sep = body.length > 0 ? " " : "";
          const innerPrefix = inner.action ? "* " : "";
          const shift = body.length + sep.length + innerPrefix.length;
          body += `${sep}${innerPrefix}${inner.text}`;
          spans = shiftSpans(inner.emoteSpans ?? [], shift);
          links = shiftSpans(inner.linkSpans ?? [], shift);
          badges = badgesWithUrl(inner.badges ?? []);
        }
        return {
          time,
          nick: "*",
          nickColor: 0xadadc0,
          body,
          spans,
          links,
          badges,
        };
      }
      case "clearchat":
        return {
          time,
          nick: "*",
          nickColor: 0xadadc0,
          body: clearchatText(event.targetLogin, event.durationSec),
          spans: [],
          links: [],
          badges: [],
        };
      case "roomstate":
        return {
          time,
          nick: "*",
          nickColor: 0xadadc0,
          body: `emote:${event.emoteOnly} subs:${event.subsOnly} slow:${event.slowSec}`,
          spans: [],
          links: [],
          badges: [],
        };
      case "notice":
        return {
          time,
          nick: "*",
          nickColor: 0xadadc0,
          body: event.text,
          spans: [],
          links: [],
          badges: [],
        };
      default:
        return {
          time,
          nick: "*",
          nickColor: 0xadadc0,
          body: event.kind,
          spans: [],
          links: [],
          badges: [],
        };
    }
  }

  private paintClip(slot: Slot): void {
    const timeW = 5 * CHAR_WIDTH + TIME_GAP;
    slot.time.x = 0;
    const badgeN = slot.badgesRaw.length;
    const badgeBand =
      badgeN === 0 ? 0 : badgeN * BADGE_SIZE + (badgeN - 1) * BADGE_GAP;
    for (let i = 0; i < slot.badges.length; i += 1) {
      const spr = slot.badges[i];
      const badge = slot.badgesRaw[i];
      if (!badge) {
        spr.visible = false;
        continue;
      }
      spr.visible = true;
      spr.x = timeW + i * (BADGE_SIZE + BADGE_GAP);
    }
    slot.nick.x = timeW + badgeBand;
    const paneW = this.app.screen.width;
    const nickMaxPx = Math.max(
      8,
      paneW - timeW - badgeBand - TIME_GAP - 8 - MIN_BODY_CHARS * CHAR_WIDTH,
    );
    const nickMaxChars = Math.max(2, Math.floor(nickMaxPx / CHAR_WIDTH));
    slot.nick.text = clipNick(slot.nickRaw, nickMaxChars);
    const nickW = Math.max(slot.nick.text.length * CHAR_WIDTH, 8);
    const bodyX = timeW + badgeBand + nickW + TIME_GAP;
    slot.body.x = bodyX;
    if (slot.root.hitArea instanceof Rectangle) {
      slot.root.hitArea.width = this.app.screen.width;
    }
    const lines = wrapBody(
      slot.bodyRaw,
      maxBodyChars(this.app.screen.width, bodyX),
      slot.spansRaw,
    );
    slot.wrapLines = lines;
    slot.lineCount = lines.length;
    slot.body.text = renderWrapped(slot.bodyRaw, lines, slot.spansRaw);
    if (slot.root.hitArea instanceof Rectangle) {
      slot.root.hitArea.height = slot.lineCount * LINE_HEIGHT;
    }
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
      spr.x = bodyX + pos.col * CHAR_WIDTH;
      spr.y = 1 + pos.line * LINE_HEIGHT;
      prevX = spr.x;
      prevY = spr.y;
      hasPrev = true;
    }
  }

  private layout(): void {
    const h = this.app.screen.height;
    const start = (this.head - this.occupied + MESSAGE_POOL_SIZE) % MESSAGE_POOL_SIZE;
    let row = 0;
    for (let i = 0; i < this.occupied; i += 1) {
      const slot = this.slots[(start + i) % MESSAGE_POOL_SIZE];
      const live = slot.msgId.length > 0;
      slot.root.visible = live;
      if (!live) {
        continue;
      }
      slot.root.y = row * LINE_HEIGHT;
      this.paintClip(slot);
      row += slot.lineCount;
    }
    const content = row * LINE_HEIGHT;
    this.app.stage.y = content > h ? h - content : 0;
  }

  private onSlotTap(slot: Slot, ev: FederatedPointerEvent): void {
    const url = this.linkAt(slot, ev);
    if (!url) {
      return;
    }
    void invoke("open_chat_link", { url }).catch(() => undefined);
  }

  private onSlotMove(slot: Slot, ev: FederatedPointerEvent): void {
    slot.root.cursor = this.linkAt(slot, ev) ? "pointer" : "default";
  }

  private linkAt(slot: Slot, ev: FederatedPointerEvent): string | undefined {
    const local = ev.getLocalPosition(slot.root);
    if (local.x < slot.body.x || local.y < 0) {
      return undefined;
    }
    const col = Math.floor((local.x - slot.body.x) / CHAR_WIDTH);
    const line = Math.floor(local.y / LINE_HEIGHT);
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

function applySpriteTexture(spr: Sprite, tex: Texture, size: number): void {
  spr.texture = tex;
  spr.width = size;
  spr.height = size;
}

function maxBodyChars(paneWidth: number, bodyX: number): number {
  return Math.floor(Math.max(1, paneWidth - bodyX - 8) / CHAR_WIDTH);
}
