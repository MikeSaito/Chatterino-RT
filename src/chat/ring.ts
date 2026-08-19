import {
  BitmapFont,
  BitmapText,
  Container,
  Sprite,
  Texture,
  type Application,
} from "pixi.js";
import {
  CHAR_WIDTH,
  EMOTE_SLOTS_PER_ROW,
  FONT_SIZE,
  LINE_HEIGHT,
  MESSAGE_POOL_SIZE,
} from "../constants";
import type { ChatEvent, EmoteSpan } from "./types";
import { TextureLru } from "./textures";

type Slot = {
  root: Container;
  nick: BitmapText;
  body: BitmapText;
  emotes: Sprite[];
  emoteKeys: string[];
  msgId: string;
  login: string;
  bodyRaw: string;
  spansRaw: EmoteSpan[];
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
    for (let i = 0; i < MESSAGE_POOL_SIZE; i += 1) {
      const root = new Container();
      root.visible = false;
      const nick = new BitmapText({
        text: "",
        style: { fontFamily: "ChatFont", fontSize: FONT_SIZE, fill: 0xffffff },
      });
      const body = new BitmapText({
        text: "",
        style: { fontFamily: "ChatFont", fontSize: FONT_SIZE, fill: 0xefeff1 },
      });
      body.x = 120;
      const emotes: Sprite[] = [];
      for (let e = 0; e < EMOTE_SLOTS_PER_ROW; e += 1) {
        const spr = new Sprite(Texture.EMPTY);
        spr.visible = false;
        spr.width = LINE_HEIGHT - 4;
        spr.height = LINE_HEIGHT - 4;
        spr.y = 1;
        root.addChild(spr);
        emotes.push(spr);
      }
      root.addChild(nick, body);
      stage.addChild(root);
      this.slots.push({
        root,
        nick,
        body,
        emotes,
        emoteKeys: [],
        msgId: "",
        login: "",
        bodyRaw: "",
        spansRaw: [],
      });
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
    if (event.kind === "clearchat" && event.targetLogin) {
      this.hideByLogin(event.targetLogin);
      return;
    }
    if (event.kind === "clearchat") {
      this.resetSlots();
      return;
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
    slot.emoteKeys = [];
    slot.root.visible = false;
    slot.nick.text = "";
    slot.body.text = "";
    slot.msgId = "";
    slot.login = "";
    slot.bodyRaw = "";
    slot.spansRaw = [];
    for (const spr of slot.emotes) {
      spr.visible = false;
      spr.texture = Texture.EMPTY;
    }
  }

  private write(slot: Slot, event: ChatEvent): void {
    slot.root.visible = true;
    slot.msgId = event.id;
    slot.login = "login" in event && typeof event.login === "string" ? event.login.toLowerCase() : "";
    const drawn = this.line(event);
    slot.nick.text = drawn.nick;
    slot.nick.tint = drawn.nickColor;
    slot.bodyRaw = drawn.body;
    slot.spansRaw = drawn.spans;
    for (const key of slot.emoteKeys) {
      this.textures.release(key);
    }
    slot.emoteKeys = [];
    for (let i = 0; i < slot.emotes.length; i += 1) {
      const spr = slot.emotes[i];
      const span = drawn.spans[i];
      if (!span) {
        spr.visible = false;
        spr.texture = Texture.EMPTY;
        continue;
      }
      const key = `${span.provider}:${span.emoteId}`;
      slot.emoteKeys.push(key);
      this.textures.acquire(key);
      void this.textures.load(key, span.url).then((tex) => {
        if (tex && slot.msgId === event.id) {
          spr.texture = tex;
        }
      });
    }
  }

  private line(event: ChatEvent): { nick: string; nickColor: number; body: string; spans: EmoteSpan[] } {
    switch (event.kind) {
      case "privmsg": {
        const prefix = event.action ? "* " : "";
        const shift = prefix.length;
        return {
          nick: event.displayName || event.login,
          nickColor: parseColor(event.color),
          body: `${prefix}${event.text}`,
          spans: event.emoteSpans.map((span) => ({
            ...span,
            start: span.start + shift,
            end: span.end + shift,
          })),
        };
      }
      case "usernotice":
        return {
          nick: "*",
          nickColor: 0xadadc0,
          body: event.systemText,
          spans: [],
        };
      case "roomstate":
        return {
          nick: "*",
          nickColor: 0xadadc0,
          body: `emote:${event.emoteOnly} subs:${event.subsOnly} slow:${event.slowSec}`,
          spans: [],
        };
      case "notice":
        return {
          nick: "*",
          nickColor: 0xadadc0,
          body: event.text,
          spans: [],
        };
      default:
        return { nick: "*", nickColor: 0xadadc0, body: event.kind, spans: [] };
    }
  }

  private paintClip(slot: Slot): void {
    const bodyX = Math.max(16, slot.nick.text.length * CHAR_WIDTH + 16);
    slot.body.x = bodyX;
    const clipped = clipLine(slot.bodyRaw, maxBodyChars(this.app.screen.width, bodyX));
    slot.body.text = clipped.text;
    for (let i = 0; i < slot.emotes.length; i += 1) {
      const spr = slot.emotes[i];
      const span = slot.spansRaw[i];
      if (!span || span.start >= clipped.visible) {
        spr.visible = false;
        continue;
      }
      spr.visible = true;
      spr.x = bodyX + span.start * CHAR_WIDTH;
    }
  }

  private layout(): void {
    const h = this.app.screen.height;
    const start = (this.head - this.occupied + MESSAGE_POOL_SIZE) % MESSAGE_POOL_SIZE;
    for (let i = 0; i < this.occupied; i += 1) {
      const slot = this.slots[(start + i) % MESSAGE_POOL_SIZE];
      slot.root.y = i * LINE_HEIGHT;
      slot.root.visible = slot.msgId.length > 0;
      this.paintClip(slot);
    }
    const content = this.occupied * LINE_HEIGHT;
    this.app.stage.y = content > h ? h - content : 0;
  }
}

function parseColor(color: string): number {
  const m = /^#?([0-9a-fA-F]{6})$/.exec(color);
  if (!m) {
    return 0xbf94ff;
  }
  return Number.parseInt(m[1], 16);
}

function maxBodyChars(paneWidth: number, bodyX: number): number {
  return Math.floor(Math.max(0, paneWidth - bodyX - 8) / CHAR_WIDTH);
}

function clipLine(text: string, maxChars: number): { text: string; visible: number } {
  if (maxChars <= 0) {
    return { text: "", visible: 0 };
  }
  if (text.length <= maxChars) {
    return { text, visible: text.length };
  }
  const keep = maxChars <= 3 ? maxChars : maxChars - 3;
  const visible = utf16Fit(text, keep);
  if (maxChars <= 3) {
    return { text: text.slice(0, visible), visible };
  }
  return { text: `${text.slice(0, visible)}...`, visible };
}

function utf16Fit(text: string, n: number): number {
  if (n <= 0) {
    return 0;
  }
  if (n >= text.length) {
    return text.length;
  }
  const c = text.charCodeAt(n - 1);
  if (c >= 0xd800 && c <= 0xdbff) {
    return n - 1;
  }
  return n;
}
