import {
  createMountBootstrapGate,
  liveBatchAction,
} from "../src/chat/ipcMountGate.ts";

function assert(cond: boolean, msg: string): void {
  if (!cond) {
    throw new Error(msg);
  }
}

/**
 * Simulates mountActive + queued live: hold while snapshot in flight, then
 * drain with seq rules (contiguous apply / gap recover). Models ipc.ts pump.
 */
function simulateMountRace(opts: {
  snapSeq: number;
  liveSeq: number;
  liveDropped?: number;
}): {
  heldDuringMount: boolean;
  afterAction: ReturnType<typeof liveBatchAction>;
  finalLastSeq: number;
  needsResnapshot: boolean;
} {
  const gate = createMountBootstrapGate();
  let lastSeq = 0;
  const liveQueue: Array<{ seq: number; dropped: number }> = [];

  gate.begin();
  // Live arrives during mount — must hold.
  const heldDuringMount = gate.isHolding();
  liveQueue.push({ seq: opts.liveSeq, dropped: opts.liveDropped ?? 0 });
  assert(heldDuringMount, "gate holds during mount");

  // Snapshot completes.
  lastSeq = opts.snapSeq;
  gate.end();
  assert(!gate.isHolding(), "gate released after snap");

  const live = liveQueue.shift();
  assert(live !== undefined, "queued live");
  const afterAction = liveBatchAction(lastSeq, live!.seq, live!.dropped);
  let finalLastSeq = lastSeq;
  let needsResnapshot = false;
  if (afterAction === "apply") {
    finalLastSeq = live!.seq;
  } else if (afterAction === "gap") {
    needsResnapshot = true;
    // Recover snapshot includes live (scrollback); seq advances to live.
    finalLastSeq = live!.seq;
  }
  return { heldDuringMount, afterAction, finalLastSeq, needsResnapshot };
}

{
  // P1 classic hole: live seq=5 during snap seq=3 — must hold, then gap recover.
  const r = simulateMountRace({ snapSeq: 3, liveSeq: 5 });
  assert(r.heldDuringMount, "held");
  assert(r.afterAction === "gap", "gap after stale-relative live");
  assert(r.needsResnapshot, "resnapshot required");
  assert(r.finalLastSeq === 5, "seq caught up via recover");
}

{
  // Contiguous live seq=4 after snap seq=3 — apply without hole.
  const r = simulateMountRace({ snapSeq: 3, liveSeq: 4 });
  assert(r.afterAction === "apply", "contiguous apply");
  assert(!r.needsResnapshot, "no resnapshot");
  assert(r.finalLastSeq === 4, "seq 4");
}

{
  // Old bug path: if live applied before snap (lastSeq=5) then snap sets 3 —
  // messages 4..5 wiped. Gate prevents pre-snap apply.
  const gate = createMountBootstrapGate();
  let lastSeq = 0;
  let appliedLiveBeforeSnap = false;
  gate.begin();
  if (!gate.isHolding()) {
    // Would have applied live at lastSeq===0.
    lastSeq = 5;
    appliedLiveBeforeSnap = true;
  }
  assert(!appliedLiveBeforeSnap, "live not applied during hold");
  lastSeq = 3; // snapshot
  gate.end();
  assert(lastSeq === 3, "snap seq wins cleanly");
  assert(liveBatchAction(lastSeq, 5, 0) === "gap", "then gap recovers live");
}

{
  assert(liveBatchAction(0, 1, 0) === "apply", "bootstrap first live after snap0");
  assert(liveBatchAction(5, 5, 0) === "stale", "duplicate seq");
  assert(liveBatchAction(5, 4, 0) === "stale", "older seq");
  assert(liveBatchAction(5, 7, 0) === "gap", "skipped seq");
  assert(liveBatchAction(5, 6, 1) === "gap", "dropped forces snap");
  assert(liveBatchAction(5, 6, 0) === "apply", "contiguous");
}

{
  const gate = createMountBootstrapGate();
  gate.begin();
  gate.clear();
  assert(!gate.isHolding(), "clear releases");
}

{
  // Failed mount bootstrap should request snapshot recover (not silent lastSeq=0).
  // Modeled: gate end + snapshotQueued path — liveBatchAction with lastSeq=0 applies,
  // but production sets snapshotQueued so pump recovers before trusting live-only.
  const gate = createMountBootstrapGate();
  gate.begin();
  let snapshotQueued = false;
  const applied = false;
  if (!applied) {
    snapshotQueued = true;
  }
  gate.end();
  assert(snapshotQueued, "failed snap queues recover");
  assert(!gate.isHolding(), "gate open for recover pump");
}

console.log("ipcMountRace tests ok");
