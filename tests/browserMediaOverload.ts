import type { MessageRing } from "../src/chat/ring";
import type { ChatEvent } from "../src/chat/types";
import type { Sprite } from "pixi.js";
import type { TextureLru } from "../src/chat/textures";

type Response = (url: string) => Promise<{ bytes: number[]; contentType: string }>;
const check = (value: unknown, message: string) => { if (!value) throw new Error(message); };
const frame = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
async function until(test: () => boolean) {
  const deadline = performance.now() + 10_000;
  while (!test()) {
    if (performance.now() > deadline) throw new Error("Media did not recover after viewport entry");
    await frame();
  }
}

export async function checkMediaOverload(ring: MessageRing, send: (event: ChatEvent) => void, setResponse: (response?: Response) => void) {
  const owner = ring as unknown as {
    textures: TextureLru;
    slots: { msgId: string; emotes: Sprite[]; badges: Sprite[]; clipUi: { thumb: Sprite } }[];
  };
  const bytes = await (await fetch("/src-tauri/fixtures/animated-emote.gif")).arrayBuffer();
  const image = { bytes: Array.from(new Uint8Array(bytes)), contentType: "image/gif" };
  const base = "https://cdn.7tv.app/emote";
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const host = window as Window & { isTauri?: boolean };
  const wasTauri = host.isTauri;
  host.isTauri = true;
  setResponse(async (url) => { if (url.includes("/load-blocker/")) await gate; return image; });
  const loads = Array.from({ length: 136 }, (_, i) => owner.textures.load(`recovery-blocker-${i}`, `${base}/load-blocker/1x.gif`, false));
  try {
    check(owner.textures.diagnostics().queued === 128, "fixture fills the media queue");
    const event: Extract<ChatEvent, { kind: "privmsg" }> = {
      kind: "privmsg", id: "overload-recovery", timestampMs: Date.now(), userId: "1", login: "viewer", displayName: "Viewer", color: "#6699ff",
      badges: [{ set: "subscriber", version: "1", url: `${base}/recovery-badge/1x.gif` }],
      text: "Emote", emoteSpans: [{ start: 0, end: 5, provider: "7tv", emoteId: "recovery", url: `${base}/recovery/1x.gif`, zeroWidth: false }], action: false,
    };
    ring.goToBottom();
    send(event);
    await until(() => owner.slots.some((slot) => slot.msgId === event.id));
    ring.applyLinkEnrichment(event.id, {
      body: event.text, links: [], hosts: [], spans: event.emoteSpans, mentions: [],
      clip: { clipId: "recovery-clip", url: "https://clips.twitch.tv/Fixture", title: "Fixture clip", host: "clips.twitch.tv", thumbnailUrl: `${base}/recovery-thumb/1x.gif`, durationSec: 10, viewCount: 1, creatorName: "Viewer", broadcasterName: "Channel", gameName: null, createdAt: null },
    });
    await frame(); await frame();
    const slot = owner.slots.find((row) => row.msgId === event.id)!;
    check(!slot.emotes[0].visible && !slot.badges[0].visible && !slot.clipUi.thumb.visible, "overload leaves image placeholders");
    release();
    await Promise.all(loads);
    ring.setDesired(0, false);
    await frame(); await frame();
    ring.goToBottom();
    await until(() => slot.emotes[0].visible && slot.badges[0].visible && slot.clipUi.thumb.visible);
    const refs = (owner.textures as unknown as { refs: Map<string, number> }).refs;
    check(refs.get("clip:recovery-clip") === 1, "clip retries retain exactly one owner reference");
  } finally {
    release();
    await Promise.all(loads);
    setResponse(undefined);
    host.isTauri = wasTauri;
  }
}
