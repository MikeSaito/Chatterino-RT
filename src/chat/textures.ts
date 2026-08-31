import { Texture } from "pixi.js";
import { invoke, isTauri } from "@tauri-apps/api/core";
import { MAX_GIF_FRAMES, TEXTURE_LRU_LIMIT } from "../constants";
import { isAllowedEmoteCdnUrl } from "./emoteCdnAllowlist";
import { GIF_FRAME_LENGTH, gifFrameDelayMs } from "./gifFrameDelay";
import { resolveEmoteUrl } from "./emoteUrl";

export { resolveEmoteUrl } from "./emoteUrl";
export { GIF_FRAME_LENGTH, gifFrameDelayMs } from "./gifFrameDelay";

const ATTEMPTS = 3;

export type EmoteFrameSet = {
  frames: Texture[];
  delays: number[];
  total: number;
};

type ImageDecoderInstance = {
  decode: (options: { frameIndex: number }) => Promise<{
    image: VideoFrame;
    complete?: boolean;
  }>;
  tracks: {
    ready: Promise<void>;
    selectedTrack: { frameCount: number } | null;
  };
  close: () => void;
};

type ImageDecoderCtor = new (init: {
  data: BufferSource;
  type: string;
  preferAnimation?: boolean;
}) => ImageDecoderInstance;

function imageDecoderCtor(): ImageDecoderCtor | null {
  const g = globalThis as unknown as { ImageDecoder?: ImageDecoderCtor };
  return typeof g.ImageDecoder === "function" ? g.ImageDecoder : null;
}

export class EmoteFrameTicker {
  private positionMs = 0;
  private timer: number | null = null;
  private animate = true;
  private onlyFocused = false;
  private readonly listeners = new Set<() => void>();
  private focusBound = false;

  configure(opts: { animate: boolean; onlyFocused: boolean }): void {
    this.animate = opts.animate;
    this.onlyFocused = opts.onlyFocused;
    this.bindFocus();
    this.syncTimer();
  }

  position(): number {
    return this.positionMs;
  }

  subscribe(cb: () => void): () => void {
    this.listeners.add(cb);
    return () => {
      this.listeners.delete(cb);
    };
  }

  destroy(): void {
    this.stopTimer();
    this.listeners.clear();
    if (this.focusBound) {
      window.removeEventListener("focus", this.onFocusChange);
      window.removeEventListener("blur", this.onFocusChange);
      document.removeEventListener("visibilitychange", this.onFocusChange);
      this.focusBound = false;
    }
  }

  private readonly onFocusChange = (): void => {
    this.syncTimer();
  };

  private bindFocus(): void {
    if (this.focusBound) {
      return;
    }
    window.addEventListener("focus", this.onFocusChange);
    window.addEventListener("blur", this.onFocusChange);
    document.addEventListener("visibilitychange", this.onFocusChange);
    this.focusBound = true;
  }

  private shouldRun(): boolean {
    if (!this.animate) {
      return false;
    }
    if (!this.onlyFocused) {
      return true;
    }
    return document.visibilityState === "visible" && document.hasFocus();
  }

  private syncTimer(): void {
    if (this.shouldRun()) {
      this.startTimer();
    } else {
      this.stopTimer();
    }
  }

  private startTimer(): void {
    if (this.timer !== null) {
      return;
    }
    this.timer = window.setInterval(() => {
      this.positionMs += GIF_FRAME_LENGTH;
      for (const cb of this.listeners) {
        cb();
      }
    }, GIF_FRAME_LENGTH);
  }

  private stopTimer(): void {
    if (this.timer === null) {
      return;
    }
    window.clearInterval(this.timer);
    this.timer = null;
  }
}

export class TextureLru {
  private readonly map = new Map<string, Texture>();
  private readonly urls = new Map<string, string>();
  private readonly modes = new Map<string, boolean>();
  private readonly frameSets = new Map<string, EmoteFrameSet>();
  private readonly refs = new Map<string, number>();
  private readonly inflight = new Map<string, Promise<Texture | null>>();
  private readonly generation = new Map<string, number>();
  private readonly maxEntries: number;

  constructor(max = TEXTURE_LRU_LIMIT) {
    this.maxEntries = max;
  }

  get(id: string): Texture | undefined {
    const hit = this.map.get(id);
    if (hit) {
      this.map.delete(id);
      this.map.set(id, hit);
    }
    return hit;
  }

  frameSet(id: string): EmoteFrameSet | undefined {
    return this.frameSets.get(id);
  }

