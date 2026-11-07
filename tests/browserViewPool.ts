import { Texture } from "pixi.js";
import type { MessageRing } from "../src/chat/ring";
import type { MessageRow } from "../src/chat/messageRow";
import type { MessageRowView } from "../src/chat/messageRowView";
import type { ViewPool } from "../src/chat/viewPool";
import type { TextureLru } from "../src/chat/textures";
import type { ChatEvent, EmoteSpan } from "../src/chat/types";
import type { LaidSlot, ScrollModel } from "../src/chat/scroll";
import { historyRows, requireRowView, rowView } from "./browserRows";

const check = (value: unknown, message: string) => { if (!value) throw new Error(message); };
const frame = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
async function until(test: () => boolean) {
  const deadline = performance.now() + 10_000;
  while (!test()) { if (performance.now() > deadline) throw new Error("View pool did not settle"); await frame(); }
}

export async function checkViewPool(ring: MessageRing, restore: () => void) {
  const owner = ring as unknown as {
    poolSize: number; lineHeight: number; fontSize: number; chatFontFamily: string; chatFontSize: number; chatFontWeight: number;
    app: { screen: { height: number }; stage: { children: unknown[] } };
    viewPool: ViewPool<MessageRow, MessageRowView>;
    scroll: ScrollModel;
    laidSlots: () => LaidSlot[];
    textures: TextureLru;
  };
  const font = { family: owner.chatFontFamily, size: owner.chatFontSize, weight: owner.chatFontWeight };
  const message = (i: number): Extract<ChatEvent, { kind: "privmsg" }> => ({
    kind: "privmsg", id: `pool-row-${i}`, timestampMs: 1700000000000, userId: "1", login: "viewer", displayName: "Viewer", color: "#6699ff", badges: [],
    text: i % 7 === 0 ? "Variable message height. ".repeat(20) : `Message ${i}`, emoteSpans: [], action: false,
    ...(i === 5 ? { replyToId: "pool-row-0", replyToLogin: "viewer", replyToText: "Earlier message" } : {}),
  });
  const bindings = () => Array.from(owner.viewPool.bindings.values());
  const settle = async () => {
    await until(() => bindings().length > 0 && bindings().every(({ view }) => view.painted));
    await frame(); await frame();
  };
  const checkBudget = () => {
    const stats = ring.renderStats();
    const limit = 2 * (Math.ceil(owner.app.screen.height / owner.lineHeight) + 18) + 8;
    check(stats.views <= limit && stats.views <= stats.boundViews + 8, "view capacity is bounded by viewport bands and spare capacity");
    check(owner.app.stage.children.length === stats.views, "scene roots match actual allocated views");
    check(stats.historyRows === owner.poolSize, "view release retains the entire history");
    check(historyRows(ring).every((row) => !("root" in row)), "retained data does not own graphics");
    const geometry = owner.laidSlots();
    for (let i = 1; i < geometry.length; i += 1) {
      check(Math.abs(geometry[i - 1].startRow + geometry[i - 1].lineCount - geometry[i].startRow) < 0.00001,
        "scroll intervals remain contiguous for fractional pixel heights");
    }
  };
  const checkReading = (before: ReturnType<MessageRing["workspaceScroll"]>) => {
    const after = ring.workspaceScroll();
    check(after.anchor?.msgId === before.anchor?.msgId && after.anchor, "font changes preserve the reading message");
    check(Math.abs(after.anchor!.offsetFrac - before.anchor!.offsetFrac) < 0.02, "font changes preserve the position within the message");
  };
  const originalLoad = owner.textures.load;
  let finishOld: (texture: Texture | null) => void = () => {};
  try {
    ring.goToBottom();
    ring.applySnapshot(Array.from({ length: owner.poolSize }, (_, i) => message(i)));
    check(ring.restoreWorkspaceScroll({ atBottom: false, anchor: { msgId: "pool-row-500", offsetFrac: 0.4 }, rowsFromBottom: 0 }), "reading position resolves without a pre-existing view");
    await settle();
    const reading = ring.workspaceScroll();
    check(reading.anchor?.msgId === "pool-row-500", "reading position survives first lazy painting");
    ring.configureChatFont({ ...font, family: "monospace", size: font.size + 2 });
    await settle(); checkReading(reading); checkBudget();
    ring.configureChatFont(font);
    await settle(); checkReading(reading); checkBudget();
    const readingView = requireRowView(ring, historyRows(ring).find((row) => row.msgId === "pool-row-500"));
    readingView.root.emit("pointerdown", { pointerId: 38, button: 0 } as never);
    ring.applyLinkEnrichment("pool-row-500", { body: "Updated message", links: [], hosts: [], spans: [], mentions: [], clip: null });
    await settle();
    readingView.root.emit("pointertap", { pointerId: 38, button: 0 } as never);
    checkReading(reading);
    for (let i = 0; i < 20; i += 1) {
      ring.setDesired(i % 2 === 0 ? 0 : ring.scrollSnapshot().bottom, false);
      await settle(); checkBudget();
    }
    check(ring.contextForMsgId("pool-row-0", 0, 0)?.text === message(0).text, "offscreen context uses retained message data");
    check(ring.contextForMsgId("pool-row-5", 0, 0)?.replyToId === "pool-row-0", "offscreen reply context survives view reuse");
    const smooth = owner.scroll.isSmoothEnabled();
    const smoothNew = (owner.scroll as unknown as { smoothNewMessages: boolean }).smoothNewMessages;
    try {
      owner.scroll.configureSmooth({ enabled: true, newMessages: true });
      ring.setDesired(0, false);
      await settle();
      const first = historyRows(ring).find((row) => row.msgId === "pool-row-0")!;
      const last = historyRows(ring).find((row) => row.msgId === `pool-row-${owner.poolSize - 1}`)!;
      ring.goToBottom();
      check(rowView(ring, first) && rowView(ring, last), "smooth following retains current and target viewport bands");
      await until(() => { checkBudget(); return !owner.scroll.isAnimating(); });
      await settle();
      check(!rowView(ring, first) && rowView(ring, last)?.root.renderable, "finished following releases the old viewport");
    } finally {
      owner.scroll.configureSmooth({ enabled: smooth, newMessages: smoothNew });
    }

    const sharedKey = "7tv:pool-shared";
    const span: EmoteSpan = { start: 0, end: 6, provider: "7tv", emoteId: "pool-shared", url: "https://cdn.7tv.app/emote/pool-shared/1x.webp", zeroWidth: false };
    const count = owner.poolSize;
    const events: ChatEvent[] = Array.from({ length: count }, (_, i) => i < 60
      ? { kind: "notice", id: `pool-cloud-${i}`, timestampMs: 1700000000000, text: "Shared" }
      : { ...message(i), id: `pool-tail-${i}`, text: "Shared" });
    ring.goToBottom(); ring.applySnapshot(events);
    for (let i = 0; i < 60; i += 1) {
      ring.applyLinkEnrichment(`pool-cloud-${i}`, { body: "Shared", links: [], hosts: [], spans: [span], mentions: [], clip: null });
    }
    let oldPhase = true;
    const oldResult = new Promise<Texture | null>((resolve) => { finishOld = resolve; });
    owner.textures.load = function (...args) {
      if (args[0] === sharedKey) return oldPhase ? oldResult : Promise.resolve(Texture.WHITE);
      return originalLoad.apply(this, args);
    };
    ring.restoreWorkspaceScroll({ atBottom: false, anchor: { msgId: "pool-cloud-0", offsetFrac: 0 }, rowsFromBottom: 0 });
    await settle();
    const oldViews = new Set(bindings().filter(({ view }) => view.root.renderable).map(({ view }) => view));
    for (const view of oldViews) view.root.emit("pointerdown", { pointerId: 37, button: 0 } as never);
    for (let i = count - 60; i < count; i += 1) {
      ring.applyLinkEnrichment(`pool-tail-${i}`, { body: "Shared", links: [], hosts: [], spans: [span], mentions: [], clip: null });
    }
    oldPhase = false;
    ring.setDesired(ring.scrollSnapshot().bottom, false);
    await settle();
    await until(() => bindings().every(({ view }) => view.emotes[0]?.visible === true));
    const current = bindings().find(({ view, owner: row }) => oldViews.has(view) && row.msgId.startsWith("pool-tail-"));
    check(current, "a cloud view is reused for a different message");
    const reused = current!.view;
    const height = reused.emotes[0].height;
    reused.root.emit("pointertap", { pointerId: 37, button: 0 } as never);
    reused.root.emit("rightclick", { pointerId: 37, button: 2 } as never);
    finishOld(Texture.WHITE);
    await frame(); await frame();
    check(owner.viewPool.ownerOf(reused) === current!.owner && reused.emotes[0].height === height,
      "late shared-asset replies cannot repaint the new owner with the old cloud metrics");
    check(requireRowView(ring, current!.owner) === reused, "stale presses do not replace or act on a new owner");
    checkBudget();
    ring.reset();
    check(owner.viewPool.views.size > 0 && owner.viewPool.bindings.size === 0, "reset retains only unbound spare views");
    ring.configureChatFont({ ...font, size: font.size + 2 });
    check(Array.from(owner.viewPool.views).every((view) => view.time.style.fontSize === owner.fontSize),
      "font changes update spare views before they are reused");
    ring.applySnapshot([message(0)]);
    await settle();
    check(requireRowView(ring, historyRows(ring).find((row) => row.msgId === "pool-row-0")).time.style.fontSize === owner.fontSize,
      "rebound spare views use the current font metrics");
  } finally {
    finishOld(Texture.WHITE);
    owner.textures.load = originalLoad;
    ring.configureChatFont(font);
    restore();
    ring.goToBottom();
  }
}
