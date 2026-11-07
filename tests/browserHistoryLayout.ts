import type { MessageRing } from "../src/chat/ring";
import type { LaidSlot } from "../src/chat/scroll";
import type { ChatEvent } from "../src/chat/types";
import type { MessageRow } from "../src/chat/messageRow";
import { rowView } from "./browserRows";

const check = (value: unknown, message: string) => { if (!value) throw new Error(message); };
const frame = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
const near = (actual: number, expected: number, message: string) => check(Math.abs(actual - expected) < 0.001, message);

export async function checkHistoryLayout(ring: MessageRing, hideModerated: (hidden: boolean) => Promise<void>) {
  const owner = ring as unknown as {
    poolSize: number; occupied: number; head: number; lineHeight: number;
    slots: MessageRow[];
    laidSlots: () => LaidSlot[];
    messageGapPx: () => number;
  };
  const message = (i: number): Extract<ChatEvent, { kind: "privmsg" }> => ({
    kind: "privmsg", id: `layout-${i}`, timestampMs: 1700000000000, userId: "1", login: "viewer", displayName: "Viewer", color: "#6699ff", badges: [],
    text: i % 7 === 0 ? "Variable height message. ".repeat(25) : `Message ${i}`, emoteSpans: [], action: false,
  });
  const verifyGeometry = () => {
    const start = (owner.head - owner.occupied + owner.poolSize) % owner.poolSize;
    const shown = Array.from({ length: owner.occupied }, (_, i) => owner.slots[(start + i) % owner.poolSize]).filter((slot) => slot.visible);
    const laid = owner.laidSlots();
    check(laid.length === shown.length, "scroll geometry contains exactly the visible history");
    let y = 0;
    for (let i = 0; i < shown.length; i += 1) {
      if (i > 0) y += owner.messageGapPx();
      near(shown[i].y, y, "plain text rows form a continuous stack with one gap between messages");
      const view = rowView(ring, shown[i]);
      if (view) near(view.root.y, shown[i].y, "bound display agrees with retained row geometry");
      y += shown[i].lineCount * owner.lineHeight;
      check(laid[i].msgId === shown[i].msgId, "scroll geometry follows history order after eviction and filtering");
      near(laid[i].startRow, shown[i].y / owner.lineHeight, "scroll geometry agrees with retained positions");
      near(laid[i].lineCount, shown[i].lineCount + (i + 1 < shown.length ? owner.messageGapPx() / owner.lineHeight : 0), "only non-final visible rows include the message gap");
    }
    near(ring.scrollSnapshot().contentRows, y / owner.lineHeight, "content height ends at the final visible row");
    return laid;
  };
  const checkAnchor = (before: ReturnType<MessageRing["workspaceScroll"]>) => {
    const after = ring.workspaceScroll();
    check(after.anchor?.msgId === before.anchor?.msgId && after.anchor, "reading position stays attached to the same message");
    near(after.anchor!.offsetFrac, before.anchor!.offsetFrac, "reading position keeps its offset within the message");
  };

  await hideModerated(false);
  ring.goToBottom();
  ring.applySnapshot(Array.from({ length: owner.poolSize }, (_, i) => message(i)));
  await frame(); await frame();
  const records = new Set(verifyGeometry());
  for (let repeat = 0; repeat < 20; repeat += 1) {
    check(verifyGeometry().every((row) => records.has(row)), "repeated history calculations reuse row geometry instead of allocating records");
  }
  ring.setDesired(ring.scrollSnapshot().bottom / 2, false);
  await frame(); await frame();
  const anchor = ring.workspaceScroll();
  ring.pushMany(Array.from({ length: 30 }, (_, i) => message(owner.poolSize + i)));
  checkAnchor(anchor);
  check(verifyGeometry().every((row) => records.has(row)), "ring eviction reuses the bounded geometry pool");

  const reading = ring.workspaceScroll();
  ring.applyLinkEnrichment("layout-40", { body: "Enriched content. ".repeat(100), links: [], hosts: [], spans: [], mentions: [], clip: null });
  checkAnchor(reading);
  verifyGeometry();

  ring.pushMany([30, owner.poolSize + 29].map((i) => ({ kind: "clearmsg" as const, id: `delete-${i}`, timestampMs: 1700000000000, targetId: `layout-${i}` })));
  await hideModerated(true);
  verifyGeometry();
  check(owner.laidSlots().length === owner.poolSize - 2, "hidden first and last messages leave no rows or trailing gap");
  await hideModerated(false);
  verifyGeometry();
  check(owner.laidSlots().length === owner.poolSize, "restoring moderated messages restores scroll geometry");

  ring.goToBottom();
  ring.applySnapshot([message(20000)]);
  verifyGeometry();
  check(owner.laidSlots().length === 1, "shorter snapshots discard stale geometry entries");
  ring.reset();
  check(owner.laidSlots().length === 0, "empty history has no stale geometry");
}
