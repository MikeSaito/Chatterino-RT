import {
  ScrollModel,
  wheelDeltaRows,
  easeOutCubic,
  SMOOTH_SCROLL_MS,
  type LaidSlot,
} from "../src/chat/scroll.ts";

function slots(spec: Array<[string, number]>): LaidSlot[] {
  let row = 0;
  return spec.map(([msgId, lineCount]) => {
    const startRow = row;
    row += lineCount;
    return { msgId, startRow, lineCount };
  });
}

function assert(cond: boolean, msg: string): void {
  if (!cond) {
    throw new Error(msg);
  }
}

{
  const m = new ScrollModel();
  const laid = slots([
    ["a", 2],
    ["b", 2],
    ["c", 2],
  ]);
  m.applyLayout(6, 4, laid, undefined);
  assert(m.atBottom, "short content starts at bottom");
  assert(m.desired === 2, `bottom desired 2, got ${m.desired}`);
  const grown = slots([
    ["a", 2],
    ["b", 2],
    ["c", 2],
    ["d", 2],
  ]);
  m.applyLayout(8, 4, grown, undefined);
  assert(m.atBottom, "at bottom follows append");
  assert(m.desired === 4, `follow desired 4, got ${m.desired}`);
}

{
  const m = new ScrollModel();
  const laid = slots([
    ["a", 2],
    ["b", 2],
    ["c", 2],
    ["d", 2],
  ]);
  m.applyLayout(8, 4, laid, undefined);
  m.setDesired(2);
  assert(!m.atBottom, "setDesired leaves bottom");
  assert(m.desired === 2, `paused at 2, got ${m.desired}`);
  const grown = slots([
    ["a", 2],
    ["b", 2],
    ["c", 2],
    ["d", 2],
    ["e", 2],
  ]);
  const anchor = m.captureAnchor(laid);
  m.applyLayout(10, 4, grown, anchor);
  assert(!m.atBottom, "paused append stays paused");
  assert(Math.abs(m.desired - 2) < 1e-3, `anchor held at 2, got ${m.desired}`);
}

{
  const m = new ScrollModel();
  const laid = slots([
    ["a", 2],
    ["b", 2],
    ["c", 2],
    ["d", 2],
    ["e", 2],
  ]);
  m.applyLayout(10, 4, laid, undefined);
  m.setDesired(4);
  const anchor = m.captureAnchor(laid);
  assert(anchor?.msgId === "c", `anchor c, got ${anchor?.msgId}`);
  assert(Math.abs((anchor?.offsetFrac ?? -1) - 0) < 1e-3, `frac 0, got ${anchor?.offsetFrac}`);
  const afterEvict = slots([
    ["b", 2],
    ["c", 2],
    ["d", 2],
    ["e", 2],
    ["f", 2],
  ]);
  m.applyLayout(10, 4, afterEvict, anchor);
  assert(Math.abs(m.desired - 2) < 1e-3, `evict kept c at top, got ${m.desired}`);
  assert(!m.atBottom, "evict while paused stays paused");
}

{
  const m = new ScrollModel();
  const laid = slots([
    ["a", 2],
    ["b", 2],
    ["c", 2],
    ["d", 2],
    ["e", 2],
  ]);
  m.applyLayout(10, 4, laid, undefined);
  m.setDesired(4);
  const gone = slots([
    ["b", 2],
    ["d", 2],
    ["e", 2],
    ["f", 2],
  ]);
  m.applyLayout(8, 4, gone, m.captureAnchor(laid));
  assert(m.desired === 0, `missing anchor goes to top, got ${m.desired}`);
  assert(!m.atBottom, "missing anchor is not glued to bottom");
}

{
  const m = new ScrollModel();
  const laid = slots([
    ["a", 2],
    ["b", 2],
    ["c", 2],
    ["d", 2],
    ["e", 2],
  ]);
  m.applyLayout(10, 3, laid, undefined);
  m.setDesired(5);
  const anchor = m.captureAnchor(laid);
  assert(anchor?.msgId === "c", `mid-slot anchor c, got ${anchor?.msgId}`);
  assert(Math.abs((anchor?.offsetFrac ?? 0) - 0.5) < 1e-3, `frac 0.5, got ${anchor?.offsetFrac}`);
  const wrapped = slots([
    ["a", 4],
    ["b", 4],
    ["c", 4],
    ["d", 4],
    ["e", 4],
  ]);
  m.applyLayout(20, 3, wrapped, anchor);
  assert(Math.abs(m.desired - 10) < 1e-3, `wrap kept mid-slot, got ${m.desired}`);
}

{
  const m = new ScrollModel();
  m.applyLayout(10, 4, slots([["a", 10]]), undefined);
  m.setDesired(99);
  assert(m.atBottom, "clamp to bottom sets atBottom");
  assert(m.desired === 6, `clamped 6, got ${m.desired}`);
}

{
  const m = new ScrollModel();
  m.applyLayout(10, 4, slots([["a", 10]]), undefined);
  m.wheel(-100);
  assert(m.desired === 0, `wheel does not go below 0, got ${m.desired}`);
  assert(!m.atBottom, "scrolled to top is not at bottom");
  m.wheel(100);
  assert(m.atBottom, "wheel to bottom sets atBottom");
  assert(m.desired === 6, `wheel bottom 6, got ${m.desired}`);
}

