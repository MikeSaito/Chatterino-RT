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
      this.slots.push({ root, nick, body, emotes, emoteKeys: [], msgId: "", login: "" });
    }
    this.ready = true;
    this.app.renderer.on("resize", () => this.layout());
  }

  reset(): void {
    this.occupied = 0;
    this.head = 0;
    for (const slot of this.slots) {
      this.clearSlot(slot);
    }
    this.layout();
  }

  applySnapshot(events: ChatEvent[]): void {
    this.reset();
    const start = Math.max(0, events.length - MESSAGE_POOL_SIZE);
    for (let i = start; i < events.length; i += 1) {
      this.push(events[i]);
    }
  }

  push(event: ChatEvent): void {
    if (event.kind === "clearmsg") {
      this.hideById(event.targetId);
      return;
    }
    if (event.kind === "clearchat" && event.targetLogin) {
      this.hideByLogin(event.targetLogin);
      return;
    }
    if (event.kind === "clearchat") {
      this.reset();
      return;
    }
    const slot = this.slots[this.head];
    this.write(slot, event);
    this.head = (this.head + 1) % MESSAGE_POOL_SIZE;
    if (this.occupied < MESSAGE_POOL_SIZE) {
      this.occupied += 1;
    }
    this.layout();
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
    slot.body.text = drawn.body;
    slot.body.x = Math.max(16, drawn.nick.length * CHAR_WIDTH + 16);
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
      spr.visible = true;
      spr.x = slot.body.x + span.start * CHAR_WIDTH;
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

  private layout(): void {
    const h = this.app.renderer.height;
    const start = (this.head - this.occupied + MESSAGE_POOL_SIZE) % MESSAGE_POOL_SIZE;
    for (let i = 0; i < this.occupied; i += 1) {
      const slot = this.slots[(start + i) % MESSAGE_POOL_SIZE];
      slot.root.y = i * LINE_HEIGHT;
      slot.root.visible = slot.msgId.length > 0;
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
