import { trailingDebounce, type DebounceTimers } from "../src/chat/debounce.ts";

function assert(cond: boolean, msg: string): void {
  if (!cond) {
    throw new Error(msg);
  }
}

type FakeId = number;

function fakeTimers(): DebounceTimers & {
  tick: (ms: number) => void;
  now: () => number;
} {
  let now = 0;
  let nextId = 1;
  const jobs = new Map<FakeId, { due: number; fn: () => void }>();
  return {
    now: () => now,
    setTimeout: (fn, ms) => {
      const id = nextId++;
      jobs.set(id, { due: now + ms, fn });
      return id as unknown as ReturnType<typeof setTimeout>;
    },
    clearTimeout: (id) => {
      jobs.delete(id as unknown as FakeId);
    },
    tick: (ms) => {
      now += ms;
      const due = [...jobs.entries()]
        .filter(([, j]) => j.due <= now)
        .sort((a, b) => a[1].due - b[1].due);
      for (const [id, job] of due) {
        jobs.delete(id);
        job.fn();
      }
    },
  };
}

{
  const clocks = fakeTimers();
  let n = 0;
  const d = trailingDebounce(() => {
    n += 1;
  }, 100, clocks);
  d.schedule();
  d.schedule();
  d.schedule();
  assert(d.pending(), "pending after schedule");
  assert(n === 0, "not yet");
  clocks.tick(99);
  assert(n === 0, "before wait");
  clocks.tick(1);
  assert(n === 1, "once after wait");
  assert(!d.pending(), "cleared");
}

{
  const clocks = fakeTimers();
  let n = 0;
  const d = trailingDebounce(() => {
    n += 1;
  }, 100, clocks);
  d.schedule();
  clocks.tick(50);
  d.schedule();
  clocks.tick(50);
  assert(n === 0, "reschedule resets");
  clocks.tick(50);
  assert(n === 1, "fires after reset wait");
}

{
  const clocks = fakeTimers();
  let n = 0;
  const d = trailingDebounce(() => {
    n += 1;
  }, 100, clocks);
  d.schedule();
  d.cancel();
  clocks.tick(200);
  assert(n === 0, "cancel");
  assert(!d.pending(), "not pending");
}

{
  const clocks = fakeTimers();
  let n = 0;
  const d = trailingDebounce(() => {
    n += 1;
  }, 100, clocks);
  d.schedule();
  d.flush();
  assert(n === 1, "flush runs");
  clocks.tick(200);
  assert(n === 1, "no double after flush");
  d.flush();
  assert(n === 1, "flush noop when idle");
}

console.log("debounce tests ok");
