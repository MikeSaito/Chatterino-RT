import type { MessageRing } from "../src/chat/ring";
import type { ChatEvent } from "../src/chat/types";
import type { BitmapText, Sprite } from "pixi.js";

const check = (value: unknown, message: string) => { if (!value) throw new Error(message); };
const frame = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));

export async function checkHistoryWidgets(ring: MessageRing, send: (event: ChatEvent) => void, restore: () => void) {
  const owner = ring as unknown as {
    slots: { msgId: string; mentionTexts: BitmapText[]; hostTexts: BitmapText[]; caughtTexts: BitmapText[]; modBtns: BitmapText[]; clipUi: unknown; emotes: Sprite[]; badges: Sprite[]; modIcons: Sprite[] }[];
  };
  check(owner.slots.every((slot) => slot.mentionTexts.length + slot.hostTexts.length + slot.caughtTexts.length + slot.modBtns.length === 0), "plain history must not preallocate optional text layers");
  check(owner.slots.every((slot) => slot.clipUi === null), "plain history must not preallocate clip cards");
  check(owner.slots.every((slot) => slot.emotes.length + slot.badges.length + slot.modIcons.length === 0), "plain history must not preallocate image sprites");
  const base: Extract<ChatEvent, { kind: "privmsg" }> = {
    kind: "privmsg", id: "memory-mention", timestampMs: Date.now(), userId: "1", login: "viewer", displayName: "Viewer", color: "#6699ff", badges: [],
    text: "@Other hello", emoteSpans: [], mentionSpans: [{ start: 0, end: 6, login: "other" }], action: false,
  };
  ring.goToBottom();
  send(base);
  send({ kind: "automodHeld", id: "memory-automod", timestampMs: Date.now(), messageId: "held", channelId: "1", authorUserId: "1", authorLogin: "viewer", authorDisplayName: "Viewer", text: "caught content", caughtRanges: [{ start: 0, end: 6 }], status: "pending" });
  for (let i = 0; i < 10; i += 1) await frame();
  const mention = owner.slots.find((slot) => slot.msgId === base.id)!;
  const held = owner.slots.find((slot) => slot.msgId === "memory-automod")!;
  check(mention?.mentionTexts.some((text) => text.visible && text.text === "@Other"), "mention formatting is rendered");
  check(held?.caughtTexts.some((text) => text.visible && text.text === "caught"), "caught message range is rendered");
  check(held?.modBtns.filter((text) => text.visible).length === 2, "both moderation actions are rendered");
  ring.applyLinkEnrichment(base.id, { body: "Title (example.test)", links: [], hosts: [{ start: 6, end: 20 }], spans: [], mentions: [], clip: null });
  await frame(); await frame();
  check(mention.hostTexts.some((text) => text.visible && text.text.includes("example.test")), "resolved host suffix is rendered");
  send({ kind: "automodStatus", id: "memory-allowed", timestampMs: Date.now(), targetId: "memory-automod", status: "allowed" });
  await frame(); await frame();
  check(held.modBtns.length === 0, "completed moderation actions release their text objects");
  const optional = [...mention.hostTexts, ...held.caughtTexts];
  restore();
  check(optional.every((text) => text.destroyed), "replacing history destroys text layers from the previous rows");
  check(owner.slots.every((slot) => slot.mentionTexts.length + slot.hostTexts.length + slot.caughtTexts.length + slot.modBtns.length === 0), "plain history does not retain old overlays");
  ring.goToBottom();
}
