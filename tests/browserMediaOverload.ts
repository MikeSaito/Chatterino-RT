import type { MessageRing } from "../src/chat/ring";
import type { ChatEvent } from "../src/chat/types";
import type { TextureLru } from "../src/chat/textures";
import { historyRows, requireRowView, rowView } from "./browserRows";

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
  };
  const bytes = await (await fetch("/src-tauri/fixtures/animated-emote.gif")).arrayBuffer();
  const image = { bytes: Array.from(new Uint8Array(bytes)), contentType: "image/gif" };
  const base = "https://cdn.7tv.app/emote";
  let release!: () => void;
  let releaseLate = () => {};
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
    await until(() => historyRows(ring).some((slot) => slot.msgId === event.id));
    const clipInfo = { clipId: "recovery-clip", url: "https://clips.twitch.tv/Fixture", title: "Fixture clip", host: "clips.twitch.tv", thumbnailUrl: "https://static-cdn.jtvnw.net/twitch-video-assets/fixture/landscape/thumb/thumb-0000000000-480x272.jpg", durationSec: 10, viewCount: 1, creatorName: "Viewer", broadcasterName: "Channel", gameName: null, createdAt: null };
    ring.applyLinkEnrichment(event.id, {
      body: event.text, links: [], hosts: [], spans: event.emoteSpans, mentions: [],
      clip: clipInfo,
    });
    await frame(); await frame();
    const data = historyRows(ring).find((row) => row.msgId === event.id)!;
    let slot = requireRowView(ring, data);
    let clip = slot.clipUi!;
    const offscreenContexts = [clip.bg.context, clip.durationBg.context];
    check(!slot.emotes[0].visible && !slot.badges[0].visible && !clip.thumb.visible, "overload leaves image placeholders");
    release();
    await Promise.all(loads);
    ring.setDesired(0, false);
    await frame(); await frame();
    check(!rowView(ring, data) && clip.root.destroyed, "offscreen rows release media widgets");
    check(offscreenContexts.every((context) => context.destroyed), "offscreen clip disposal destroys its owned graphics contexts");
    ring.goToBottom();
    await until(() => {
      const current = rowView(ring, data);
      return Boolean(current?.emotes[0]?.visible && current.badges[0]?.visible && current.clipUi?.thumb.visible);
    });
    slot = requireRowView(ring, data);
    clip = slot.clipUi!;
    const removedContexts = [clip.bg.context, clip.durationBg.context];
    const refs = (owner.textures as unknown as { refs: Map<string, number> }).refs;
    check(refs.get("clip:recovery-clip") === 1, "clip retries retain exactly one owner reference");
    ring.applyLinkEnrichment(event.id, { body: event.text, links: [], hosts: [], spans: event.emoteSpans, mentions: [], clip: null });
    check(slot.clipUi === null && clip.root.destroyed, "removing a clip destroys its widgets");
    check(removedContexts.every((context) => context.destroyed), "removing a clip destroys its owned graphics contexts");
    check(!refs.has("clip:recovery-clip"), "removing a clip releases its thumbnail owner");
    const late = new Promise<void>((resolve) => { releaseLate = resolve; });
    setResponse(async () => { await late; return image; });
    ring.applyLinkEnrichment(event.id, { body: event.text, links: [], hosts: [], spans: event.emoteSpans, mentions: [], clip: { ...clipInfo, clipId: "late-clip" } });
    const stale = slot.clipUi!;
    ring.applyLinkEnrichment(event.id, { body: event.text, links: [], hosts: [], spans: event.emoteSpans, mentions: [], clip: null });
    releaseLate();
    await until(() => owner.textures.diagnostics().loading === 0 && owner.textures.diagnostics().queued === 0);
    check(stale.root.destroyed && slot.clipUi === null, "late thumbnail completion cannot restore a removed card");
    check(!refs.has("clip:late-clip"), "late completion cannot retain a removed thumbnail owner");
  } finally {
    release();
    releaseLate();
    await Promise.all(loads);
    setResponse(undefined);
    host.isTauri = wasTauri;
  }
}
