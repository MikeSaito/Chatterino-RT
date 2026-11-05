export const MEDIA_LOAD_CONCURRENCY = 8;
export const MEDIA_LOAD_QUEUE_LIMIT = 128;

type Job<T> = {
  key: string;
  run: () => Promise<T>;
  resolve: (value: T | null) => void;
  reject: (error: unknown) => void;
};

/** Active work keeps its permit until completion, even after pending work is cleared. */
export class MediaLoadQueue<T> {
  private active = 0;
  private readonly pending: Job<T>[] = [];
  private readonly maxActive: number;
  private readonly maxPending: number;

  constructor(
    maxActive = MEDIA_LOAD_CONCURRENCY,
    maxPending = MEDIA_LOAD_QUEUE_LIMIT,
  ) {
    if (!Number.isInteger(maxActive) || maxActive < 1 || !Number.isInteger(maxPending) || maxPending < 0) {
      throw new RangeError("Invalid media load limits");
    }
    this.maxActive = maxActive;
    this.maxPending = maxPending;
  }

  enqueue(key: string, run: () => Promise<T>): Promise<T | null> | null {
    this.cancelPending(key);
    if (this.active >= this.maxActive && this.pending.length >= this.maxPending) return null;
    let resolve!: Job<T>["resolve"];
    let reject!: Job<T>["reject"];
    const promise = new Promise<T | null>((done, fail) => { resolve = done; reject = fail; });
    const job = { key, run, resolve, reject };
    if (this.active < this.maxActive) this.start(job);
    else this.pending.push(job);
    return promise;
  }

  cancelPending(key?: string): number {
    let cancelled = 0;
    for (let i = this.pending.length - 1; i >= 0; i -= 1) {
      if (key !== undefined && this.pending[i].key !== key) continue;
      const [job] = this.pending.splice(i, 1);
      job.resolve(null);
      cancelled += 1;
    }
    return cancelled;
  }

  diagnostics(): { loading: number; queued: number } {
    return { loading: this.active, queued: this.pending.length };
  }

  private start(job: Job<T>): void {
    this.active += 1;
    let result: Promise<T>;
    try { result = job.run(); }
    catch (error) { job.reject(error); this.finish(); return; }
    void result.then(
      (value) => { job.resolve(value); this.finish(); },
      (error) => { job.reject(error); this.finish(); },
    );
  }

  private finish(): void {
    this.active -= 1;
    const next = this.pending.shift();
    if (next) this.start(next);
  }
}
