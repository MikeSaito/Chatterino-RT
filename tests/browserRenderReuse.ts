import type { BitmapText } from "pixi.js";
import type { MessageRing } from "../src/chat/ring";
import type { ChatEvent } from "../src/chat/types";
import type { ThemePixiFills } from "../src/shell/theme";

const check = (value: unknown, message: string) => { if (!value) throw new Error(message); };
const frame = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
async function settle() { for (let i = 0; i < 4; i += 1) await frame(); }

export async function checkRenderReuse(ring: MessageRing, restore: () => void) {
  type TextPipe = { _updateContext: (text: BitmapText, proxy: unknown) => void };
  const owner = ring as unknown as {
    app: { renderer: { renderPipes: { bitmapText: TextPipe } } };
    themeFills: ThemePixiFills; chatFontFamily: string; chatFontSize: number; chatFontWeight: number;
    slots: { msgId: string; time: BitmapText; nick: BitmapText; body: BitmapText; bodyCont: BitmapText; clipUi: { duration: BitmapText; title: BitmapText; game: BitmapText; foot: BitmapText } | null }[];
  };
  const font = { family: owner.chatFontFamily, size: owner.chatFontSize, weight: owner.chatFontWeight };
  const theme = { ...owner.themeFills };
  const event: Extract<ChatEvent, { kind: "privmsg" }> = {
    kind: "privmsg", id: "render-reuse", timestampMs: 1700000000000, userId: "1", login: "viewer", displayName: "Viewer", color: "#6699ff", badges: [],
    text: "Repeated content. ".repeat(15), emoteSpans: [], action: false,
  };
  const payload = {
    body: event.text, links: [], hosts: [], spans: [], mentions: [],
    clip: { clipId: "render-reuse-clip", url: "https://clips.twitch.tv/Fixture", title: "Example clip", host: "clips.twitch.tv", thumbnailUrl: null, durationSec: 10, viewCount: 1, creatorName: "Viewer", broadcasterName: "Channel", gameName: "Example game", createdAt: null },
  };
  const counts = new Map<BitmapText, number>();
  const pipe = owner.app.renderer.renderPipes.bitmapText;
  const original = pipe._updateContext;
  pipe._updateContext = function (text, proxy) {
    counts.set(text, (counts.get(text) ?? 0) + 1);
    original.call(this, text, proxy);
  };
  try {
    ring.goToBottom();
    ring.applySnapshot([event]);
    ring.applyLinkEnrichment(event.id, payload);
    await settle();
    const slot = owner.slots.find((row) => row.msgId === event.id)!;
    const clip = slot.clipUi!;
    const texts = [slot.time, slot.nick, slot.body, slot.bodyCont, clip.duration, clip.title, clip.game, clip.foot];
    check(slot.body.text && slot.bodyCont.text && clip.title.text, "fixture paints multiline text and clip metadata");
    counts.clear();
    for (let i = 0; i < 3; i += 1) {
      ring.applyLinkEnrichment(event.id, payload);
      await settle();
    }
    check(texts.every((text) => !counts.get(text)), "unchanged content must reuse text geometry through real renderer frames");
    ring.applyLinkEnrichment(event.id, { ...payload, body: "Changed content" });
    await settle();
    check(slot.body.text.includes("Changed content") && (counts.get(slot.body) ?? 0) > 0, "changed content still rebuilds its text geometry");
    counts.clear();
    ring.applyThemeFills({ ...theme, body: 0x123456 });
    await settle();
    check(slot.body.style.fill === 0x123456 && (counts.get(slot.body) ?? 0) > 0, "theme changes update rendered body color");
    counts.clear();
    ring.configureChatFont({ ...font, family: font.family === "monospace" ? "serif" : "monospace" });
    await settle();
    check((counts.get(slot.body) ?? 0) > 0 && (counts.get(clip.title) ?? 0) > 0, "replaced font atlases rebuild unchanged message and clip text");
  } finally {
    pipe._updateContext = original;
    ring.configureChatFont(font);
    ring.applyThemeFills(theme);
    restore();
    ring.goToBottom();
  }
}
