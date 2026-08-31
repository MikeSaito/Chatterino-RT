/** Inline emote sprites in composer: mirror under transparent textarea + URL cache. */

import { invoke } from "@tauri-apps/api/core";
import { isAllowedEmoteCdnUrl } from "../chat/emoteCdnAllowlist.ts";
import { resolveEmoteUrl } from "../chat/emoteUrl.ts";

export type EmoteIconHit = {
  code: string;
  url: string;
};

export type CompleteItem = {
  insert: string;
  url?: string | null;
  kind: string;
};

export function normalizeCompleteItems(raw: unknown): CompleteItem[] {
  if (!Array.isArray(raw)) {
    return [];
  }
  const out: CompleteItem[] = [];
  for (const x of raw) {
    if (typeof x === "string") {
      out.push({ insert: x, url: null, kind: "emote" });
      continue;
    }
    if (!x || typeof x !== "object") {
      continue;
    }
    const row = x as Record<string, unknown>;
    if (typeof row.insert !== "string") {
      continue;
    }
    out.push({
      insert: row.insert,
      url: typeof row.url === "string" ? row.url : null,
      kind: typeof row.kind === "string" ? row.kind : "emote",
    });
  }
  return out;
}

export type ComposerSpriteOpts = {
  enableImages: boolean;
  animate: boolean;
};

const RESOLVE_CAP = 48;
const CODE_MAX = 200;
const MISS_TTL_MS = 60_000;
const ERROR_BACKOFF_MS = 2_500;

function codeUnitLen(s: string): number {
  return Array.from(s).length;
}

export function isSafeEmoteCdnUrl(url: string): boolean {
  return isAllowedEmoteCdnUrl(url);
}

/** Whitespace-aware split; keeps separators for faithful mirror layout. */
export function splitComposerParts(text: string): string[] {
  if (text.length === 0) {
    return [];
  }
  return text.split(/(\s+)/u).filter((p) => p.length > 0);
}

export function collectUnresolvedCodes(
  text: string,
  known: ReadonlyMap<string, string>,
  misses: ReadonlyMap<string, number>,
  now = Date.now(),
): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const part of splitComposerParts(text)) {
    if (/^\s+$/u.test(part)) {
      continue;
    }
    if (codeUnitLen(part) > CODE_MAX) {
      continue;
    }
    if (known.has(part)) {
      continue;
    }
    const missAt = misses.get(part);
    if (missAt !== undefined && now - missAt < MISS_TTL_MS) {
      continue;
    }
    if (seen.has(part)) {
      continue;
    }
    seen.add(part);
    out.push(part);
    if (out.length >= RESOLVE_CAP) {
      break;
    }
  }
  return out;
}

/**
 * Ghost text keeps the same advance width as the textarea token;
 * the img is centered over it so caret/layout stay aligned.
 */
export function paintComposerMirror(
  mirror: HTMLElement,
  text: string,
  urls: ReadonlyMap<string, string>,
  opts: { animate: boolean; enabled: boolean; onImgSettle?: () => void },
): void {
  mirror.replaceChildren();
  if (!opts.enabled) {
    return;
  }
  for (const part of splitComposerParts(text)) {
    if (/^\s+$/u.test(part)) {
      mirror.append(document.createTextNode(part));
      continue;
    }
    const rawUrl = urls.get(part);
    if (!rawUrl || !isSafeEmoteCdnUrl(rawUrl)) {
      mirror.append(document.createTextNode(part));
      continue;
    }
    const slot = document.createElement("span");
    slot.className = "composer-emote-slot";
    const ghost = document.createElement("span");
    ghost.className = "composer-emote-ghost";
    ghost.textContent = part;
    const img = document.createElement("img");
    img.className = "composer-emote";
    img.src = resolveEmoteUrl(rawUrl, opts.animate);
    img.alt = "";
    img.draggable = false;
    img.decoding = "async";
    if (opts.onImgSettle) {
      const settle = (): void => {
        opts.onImgSettle?.();
      };
      img.addEventListener("load", settle, { once: true });
      img.addEventListener("error", settle, { once: true });
    }
    slot.append(ghost, img);
    mirror.append(slot);
  }
  if (text.endsWith("\n") || text.length === 0) {
    mirror.append(document.createTextNode("\u200b"));
  }
}

