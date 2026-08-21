import { invoke } from "@tauri-apps/api/core";

type SoundPayload = {
  mime: string;
  data: string;
};

let lastPlay = 0;
let cachedCustom: { path: string; url: string } | null = null;
let alwaysPlay = false;
let customPath = "";

export function configureHighlightSound(opts: {
  alwaysPlay: boolean;
  path: string;
}): void {
  alwaysPlay = opts.alwaysPlay;
  const next = opts.path.trim();
  if (next !== customPath) {
    customPath = next;
    if (cachedCustom) {
      URL.revokeObjectURL(cachedCustom.url);
      cachedCustom = null;
    }
  }
}

export function notifyHighlightSounds(
  events: ReadonlyArray<{ highlightSound?: boolean } | object>,
): void {
  if (!events.some((ev) => "highlightSound" in ev && ev.highlightSound === true)) {
    return;
  }
  void playHighlightSound();
}

export async function playHighlightSound(): Promise<void> {
  const focused = document.hasFocus();
  if (focused && !alwaysPlay) {
    return;
  }
  const now = Date.now();
  if (now - lastPlay < 100) {
    return;
  }
  lastPlay = now;
  try {
    const src = await resolveSrc();
    const audio = new Audio(src);
    audio.volume = 0.7;
    await audio.play();
  } catch {
    // Autoplay / decode failures are non-fatal.
  }
}

async function resolveSrc(): Promise<string> {
  if (!customPath) {
    return "/sounds/ping.wav";
  }
  if (cachedCustom && cachedCustom.path === customPath) {
    return cachedCustom.url;
  }
  const payload = await invoke<SoundPayload>("highlight_sound_read", {
    path: customPath || null,
  });
  const bin = Uint8Array.from(atob(payload.data), (c) => c.charCodeAt(0));
  const blob = new Blob([bin], { type: payload.mime || "audio/wav" });
  const url = URL.createObjectURL(blob);
  if (cachedCustom) {
    URL.revokeObjectURL(cachedCustom.url);
  }
  cachedCustom = { path: customPath, url };
  return url;
}
