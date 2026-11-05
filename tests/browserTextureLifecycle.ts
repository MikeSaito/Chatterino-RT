import { TextureLru, isRenderableTexture } from "../src/chat/textures";
import { Texture, type Sprite } from "pixi.js";
import type { MessageRing } from "../src/chat/ring";

type ImageBytes = { bytes: number[]; contentType: string };
type Response = (url: string) => Promise<ImageBytes>;

function check(value: unknown, message: string): asserts value {
  if (!value) throw new Error(message);
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

export async function checkTextureLifecycle(setResponse: (response?: Response) => void, ring: MessageRing): Promise<void> {
  const bytes = await (await fetch("/src-tauri/fixtures/animated-emote.gif")).arrayBuffer();
  const image = { bytes: Array.from(new Uint8Array(bytes)), contentType: "image/gif" };
  const url = "https://cdn.7tv.app/emote/lifecycle/1x.gif";
  const host = window as Window & { isTauri?: boolean };
  const wasTauri = host.isTauri;
  host.isTauri = true;
  try {
    const burst = new TextureLru(16);
    const releaseBurst = deferred<ImageBytes>();
    let burstActive = 0;
    let burstPeak = 0;
    setResponse(async () => {
      burstActive += 1;
      burstPeak = Math.max(burstPeak, burstActive);
      try { return await releaseBurst.promise; } finally { burstActive -= 1; }
    });
    const burstLoads = Array.from({ length: 300 }, (_, i) => burst.load(`burst-${i}`, url, false));
    try {
      check(burstPeak <= 8, `burst starts at most eight requests, got ${burstPeak}`);
      check(burst.diagnostics().inflight <= 136, "active and queued load records stay bounded");
      releaseBurst.resolve(image);
      const results = await Promise.all(burstLoads);
      check(results.some((texture) => texture === null), "overload rejects requests beyond the bounded queue");
      check(burstPeak <= 8, "draining the queue preserves the concurrency bound");
      check(isRenderableTexture(await burst.load("burst-299", url, false)), "a rejected image can be requested again after draining");
    } finally {
      releaseBurst.resolve(image);
      await Promise.all(burstLoads);
      burst.clear();
    }

    const cleared = new TextureLru(16);
    const oldBurst = deferred<ImageBytes>();
    let clearCalls = 0;
    setResponse(async () => { clearCalls += 1; return clearCalls <= 8 ? oldBurst.promise : image; });
    const oldBurstLoads = Array.from({ length: 20 }, (_, i) => cleared.load(`old-${i}`, url, false));
    cleared.clear();
    const afterClear = cleared.load("after-clear", url, false);
    try {
      check(clearCalls === 8 && cleared.diagnostics().loading === 8, "clearing cannot bypass occupied load permits");
      check(cleared.diagnostics().queued === 1, "only the new request remains queued");
      oldBurst.resolve(image);
      check((await Promise.all(oldBurstLoads)).every((texture) => texture === null), "all cleared jobs settle without acceptance");
      check(isRenderableTexture(await afterClear) && Number(clearCalls) === 9, "only the new queued request starts after clear");
    } finally {
      oldBurst.resolve(image);
      await Promise.all([...oldBurstLoads, afterClear]);
      cleared.clear();
    }

    const referenced = new TextureLru(16);
    const occupied = deferred<ImageBytes>();
    let referenceCalls = 0;
    setResponse(async () => { referenceCalls += 1; return referenceCalls <= 8 ? occupied.promise : image; });
    const blockers = Array.from({ length: 8 }, (_, i) => referenced.load(`blocker-${i}`, url, false));
    referenced.acquire("shared");
    const released = referenced.load("shared", url, false);
    referenced.release("shared");
    referenced.acquire("shared");
    const requeued = referenced.load("shared", url, false);
    const duplicate = referenced.load("shared", url, false);
    const animation = referenced.load("shared", url, true);
    try {
      check(referenced.diagnostics().queued === 1, "only the newest mode for a queued key is retained");
      check(await released === null && await requeued === null && await duplicate === null, "released and superseded queued consumers all settle");
      occupied.resolve(image);
      await Promise.all(blockers);
      check(isRenderableTexture(await animation) && referenced.isAnimated("shared"), "immediate reacquisition uses the latest animation mode");
      check(Number(referenceCalls) === 9, "deduplication and cancelled queue entries do not issue requests");
    } finally {
      occupied.resolve(image);
      await Promise.all([...blockers, released, requeued, duplicate, animation]);
      referenced.clear();
    }

    for (const oldFirst of [false, true]) {
      const cache = new TextureLru(2);
      const oldResponse = deferred<ImageBytes>();
      const newResponse = deferred<ImageBytes>();
      let calls = 0;
      setResponse(async () => ++calls === 1 ? oldResponse.promise : newResponse.promise);
      const oldLoad = cache.load("same", url, false);
      cache.clear();
      const newLoad = cache.load("same", url, false);
      try {
        if (oldFirst) {
          oldResponse.resolve(image);
          check(await oldLoad === null, "cleared load cannot return an accepted texture before its replacement");
          check(cache.get("same") === undefined, "cleared load cannot repopulate the cache");
        }
        newResponse.resolve(image);
        const current = await newLoad;
        check(isRenderableTexture(current), "replacement texture is usable");
        if (!oldFirst) {
          oldResponse.resolve(image);
          check(await oldLoad === null, "late cleared load must be discarded");
        }
        check(cache.get("same") === current && isRenderableTexture(current), "late completion preserves the replacement texture");
        check(await cache.load("same", url, false) === current && calls === 2, "replacement remains a reusable cache hit");
      } finally {
        oldResponse.resolve(image);
        newResponse.resolve(image);
        await Promise.all([oldLoad, newLoad]);
        cache.clear();
      }
    }

    const cache = new TextureLru(2);
    const pending = deferred<ImageBytes>();
    setResponse(async () => pending.promise);
    const loading = cache.load("pending", url, false);
    cache.clear();
    pending.resolve(image);
    await loading;
    const metadata = cache as unknown as { urls: Map<string, unknown>; modes: Map<string, unknown>; generation: Map<string, unknown> };
    check(metadata.urls.size === 0 && metadata.modes.size === 0 && metadata.generation.size === 0, "clear releases metadata for pending loads");
    setResponse(async () => { throw new Error("fixture unavailable"); });
    for (let i = 0; i < 3; i += 1) await cache.load(`failed-${i}`, url, false);
    check(metadata.generation.size === 0, "failed unique loads do not retain generation records");
    cache.clear();

    const animated = new TextureLru(2);
    setResponse(async () => image);
    try {
      check(await animated.load("partial-dead", url, true), "animated texture loads");
      const frames = animated.frameSet("partial-dead")!.frames;
      check(frames.length > 1, "fixture has multiple decoded frames");
      frames[0].destroy(true);
      check(animated.get("partial-dead") === undefined, "dead base texture is removed");
      check(frames.every((frame) => frame.destroyed), "purging a partially dead animation releases all remaining frames");
    } finally {
      animated.clear();
    }

    const owner = ring as unknown as {
      slots: { root: { visible: boolean; renderable: boolean }; emotes: Sprite[]; emoteKeys: string[] }[];
      onTexturesInvalidated: (id: string, textures: readonly Texture[]) => void;
    };
    const slot = owner.slots.find((row) => row.root.visible && row.root.renderable)!;
    const sprite = slot.emotes[0];
    const saved = { texture: sprite.texture, visible: sprite.visible, keys: slot.emoteKeys };
    const shared = new TextureLru(2);
    shared.setInvalidateListener((id, textures) => owner.onTexturesInvalidated(id, textures));
    const staleResponse = deferred<ImageBytes>();
    const freshResponse = deferred<ImageBytes>();
    let calls = 0;
    setResponse(async () => ++calls === 1 ? staleResponse.promise : freshResponse.promise);
    const staleLoad = shared.load("media-reload", url, false);
    const freshLoad = shared.load("media-reload", url.replace("lifecycle", "lifecycle-fresh"), false);
    try {
      freshResponse.resolve(image);
      const current = await freshLoad;
      check(isRenderableTexture(current), "shared key replacement is usable");
      slot.emoteKeys = ["media-reload", ...saved.keys.slice(1)];
      sprite.texture = current;
      sprite.visible = true;
      staleResponse.resolve(image);
      check(await staleLoad === null, "superseded asset is discarded");
      check(sprite.texture === current && sprite.visible, "discarding old frames cannot hide the current image with the same key");
      shared.clear();
      check(sprite.texture === Texture.EMPTY && !sprite.visible, "current frames are detached before their cache is cleared");
    } finally {
      staleResponse.resolve(image);
      freshResponse.resolve(image);
      await Promise.all([staleLoad, freshLoad]);
      shared.clear();
      slot.emoteKeys = saved.keys;
      sprite.texture = saved.texture;
      sprite.visible = saved.visible;
    }
  } finally {
    setResponse(undefined);
    host.isTauri = wasTauri;
  }
}
