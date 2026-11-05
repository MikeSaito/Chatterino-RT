import type { BitmapText, Graphics } from "pixi.js";
import type { MessageRing } from "../src/chat/ring";
import type { ChatEvent } from "../src/chat/types";
import type { ThemePixiFills } from "../src/shell/theme";
import { checkDetachedRowLayout } from "./browserDetachedRowLayout";

const check = (value: unknown, message: string) => { if (!value) throw new Error(message); };
const frame = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
async function settle() { for (let i = 0; i < 4; i += 1) await frame(); }

export async function checkRenderReuse(ring: MessageRing, restore: () => void) {
  checkDetachedRowLayout(ring);
  type TextPipe = { _updateContext: (text: BitmapText, proxy: unknown) => void };
  const owner = ring as unknown as {
    app: { renderer: { renderPipes: { bitmapText: TextPipe } } };
    themeFills: ThemePixiFills; chatFontFamily: string; chatFontSize: number; chatFontWeight: number;
    slots: { msgId: string; time: BitmapText; nick: BitmapText; body: BitmapText; bodyCont: BitmapText; highlight: Graphics; systemCloud: Graphics; mentions: Graphics; disabledGfx: Graphics; clipUi: { bg: Graphics; durationBg: Graphics; duration: BitmapText; title: BitmapText; game: BitmapText; foot: BitmapText } | null }[];
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
  const graphicUpdates = new Map<Graphics, number>();
  const unsubscribe: (() => void)[] = [];
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
    const graphics = [slot.highlight, slot.systemCloud, slot.mentions, slot.disabledGfx, clip.bg, clip.durationBg];
    for (const graphic of graphics) {
      const context = graphic.context;
      const updated = () => graphicUpdates.set(graphic, (graphicUpdates.get(graphic) ?? 0) + 1);
      context.on("update", updated);
      unsubscribe.push(() => context.off("update", updated));
    }
    check(slot.body.text && slot.bodyCont.text && clip.title.text, "fixture paints multiline text and clip metadata");
    counts.clear();
    for (let i = 0; i < 3; i += 1) {
      ring.applyLinkEnrichment(event.id, payload);
      await settle();
    }
    check(texts.every((text) => !counts.get(text)), "unchanged content must reuse text geometry through real renderer frames");
    check(graphics.every((graphic) => !graphicUpdates.get(graphic)), "unchanged content must retain its background geometry without clearing and redrawing");
    ring.applyLinkEnrichment(event.id, { ...payload, body: "Changed content" });
    await settle();
    check(slot.body.text.includes("Changed content") && (counts.get(slot.body) ?? 0) > 0, "changed content still rebuilds its text geometry");
    check((graphicUpdates.get(slot.disabledGfx) ?? 0) > 0, "height changes update the dimmed history background");
    graphicUpdates.clear();
    ring.applyLinkEnrichment(event.id, { ...payload, body: "Changed content", clip: { ...payload.clip, durationSec: 36000 } });
    await settle();
    check((graphicUpdates.get(clip.durationBg) ?? 0) > 0 && !graphicUpdates.get(clip.bg), "changing duration updates its label background without rebuilding the card border");
    counts.clear();
    ring.applyThemeFills({ ...theme, body: 0x123456 });
    await settle();
    check(slot.body.style.fill === 0x123456 && (counts.get(slot.body) ?? 0) > 0, "theme changes update rendered body color");
    ring.scrollToMsgId(event.id);
    await settle();
    check(slot.highlight.context.bounds.width > 0, "search selection paints a background");
    ring.clearFindHit();
    await settle();
    check(slot.highlight.context.bounds.width === 0, "clearing search removes the previous background");
    counts.clear();
    ring.configureChatFont({ ...font, family: font.family === "monospace" ? "serif" : "monospace" });
    await settle();
    check((counts.get(slot.body) ?? 0) > 0 && (counts.get(clip.title) ?? 0) > 0, "replaced font atlases rebuild unchanged message and clip text");
    ring.applySnapshot(Array.from({ length: owner.slots.length }, (_, i) => ({ ...event, id: `reuse-row-${i}`, text: `Message ${i}` })));
    ring.setDesired(0, false);
    await settle();
    const recycled = owner.slots.find((row) => row.msgId === "reuse-row-0")!;
    check(recycled.nick.text === "Viewer:", "oldest row has rendered nickname geometry before reuse");
    ring.goToBottom();
    await settle();
    counts.clear();
    ring.pushMany([{ ...event, id: "reuse-row-next", text: "Recycled body" }]);
    await settle();
    check(owner.slots.find((row) => row.msgId === "reuse-row-next")?.nick === recycled.nick, "live append reuses the oldest row");
    check(!counts.get(recycled.nick), "recycling a row for the same author retains its unchanged nickname geometry");
    const notice = { kind: "notice" as const, id: "render-cloud", timestampMs: 1700000000000, text: "System message" };
    ring.applySnapshot([notice]);
    await settle();
    const cloud = owner.slots.find((row) => row.msgId === notice.id)!;
    let cloudUpdates = 0;
    const updated = () => cloudUpdates += 1;
    cloud.systemCloud.context.on("update", updated);
    unsubscribe.push(() => cloud.systemCloud.context.off("update", updated));
    counts.clear();
    ring.applyLinkEnrichment(notice.id, { ...payload, body: notice.text, clip: null });
    await settle();
    check(cloudUpdates === 0 && !counts.get(cloud.body), "unchanged system messages retain their rounded background and text geometry");
    ring.applyLinkEnrichment(notice.id, { ...payload, body: "Long system content. ".repeat(30), clip: null });
    await settle();
    check(cloudUpdates > 0 && (counts.get(cloud.body) ?? 0) > 0, "system message size and text still update together");
  } finally {
    for (const off of unsubscribe) off();
    pipe._updateContext = original;
    ring.configureChatFont(font);
    ring.applyThemeFills(theme);
    restore();
    ring.goToBottom();
  }
}