  frameAt(id: string, positionMs: number): Texture | undefined {
    const set = this.frameSets.get(id);
    if (!set || set.frames.length <= 1) {
      return this.get(id);
    }
    let t = positionMs % set.total;
    for (let i = 0; i < set.frames.length; i += 1) {
      t -= set.delays[i];
      if (t < 0) {
        return set.frames[i];
      }
    }
    return set.frames[0];
  }

  isAnimated(id: string): boolean {
    const set = this.frameSets.get(id);
    return !!set && set.frames.length > 1;
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

  async load(id: string, url: string, animate: boolean): Promise<Texture | null> {
    const resolved = resolveEmoteUrl(url, animate);
    const cached = this.get(id);
    if (
      cached &&
      this.urls.get(id) === resolved &&
      this.modes.get(id) === animate
    ) {
      return cached;
    }
    const pending = this.inflight.get(id);
    if (
      pending &&
      this.urls.get(id) === resolved &&
      this.modes.get(id) === animate
    ) {
      return pending;
    }
    const token = (this.generation.get(id) ?? 0) + 1;
    this.generation.set(id, token);
    this.urls.set(id, resolved);
    this.modes.set(id, animate);
    const job = loadTextureSet(resolved, animate)
      .then((set) => {
        if (this.inflight.get(id) === job) {
          this.inflight.delete(id);
        }
        if (this.generation.get(id) !== token) {
          destroyFrameSet(set, null);
          return null;
        }
        const prev = this.map.get(id);
        const prevSet = this.frameSets.get(id);
        if (!this.set(id, set.frames[0])) {
          destroyFrameSet(set, null);
          // Cap full under pin: drop meta so retries cannot leak Map entries.
          if (this.generation.get(id) === token) {
            this.urls.delete(id);
            this.modes.delete(id);
            this.generation.delete(id);
          }
          return null;
        }
        this.frameSets.set(id, set);
        if (prev && prev !== set.frames[0] && prev !== Texture.EMPTY) {
          if (!prevSet || !prevSet.frames.includes(prev)) {
            prev.destroy(true);
          }
        }
        if (prevSet) {
          destroyFrameSet(prevSet, set);
        }
        return set.frames[0];
      })
      .catch(() => {
        if (this.inflight.get(id) === job) {
          this.inflight.delete(id);
        }
        if (this.generation.get(id) === token) {
          this.urls.delete(id);
          this.modes.delete(id);
        }
        return null;
      });
    this.inflight.set(id, job);
    return job;
  }

  clear(): void {
    for (const id of [...this.map.keys()]) {
      this.dropEntry(id);
    }
    this.inflight.clear();
    this.generation.clear();
    this.refs.clear();
  }

  /** Insert only if under hard LRU cap; unpinned entries are evicted first. */
  private set(id: string, texture: Texture): boolean {
    if (this.map.has(id)) {
      this.map.delete(id);
      this.map.set(id, texture);
      this.evict();
      return true;
    }
    this.evict();
    if (this.map.size >= this.maxEntries) {
      return false;
    }
    this.map.set(id, texture);
    return true;
  }

  private dropEntry(victim: string): void {
    const dropped = this.map.get(victim);
    const droppedSet = this.frameSets.get(victim);
    this.map.delete(victim);
    this.urls.delete(victim);
    this.modes.delete(victim);
    this.frameSets.delete(victim);
    this.generation.delete(victim);
    if (droppedSet) {
      destroyFrameSet(droppedSet, null);
    } else if (dropped && dropped !== Texture.EMPTY) {
      dropped.destroy(true);
    }
  }

  private evict(): void {
    while (this.map.size > this.maxEntries) {
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
      this.dropEntry(victim);
    }
  }
}

function destroyFrameSet(set: EmoteFrameSet, keep: EmoteFrameSet | null): void {
  for (const tex of set.frames) {
    if (keep && keep.frames.includes(tex)) {
      continue;
    }
    if (tex !== Texture.EMPTY) {
      tex.destroy(true);
    }
  }
}

type CdnImageBytes = {
  bytes: number[];
  contentType: string | null;
};

async function fetchCdnViaInvoke(url: string): Promise<{ buf: ArrayBuffer; mime: string }> {
  const data = await invoke<CdnImageBytes>("fetch_emote_cdn", { url });
  if (!data.bytes?.length) {
    throw new Error("empty cdn body");
  }
  const buf = new Uint8Array(data.bytes).buffer;
  const mime = sniffMime(data.contentType, url, buf);
  return { buf, mime };
}

async function fetchEmoteBytes(
  url: string,
): Promise<{ buf: ArrayBuffer; mime: string }> {
  if (!isAllowedEmoteCdnUrl(url)) {
    throw new Error("cdn url not allowed");
  }
  if (isTauri()) {
    return fetchCdnViaInvoke(url);
  }
  let fetchErr: unknown;
  try {
    const res = await fetch(url, { mode: "cors", credentials: "omit" });
    if (!res.ok || res.status === 206) {
      throw new Error(`HTTP ${res.status}`);
    }
    const buf = await res.arrayBuffer();
    if (buf.byteLength === 0) {
      throw new Error("empty body");
    }
    const mime = sniffMime(res.headers.get("content-type"), url, buf);
    return { buf, mime };
  } catch (err) {
    fetchErr = err;
  }
  try {
    return await fetchCdnViaInvoke(url);
  } catch (invokeErr) {
    throw invokeErr ?? fetchErr;
  }
}

async function bytesToBitmap(buf: ArrayBuffer, mime: string): Promise<ImageBitmap> {
  try {
    return await createImageBitmap(new Blob([buf], { type: mime }));
  } catch {
    return await createImageBitmap(new Blob([buf]));
  }
}

async function loadTextureSet(url: string, animate: boolean): Promise<EmoteFrameSet> {
  let delay = 200;
  let last: unknown = new Error("texture load failed");
  for (let attempt = 0; attempt < ATTEMPTS; attempt += 1) {
    try {
      const { buf, mime } = await fetchEmoteBytes(url);
      if (animate) {
        const decoded = await decodeAnimated(buf, mime);
        if (decoded) {
          return decoded;
        }
      }
      const bitmap = await bytesToBitmap(buf, mime);
      const tex = Texture.from(bitmap);
      return { frames: [tex], delays: [GIF_FRAME_LENGTH], total: GIF_FRAME_LENGTH };
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

async function decodeAnimated(
  buf: ArrayBuffer,
  mime: string,
): Promise<EmoteFrameSet | null> {
  const Ctor = imageDecoderCtor();
  if (!Ctor) {
    return null;
  }
  let decoder: ImageDecoderInstance | null = null;
  const frames: Texture[] = [];
  const delays: number[] = [];
  try {
    decoder = new Ctor({ data: buf, type: mime, preferAnimation: true });
    await decoder.tracks.ready;
    const track = decoder.tracks.selectedTrack;
    if (!track || track.frameCount <= 1) {
      return null;
    }
    const frameCount = Math.min(track.frameCount, MAX_GIF_FRAMES);
    let total = 0;
    for (let i = 0; i < frameCount; i += 1) {
      const { image } = await decoder.decode({ frameIndex: i });
      // VideoFrame.duration is µs (WebCodecs); ImageDecodeResult has no duration.
      const ms = gifFrameDelayMs(image.duration);
      try {
        const bitmap = await createImageBitmap(image);
        frames.push(Texture.from(bitmap));
        delays.push(ms);
        total += ms;
      } finally {
        image.close();
      }
    }
    if (frames.length <= 1) {
      destroyFrameSet({ frames, delays, total: GIF_FRAME_LENGTH }, null);
      return null;
    }
    return { frames, delays, total: Math.max(total, GIF_FRAME_LENGTH) };
  } catch {
    if (frames.length > 0) {
      destroyFrameSet({ frames, delays, total: GIF_FRAME_LENGTH }, null);
    }
    return null;
  } finally {
    decoder?.close();
  }
}

function sniffMime(header: string | null, url: string, buf?: ArrayBuffer): string {
  if (header && header !== "application/octet-stream") {
    const base = header.split(";")[0]?.trim();
    if (base) {
      return base;
    }
  }
  if (buf && buf.byteLength >= 12) {
    const u8 = new Uint8Array(buf);
    if (u8[0] === 0x89 && u8[1] === 0x50 && u8[2] === 0x4e && u8[3] === 0x47) {
      return "image/png";
    }
    if (u8[0] === 0x47 && u8[1] === 0x49 && u8[2] === 0x46) {
      return "image/gif";
    }
    if (
      u8[0] === 0x52 &&
      u8[1] === 0x49 &&
      u8[2] === 0x46 &&
      u8[3] === 0x46 &&
      u8[8] === 0x57 &&
      u8[9] === 0x45 &&
      u8[10] === 0x42 &&
      u8[11] === 0x50
    ) {
      return "image/webp";
    }
  }
  const lower = url.toLowerCase();
  if (lower.endsWith(".gif") || lower.includes(".gif?")) {
    return "image/gif";
  }
  if (lower.endsWith(".webp") || lower.includes(".webp?")) {
    return "image/webp";
  }
  if (lower.endsWith(".avif") || lower.includes(".avif?")) {
    return "image/avif";
  }
  if (lower.endsWith(".png") || lower.includes(".png?")) {
    return "image/png";
  }
  return "image/png";
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    window.setTimeout(resolve, ms);
  });
}
