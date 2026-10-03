/** Opt-in telemetry. Contains counts/timings only; bounded samples, no chat text. */
export class Samples {
  private values: number[] = [];
  private next = 0;
  total = 0;
  count = 0;
  max = 0;
  private capacity: number;
  constructor(capacity = 4096) { this.capacity = Math.max(1, Math.floor(capacity)); }
  add(value: number): void {
    if (!Number.isFinite(value) || value < 0) return;
    this.total += value;
    this.count += 1;
    this.max = Math.max(this.max, value);
    this.values[this.next] = value;
    this.next = (this.next + 1) % this.capacity;
  }
  report() {
    const sorted = [...this.values].sort((a, b) => a - b);
    const percentile = (p: number) => sorted.length ? sorted[Math.max(0, Math.ceil(sorted.length * p) - 1)] : 0;
    return { count: this.count, samples: sorted.length, meanMs: this.count ? this.total / this.count : 0, p50Ms: percentile(.5), p95Ms: percentile(.95), p99Ms: percentile(.99), maxMs: this.max };
  }
}

type PerfPlatform = {
  now: () => number;
  frame: (fn: (now: number) => void) => number;
  cancel: (id: number) => void;
  memory: () => number | null;
};
const browserPlatform = (): PerfPlatform => ({
  now: () => performance.now(), frame: (fn) => requestAnimationFrame(fn), cancel: (id) => cancelAnimationFrame(id),
  memory: () => (performance as Performance & { memory?: { usedJSHeapSize: number } }).memory?.usedJSHeapSize ?? null,
});

export class ChatPerformance {
  private platform: PerfPlatform;
  private generation = 0;
  private running = false;
  private started = 0;
  private ended = 0;
  private lastFrame: number | undefined;
  private raf = 0;
  private batchRaf = new Set<number>();
  private frameTimes = new Samples();
  private batchTimes = new Samples();
  private latency = new Samples();
  private operations = new Map<string, Samples>();
  private messages = 0;
  private longFrames = 0;
  private memoryStart: number | null = null;
  private memoryEnd: number | null = null;
  private memoryPeak: number | null = null;
  private frameBudget = 1000 / 60;
  constructor(platform = browserPlatform()) { this.platform = platform; }
  active(): boolean { return this.running; }
  start(frameBudgetMs = 1000 / 60): void {
    this.stop();
    this.generation += 1;
    this.frameBudget = Number.isFinite(frameBudgetMs) && frameBudgetMs > 0 ? frameBudgetMs : 1000 / 60;
    this.running = true;
    this.started = this.platform.now();
    this.lastFrame = undefined;
    this.frameTimes = new Samples(); this.batchTimes = new Samples(); this.latency = new Samples();
    this.operations.clear(); this.messages = 0; this.longFrames = 0;
    this.memoryStart = this.memoryEnd = this.memoryPeak = this.platform.memory();
    const tick = (now: number) => {
      if (!this.running) return;
      if (this.lastFrame !== undefined) {
        const dt = now - this.lastFrame;
        this.frameTimes.add(dt);
        if (dt > this.frameBudget * 1.5) this.longFrames += 1;
      }
      this.lastFrame = now;
      this.memoryEnd = this.platform.memory();
      if (this.memoryEnd !== null) this.memoryPeak = Math.max(this.memoryPeak ?? 0, this.memoryEnd);
      this.raf = this.platform.frame(tick);
    };
    this.raf = this.platform.frame(tick);
  }
  batch(count: number, receivedAt: number, processingMs: number): void {
    if (!this.running) return;
    this.messages += count;
    this.batchTimes.add(processingMs);
    // Background WebViews can suspend animation frames while IPC continues.
    // Keep pending latency callbacks bounded as well as completed samples.
    if (this.batchRaf.size >= 128) return;
    const generation = this.generation;
    // Two animation frames include the intervening renderer frame. This is a
    // UI scheduling latency estimate, not server-to-client or GPU latency.
    const schedule = (fn: () => void) => {
      const id = this.platform.frame(() => { this.batchRaf.delete(id); fn(); });
      this.batchRaf.add(id);
    };
    schedule(() => schedule(() => {
      if (this.running && generation === this.generation) this.latency.add(this.platform.now() - receivedAt);
    }));
  }
  operation(name: string, ms: number): void {
    if (!this.running) return;
    let samples = this.operations.get(name);
    if (!samples) { samples = new Samples(); this.operations.set(name, samples); }
    samples.add(ms);
  }
  stop() {
    if (this.running) this.ended = this.platform.now();
    this.running = false;
    this.platform.cancel(this.raf);
    for (const id of this.batchRaf) this.platform.cancel(id);
    this.batchRaf.clear();
    return this.report();
  }
  report() {
    const durationMs = Math.max(0, (this.running ? this.platform.now() : this.ended) - this.started);
    return {
      durationMs, messages: this.messages, messagesPerSecond: durationMs ? this.messages * 1000 / durationMs : 0,
      frameBudgetMs: this.frameBudget, longFrames: this.longFrames,
      frames: this.frameTimes.report(), processing: this.batchTimes.report(), receiptToFrame: this.latency.report(),
      operations: Object.fromEntries([...this.operations].map(([key, samples]) => [key, samples.report()])),
      jsHeapBytes: { start: this.memoryStart, end: this.memoryEnd, peak: this.memoryPeak },
    };
  }
}
