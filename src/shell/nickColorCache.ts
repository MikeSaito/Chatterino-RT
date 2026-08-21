/** LRU map: login → nick color from recent privmsg. */

const DEFAULT_CAP = 500;

export class NickColorCache {
  private readonly map = new Map<string, number>();
  private readonly order: string[] = [];
  private readonly cap: number;

  constructor(cap = DEFAULT_CAP) {
    this.cap = Math.max(1, cap);
  }

  set(login: string, color: number): void {
    const key = login.trim().toLowerCase();
    if (!key) {
      return;
    }
    if (this.map.has(key)) {
      this.map.set(key, color);
      const at = this.order.indexOf(key);
      if (at >= 0) {
        this.order.splice(at, 1);
        this.order.push(key);
      }
      return;
    }
    while (this.order.length >= this.cap) {
      const evict = this.order.shift();
      if (evict) {
        this.map.delete(evict);
      }
    }
    this.order.push(key);
    this.map.set(key, color);
  }

  get(login: string): number | undefined {
    return this.map.get(login.trim().toLowerCase());
  }

  clear(): void {
    this.map.clear();
    this.order.length = 0;
  }

  get size(): number {
    return this.map.size;
  }
}
