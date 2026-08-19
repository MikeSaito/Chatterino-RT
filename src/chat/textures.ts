import { Texture, Assets } from "pixi.js";
import { TEXTURE_LRU_LIMIT } from "../constants";

export class TextureLru {
  private readonly map = new Map<string, Texture>();
  private readonly urls = new Map<string, string>();
  private readonly refs = new Map<string, number>();
  private readonly inflight = new Map<string, Promise<Texture | null>>();

  constructor(private readonly max = TEXTURE_LRU_LIMIT) {}

  get(id: string): Texture | undefined {
    const hit = this.map.get(id);
    if (hit) {
      this.map.delete(id);
      this.map.set(id, hit);
    }
    return hit;
  }

  acquire(id: string): void {
    this.refs.set(id, (this.refs.get(id) ?? 0) + 1);
  }

  release(id: string): void {
    const n = this.refs.get(id) ?? 0;
    if (n <= 1) {
      this.refs.delete(id);
    } else {
      this.refs.set(id, n - 1);
    }
    this.evict();
  }

  async load(id: string, url: string): Promise<Texture | null> {
    const cached = this.get(id);
    if (cached) {
      return cached;
    }
    const pending = this.inflight.get(id);
    if (pending) {
      return pending;
    }
    const job = Assets.load<Texture>(url)
      .then((tex) => {
        this.inflight.delete(id);
        this.urls.set(id, url);
        this.set(id, tex);
        return tex;
      })
      .catch(() => {
        this.inflight.delete(id);
        return null;
      });
    this.inflight.set(id, job);
    return job;
  }

  private set(id: string, texture: Texture): void {
    if (this.map.has(id)) {
      this.map.delete(id);
    }
    this.map.set(id, texture);
    this.evict();
  }

  private evict(): void {
    while (this.map.size > this.max) {
      let victim: string | undefined;
      for (const key of this.map.keys()) {
        if ((this.refs.get(key) ?? 0) === 0) {
          victim = key;
          break;
        }
      }
      if (!victim) {
        break;
      }
      this.map.delete(victim);
      const url = this.urls.get(victim);
      this.urls.delete(victim);
      if (url) {
        void Assets.unload(url);
      }
    }
  }
}