export function bindComposerEmoteSprites(opts: {
  input: HTMLTextAreaElement;
  mirror: HTMLElement;
  getOpts: () => ComposerSpriteOpts;
}): {
  sync: () => void;
  remember: (code: string, url: string | null | undefined) => void;
  rememberMany: (items: Iterable<{ code?: string; insert?: string; url?: string | null }>) => void;
  clearChannelCache: () => void;
} {
  const { input, mirror, getOpts } = opts;
  const urls = new Map<string, string>();
  const misses = new Map<string, number>();
  let seq = 0;
  let timer = 0;
  let composing = false;

  const syncScroll = (): void => {
    mirror.scrollTop = input.scrollTop;
    mirror.scrollLeft = input.scrollLeft;
  };

  const remember = (code: string, url: string | null | undefined): void => {
    const key = code.trimEnd();
    if (!key || codeUnitLen(key) > CODE_MAX) {
      return;
    }
    if (!url || !isSafeEmoteCdnUrl(url)) {
      return;
    }
    urls.set(key, url);
    misses.delete(key);
  };

  const rememberMany = (
    items: Iterable<{ code?: string; insert?: string; url?: string | null }>,
  ): void => {
    for (const item of items) {
      const code = (item.code ?? item.insert ?? "").trimEnd();
      remember(code, item.url);
    }
  };

  const clearChannelCache = (): void => {
    urls.clear();
    misses.clear();
    seq += 1;
  };

  const paint = (): void => {
    const cfg = getOpts();
    const enabled = cfg.enableImages && !composing;
    input.classList.toggle("is-emote-sprites", enabled);
    paintComposerMirror(mirror, input.value, urls, {
      enabled,
      animate: cfg.animate,
      onImgSettle: syncScroll,
    });
    syncScroll();
  };

  const resolveMissing = async (): Promise<void> => {
    const cfg = getOpts();
    if (!cfg.enableImages || composing) {
      return;
    }
    const codes = collectUnresolvedCodes(input.value, urls, misses);
    if (codes.length === 0) {
      return;
    }
    const token = ++seq;
    try {
      const hits = await invoke<EmoteIconHit[]>("chat_emote_icons", { codes });
      if (token !== seq) {
        return;
      }
      const hitSet = new Set<string>();
      if (Array.isArray(hits)) {
        for (const hit of hits) {
          if (!hit || typeof hit.code !== "string" || typeof hit.url !== "string") {
            continue;
          }
          remember(hit.code, hit.url);
          hitSet.add(hit.code);
        }
      }
      const now = Date.now();
      for (const code of codes) {
        if (!hitSet.has(code) && !urls.has(code)) {
          misses.set(code, now);
        }
      }
      paint();
    } catch {
      if (token !== seq) {
        return;
      }
      // Short backoff on transport failure — do not treat as catalog miss.
      const now = Date.now() - (MISS_TTL_MS - ERROR_BACKOFF_MS);
      for (const code of codes) {
        if (!urls.has(code)) {
          misses.set(code, now);
        }
      }
    }
  };

  const sync = (): void => {
    paint();
    window.clearTimeout(timer);
    timer = window.setTimeout(() => {
      void resolveMissing();
    }, 40);
  };

  input.addEventListener("input", sync);
  input.addEventListener("scroll", syncScroll);
  input.addEventListener("compositionstart", () => {
    composing = true;
    paint();
  });
  input.addEventListener("compositionend", () => {
    composing = false;
    sync();
  });

  return { sync, remember, rememberMany, clearChannelCache };
}
