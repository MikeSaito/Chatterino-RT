import {
  createLinkEnrichmentPump,
  LINK_ENRICH_MAX_INFLIGHT,
} from "../src/chat/linkEnrichmentPump.ts";

function assert(cond: boolean, msg: string): void {
  if (!cond) {
    throw new Error(msg);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function main(): Promise<void> {
  {
    // P0: second afterIds must not cancel first inflight.
    const applied: string[] = [];
    const started: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const eligible = new Set(["m1", "m2"]);

    const pump = createLinkEnrichmentPump({
      isEligible: (id) => eligible.has(id) && !applied.includes(id),
      enrich: async (id, isCurrent) => {
        started.push(id);
        await gate;
        if (!isCurrent()) {
          return;
        }
        applied.push(id);
      },
    });

    pump.afterIds(["m1"]);
    await sleep(5);
    assert(started.length === 1 && started[0] === "m1", "m1 started");
    assert(pump.inflightCount() === 1, "one inflight");

    pump.afterIds(["m2"]);
    await sleep(5);
    assert(started.includes("m1"), "m1 still counted (not cancelled)");
    assert(pump.inflightCount() >= 1, "inflight kept across batch");

    release();
    for (let i = 0; i < 40; i += 1) {
      if (applied.includes("m1") && applied.includes("m2")) {
        break;
      }
      await sleep(10);
    }
    assert(applied.includes("m1"), "m1 applied after later batch");
    assert(applied.includes("m2"), "m2 applied");
    pump.stop();
  }

  {
    // stop() abandons apply.
    const applied: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const pump = createLinkEnrichmentPump({
      isEligible: () => true,
      enrich: async (id, isCurrent) => {
        await gate;
        if (!isCurrent()) {
          return;
        }
        applied.push(id);
      },
    });
    pump.afterIds(["s1"]);
    await sleep(5);
    pump.stop();
    release();
    await sleep(20);
    assert(applied.length === 0, "stop aborts apply");
  }

  {
    // Coalesce many ids without starvation; concurrency capped.
    const applied: string[] = [];
    let active = 0;
    let peak = 0;
    const pump = createLinkEnrichmentPump({
      isEligible: (id) => !applied.includes(id),
      enrich: async (id, isCurrent) => {
        active += 1;
        peak = Math.max(peak, active);
        await sleep(15);
        active -= 1;
        if (!isCurrent()) {
          return;
        }
        applied.push(id);
      },
    });
    const ids = Array.from({ length: 10 }, (_, i) => `c${i}`);
    pump.afterIds(ids);
    assert(
      pump.inflightCount() <= LINK_ENRICH_MAX_INFLIGHT,
      "concurrency cap",
    );
    for (let i = 0; i < 50; i += 1) {
      if (applied.length === 10) {
        break;
      }
      await sleep(20);
    }
    assert(applied.length === 10, `all applied got ${applied.length}`);
    assert(peak <= LINK_ENRICH_MAX_INFLIGHT, `peak ${peak}`);
    pump.stop();
  }

  {
    // stop() then re-enqueue same id after inflight settles.
    const applied: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    let phase = 0;
    const pump = createLinkEnrichmentPump({
      isEligible: () => true,
      enrich: async (id, isCurrent) => {
        if (phase === 0) {
          await gate;
          if (!isCurrent()) {
            return;
          }
          applied.push(`old:${id}`);
          return;
        }
        if (!isCurrent()) {
          return;
        }
        applied.push(`new:${id}`);
      },
    });
    pump.afterIds(["m1"]);
    await sleep(5);
    pump.stop();
    phase = 1;
    pump.afterIds(["m1"]);
    // Still blocked by old inflight until release.
    assert(pump.inflightCount() === 1, "old inflight until release");
    release();
    for (let i = 0; i < 40; i += 1) {
      if (applied.includes("new:m1")) {
        break;
      }
      await sleep(10);
    }
    assert(!applied.includes("old:m1"), "old apply abandoned");
    assert(applied.includes("new:m1"), "re-enqueue after stop applies");
    pump.stop();
  }

  {
    // Cap pending FIFO depth under burst.
    const pump = createLinkEnrichmentPump({
      maxInflight: 1,
      maxPending: 3,
      isEligible: () => true,
      enrich: async (_id, isCurrent) => {
        await sleep(40);
        if (!isCurrent()) {
          return;
        }
      },
    });
    pump.afterIds(["a", "b", "c", "d", "e", "f"]);
    assert(pump.pendingCount() <= 3, "pending capped");
    assert(pump.inflightCount() <= 1, "inflight capped");
    pump.stop();
  }

  console.log("linkEnrichment tests ok");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
