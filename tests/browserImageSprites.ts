import type { BitmapText, Sprite } from "pixi.js";
import type { MessageRing } from "../src/chat/ring";
import type { ChatEvent } from "../src/chat/types";
import type { BadgeVisibilityFlags } from "../src/chat/badgeVisibility";

type Response = (url: string) => Promise<{ bytes: number[]; contentType: string }>;
function check(value: unknown, message: string): void { if (!value) throw new Error(message); }
const frame = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
async function until(test: () => boolean) {
  const deadline = performance.now() + 10_000;
  while (!test()) { if (performance.now() > deadline) throw new Error("Sprite lifecycle timeout"); await frame(); }
}

export async function checkImageSprites(ring: MessageRing, send: (event: ChatEvent) => void, setResponse: (response?: Response) => void, images: (enabled: boolean) => Promise<void>, restore: () => void) {
  const owner = ring as unknown as {
    badgeVisibility: BadgeVisibilityFlags;
    slots: { msgId: string; emotes: Sprite[]; badges: Sprite[]; modIcons: Sprite[]; body: BitmapText; bodyCont: BitmapText }[];
  };
  const flags = { ...owner.badgeVisibility };
  const wasMod = ring.moderationModeOn();
  const couldModerate = ring.canModerateOn();
  const host = window as Window & { isTauri?: boolean };
  const wasTauri = host.isTauri;
  host.isTauri = true;
  const bytes = await (await fetch("/src-tauri/fixtures/animated-emote.gif")).arrayBuffer();
  const image = { bytes: Array.from(new Uint8Array(bytes)), contentType: "image/gif" };
  const base = "https://cdn.7tv.app/emote";
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  setResponse(async (url) => { if (url.includes("/slow-badge/")) await gate; return image; });
  try {
    ring.goToBottom();
    send({ kind: "privmsg", id: "sprite-lifecycle", timestampMs: Date.now(), userId: "1", login: "viewer", displayName: "Viewer", color: "#6699ff", action: false,
      text: "Wave Glow", badges: [{ set: "subscriber", version: "1", url: `${base}/slow-badge/1x.gif` }],
      emoteSpans: [{ start: 0, end: 4, provider: "7tv", emoteId: "sprite-wave", url: `${base}/sprite-wave/1x.gif`, zeroWidth: false }, { start: 5, end: 9, provider: "7tv", emoteId: "sprite-glow", url: `${base}/sprite-glow/1x.gif`, zeroWidth: true }],
    });
    await until(() => owner.slots.some((slot) => slot.msgId === "sprite-lifecycle"));
    const slot = owner.slots.find((row) => row.msgId === "sprite-lifecycle")!;
    await until(() => slot.emotes.length === 2 && slot.emotes.every((sprite) => sprite.visible));
    const oldBadge = slot.badges[0];
    ring.configureBadgeVisibility({ ...flags, subscription: false });
    check(slot.badges.length === 0 && oldBadge.destroyed, "hiding badges destroys unused sprites");
    ring.configureBadgeVisibility(flags);
    check(slot.badges[0] !== oldBadge, "restoring visibility creates a fresh badge sprite");
    release();
    await until(() => slot.badges[0]?.visible === true);
    ring.setCanModerate(true); ring.setModerationMode(true);
    await frame();
    check(slot.modIcons.length === 2 && slot.modIcons.every((sprite) => sprite.visible), "moderation icons are created on demand");
    const icons = [...slot.modIcons];
    ring.setModerationMode(false);
    check(slot.modIcons.length === 0 && icons.every((sprite) => sprite.destroyed), "disabling moderation releases its sprites");
    const oldEmotes = [...slot.emotes];
    await images(false);
    check(slot.emotes.length === 0 && oldEmotes.every((sprite) => sprite.destroyed), "disabling images releases emote sprites");
    check(`${slot.body.text}${slot.bodyCont.text}`.includes("Wave"), "image codes remain readable with images disabled");
    await images(true);
    await until(() => slot.emotes.length === 2 && slot.emotes.every((sprite) => sprite.visible));
    const sprites = [...slot.emotes, ...slot.badges];
    restore();
    check(sprites.every((sprite) => sprite.destroyed), "replacing history destroys image sprites");
  } finally {
    release();
    ring.configureBadgeVisibility(flags);
    ring.setModerationMode(wasMod); ring.setCanModerate(couldModerate);
    setResponse(undefined);
    host.isTauri = wasTauri;
  }
}
