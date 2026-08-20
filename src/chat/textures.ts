import { Texture, Assets } from "pixi.js";
import { TEXTURE_LRU_LIMIT } from "../constants";

Assets.setPreferences({ preferWorkers: false });

const ATTEMPTS = 3;

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
    if (cached && this.urls.get(id) === url) {
      return cached;
    }
    const pending = this.inflight.get(id);
    if (pending && this.urls.get(id) === url) {
      return pending;
    }
    const job = loadTexture(url)
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
    this.urls.set(id, url);
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

async function loadTexture(url: string): Promise<Texture> {
  let delay = 200;
  let last: unknown = new Error("texture load failed");
  for (let attempt = 0; attempt < ATTEMPTS; attempt += 1) {
    try {
      return await Assets.load<Texture>({
        src: url,
        parser: "texture",
      });
    } catch (err) {
      last = err;
      if (attempt + 1 < ATTEMPTS) {
        await sleep(delay);
        delay *= 2;
      }
    }
  }
  throw last;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    window.setTimeout(resolve, ms);
  });
}