{
  const m = new ScrollModel();
  m.applyLayout(3, 10, slots([["a", 3]]), undefined);
  assert(m.atBottom, "content shorter than view is at bottom");
  assert(m.desired === 0, `no overflow desired 0, got ${m.desired}`);
  m.wheel(2);
  assert(m.atBottom && m.desired === 0, "wheel ignored when no overflow");
}

{
  const m = new ScrollModel();
  m.applyLayout(10, 4, slots([["a", 10]]), undefined);
  m.setDesired(1);
  m.reset();
  assert(m.atBottom && m.desired === 0 && m.contentRows === 0, "reset clears");
}

{
  const px = wheelDeltaRows(44, 0, 22, 10);
  assert(px === 2, `pixel delta 2 rows, got ${px}`);
  const lines = wheelDeltaRows(-3, 1, 22, 10);
  assert(lines === -3, `line delta, got ${lines}`);
  const page = wheelDeltaRows(1, 2, 22, 10);
  assert(page === 10, `page delta, got ${page}`);
  assert(Math.abs(px * 2 - 4) < 1e-9, "multiplier scales wheel rows");
}

{
  const m = new ScrollModel();
  const laid = slots([
    ["a", 2],
    ["b", 2],
    ["c", 2],
    ["d", 2],
  ]);
  m.applyLayout(8, 4, laid, undefined);
  assert(m.atBottom && m.desired === 4, "setup at bottom");
  const grown = slots([
    ["a", 2],
    ["b", 2],
    ["c", 2],
    ["d", 2],
    ["e", 2],
  ]);
  m.applyLayout(10, 4, grown, undefined, true);
  assert(!m.atBottom, "paused follow leaves atBottom");
  assert(Math.abs(m.desired - 4) < 1e-3, `paused holds prev bottom 4, got ${m.desired}`);
  m.applyLayout(12, 4, slots([
    ["a", 2],
    ["b", 2],
    ["c", 2],
    ["d", 2],
    ["e", 2],
    ["f", 2],
  ]), undefined, true);
  assert(!m.atBottom, "paused stays not atBottom after more growth");
  assert(Math.abs(m.desired - 4) < 1e-3, `still held while paused, got ${m.desired}`);
  // Unpause resume: goToBottom (ring followIntent) returns to live.
  m.goToBottom();
  assert(m.atBottom && m.desired === 8, "manual goToBottom resumes bottom");
}

{
  assert(Math.abs(easeOutCubic(0)) < 1e-9, "ease 0");
  assert(Math.abs(easeOutCubic(1) - 1) < 1e-9, "ease 1");
  assert(easeOutCubic(0.5) > 0.5, "easeOutCubic past midpoint");

  const m = new ScrollModel();
  m.configureSmooth({ enabled: true, newMessages: false });
  m.applyLayout(20, 4, slots([["a", 20]]), undefined);
  assert(m.desired === 16 && m.current === 16, "snap at bottom");
  m.setDesired(4, true);
  assert(m.isAnimating(), "setDesired animated starts tween");
  assert(m.desired === 4, "desired target 4");
  assert(Math.abs(m.current - 16) < 1e-3, "current still at start");
  m.tick(0);
  m.tick(SMOOTH_SCROLL_MS / 2);
  assert(m.current < 16 && m.current > 4, `mid tween current ${m.current}`);
  m.tick(SMOOTH_SCROLL_MS);
  assert(!m.isAnimating(), "tween done");
  assert(Math.abs(m.current - 4) < 1e-3, `end at 4, got ${m.current}`);

  m.setDesired(10, true);
  m.tick(0);
  m.setDesired(2, true);
  assert(m.isAnimating(), "retarget keeps animating");
  m.tick(1000);
  m.tick(1000 + SMOOTH_SCROLL_MS);
  assert(Math.abs(m.current - 2) < 1e-3, `retarget ends at 2, got ${m.current}`);

  m.setDesired(8, false);
  assert(!m.isAnimating() && Math.abs(m.current - 8) < 1e-3, "snap setDesired");

  m.configureSmooth({ enabled: true, newMessages: true });
  m.goToBottom(true);
  assert(m.isAnimating() || Math.abs(m.current - m.desired) < 1e-3, "goToBottom anim or already there");
  m.tick(2000);
  m.tick(2000 + SMOOTH_SCROLL_MS);
  assert(m.atBottom && Math.abs(m.current - m.desired) < 1e-3, "goToBottom settles");

  m.configureSmooth({ enabled: false, newMessages: true });
  m.setDesired(2, false);
  m.goToBottom();
  assert(!m.isAnimating() && Math.abs(m.current - m.desired) < 1e-3, "newMessages needs smoothEnabled");

  m.configureSmooth({ enabled: true, newMessages: false });
  m.applyLayout(20, 4, slots([["a", 20]]), undefined);
  assert(!m.isAnimating() && m.current === m.desired, "first layout snaps");
  m.applyLayout(24, 4, slots([["a", 24]]), undefined);
  assert(!m.isAnimating() && m.current === m.desired, "follow without newMessages snaps");
}

console.log("scroll tests ok");
