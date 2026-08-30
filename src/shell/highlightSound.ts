import { invoke } from "@tauri-apps/api/core";

type SoundPayload = {
  mime: string;
  data: string;
};

const MAX_SOUND_CACHE = 16;
const PLAY_GAP_MS = 100;

let lastPlay = 0;
const cachedCustom = new Map<string, string>();
let alwaysPlay = false;
let customPath = "";
let muted = false;

function clearSoundCache(): void {
  for (const url of cachedCustom.values()) {
    URL.revokeObjectURL(url);
  }
  cachedCustom.clear();
}

function rememberCached(path: string, url: string): void {
  const prev = cachedCustom.get(path);
  if (prev) {
    URL.revokeObjectURL(prev);
  }
  cachedCustom.set(path, url);
  while (cachedCustom.size > MAX_SOUND_CACHE) {
    const oldest = cachedCustom.keys().next().value;
    if (oldest === undefined) {
      break;
    }
    URL.revokeObjectURL(cachedCustom.get(oldest)!);
    cachedCustom.delete(oldest);
  }
}

export function configureHighlightSound(opts: {
  alwaysPlay: boolean;
  path: string;
  muted?: boolean;
}): void {
  alwaysPlay = opts.alwaysPlay;
  muted = opts.muted === true;
  const next = opts.path.trim();
  if (next !== customPath) {
    customPath = next;
    clearSoundCache();
  }
}

/** Gate for mention/highlight playback (not live-notify). */
export function highlightSoundMayPlay(focused: boolean): boolean {
  if (muted) {
    return false;
  }
  if (focused && !alwaysPlay) {
    return false;
  }
  return true;
}

function documentIsFocused(): boolean {
  return typeof document !== "undefined" && document.hasFocus();
}

export function notifyHighlightSounds(
  events: ReadonlyArray<
    { highlightSound?: boolean; highlightSoundPath?: string } | object
  >,
): void {
  const hits = events.filter(
    (ev): ev is { highlightSound: true; highlightSoundPath?: string } =>
      "highlightSound" in ev && ev.highlightSound === true,
  );
  if (hits.length === 0) {
    return;
  }
  void playHighlightSoundBatch(hits);
}

async function playHighlightSoundBatch(
  hits: ReadonlyArray<{ highlightSoundPath?: string }>,
): Promise<boolean> {
  if (!highlightSoundMayPlay(documentIsFocused())) {
    return false;
  }
  for (const hit of hits) {
    const now = Date.now();
    const wait = PLAY_GAP_MS - (now - lastPlay);
    if (wait > 0) {
      await new Promise((resolve) => setTimeout(resolve, wait));
    }
    lastPlay = Date.now();
    const path =
      typeof hit.highlightSoundPath === "string"
        ? hit.highlightSoundPath.trim()
        : "";
    try {
      const src = await resolveSrc(path || undefined);
      const audio = new Audio(src);
      audio.volume = 0.7;
      await audio.play();
    } catch {
      // Autoplay / decode failures are non-fatal.
    }
  }
  return true;
}

/** Returns false when muted / focus-suppressed (playback not attempted). */
export async function playHighlightSound(overridePath?: string): Promise<boolean> {
  return playHighlightSoundBatch([
    { highlightSoundPath: overridePath },
  ]);
}

/** Live notifications: always play when Rust gated the event (ignore focus / mention mute). */
export async function playLiveNotifySound(overridePath?: string): Promise<void> {
  const now = Date.now();
  const wait = PLAY_GAP_MS - (now - lastPlay);
  if (wait > 0) {
    await new Promise((resolve) => setTimeout(resolve, wait));
  }
  lastPlay = Date.now();
  try {
    const src = await resolveSrc(overridePath?.trim() || undefined);
    const audio = new Audio(src);
    audio.volume = 1;
    await audio.play();
  } catch {
    // Autoplay / decode failures are non-fatal.
  }
}

async function resolveSrc(overridePath?: string): Promise<string> {
  const path = overridePath?.trim() || customPath;
  if (!path) {
    return "/sounds/ping.wav";
  }
  const cached = cachedCustom.get(path);
  if (cached) {
    return cached;
  }
  const payload = await invoke<SoundPayload>("highlight_sound_read", {
    path,
  });
  const bin = Uint8Array.from(atob(payload.data), (c) => c.charCodeAt(0));
  const blob = new Blob([bin], { type: payload.mime || "audio/wav" });
  const url = URL.createObjectURL(blob);
  rememberCached(path, url);
  return url;
}
