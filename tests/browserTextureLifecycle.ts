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
