import { invoke } from "@tauri-apps/api/core";
import type { MessageRing, TooltipHit } from "../chat/ring";

export type TooltipPreviewMode = "DontShow" | "AlwaysShow" | "ShowOnShift";
export type EmoteTooltipScale = "Small" | "Medium" | "Large" | "Huge";

type LinkInfoResponse = {
  tooltip: string;
  thumbnail_url?: string | null;
  resolved_url?: string | null;
};

const CURSOR_OFFSET = 12;
const VIEWPORT_PAD = 4;
const RESOLVE_FAIL_TTL_MS = 60_000;
const RESOLVED_CACHE_LIMIT = 200;
const resolveCache = new Map<string, Promise<LinkInfoResponse>>();
const resolveFailUntil = new Map<string, number>();
/** Original chat URL → validated resolved destination from resolver `link`. */
const resolvedUrlByOriginal = new Map<string, string>();

function rememberResolved(original: string, resolved: string): void {
  if (resolvedUrlByOriginal.has(original)) {
    resolvedUrlByOriginal.delete(original);
  }
  resolvedUrlByOriginal.set(original, resolved);
  while (resolvedUrlByOriginal.size > RESOLVED_CACHE_LIMIT) {
    const oldest = resolvedUrlByOriginal.keys().next().value;
    if (oldest === undefined) {
      break;
    }
    resolvedUrlByOriginal.delete(oldest);
  }
}

export function cachedResolvedUrl(original: string): string | undefined {
  return resolvedUrlByOriginal.get(original);
}

/** Sync open URL when cache already warm. */
export function openUrlForChatLink(
  original: string,
  unshortLinks: boolean,
): string {
  if (!unshortLinks) {
    return original;
  }
  return cachedResolvedUrl(original) ?? original;
}

/**
 * When unshortLinks is on: use cache or resolve-on-click (stock-like).
 * On failure / no `link` field: original URL.
 */
export async function resolveOpenUrlForChatLink(
  original: string,
  unshortLinks: boolean,
): Promise<string> {
  if (!unshortLinks) {
    return original;
  }
  const hit = cachedResolvedUrl(original);
  if (hit) {
    return hit;
  }
  try {
    const info = await fetchLinkInfo(original);
    const resolved = info.resolved_url?.trim();
    return resolved || original;
  } catch {
    return original;
  }
}

export function parseTooltipPreviewMode(raw: unknown): TooltipPreviewMode {
  if (raw === "DontShow" || raw === "AlwaysShow" || raw === "ShowOnShift") {
    return raw;
  }
  return "AlwaysShow";
}

export function parseEmoteTooltipScale(raw: unknown): EmoteTooltipScale {
  if (raw === "Small" || raw === "Medium" || raw === "Large" || raw === "Huge") {
    return raw;
  }
  return "Medium";
}

export function parseThumbnailSize(raw: unknown): number {
  if (raw === "100" || raw === 100) {
    return 100;
  }
  if (raw === "200" || raw === 200) {
    return 200;
  }
  if (raw === "300" || raw === 300) {
    return 300;
  }
  return 0;
}

export function shouldShowImage(
  mode: TooltipPreviewMode,
  shiftKey: boolean,
): boolean {
  if (mode === "DontShow") {
    return false;
  }
  if (mode === "ShowOnShift") {
    return shiftKey;
  }
  return true;
}

export function tooltipScalePx(scale: EmoteTooltipScale): number {
  switch (scale) {
    case "Small":
      return 56;
    case "Large":
      return 168;
    case "Huge":
      return 224;
    default:
      return 112;
  }
}

function fetchLinkInfo(url: string): Promise<LinkInfoResponse> {
  const failUntil = resolveFailUntil.get(url);
  if (failUntil !== undefined && Date.now() < failUntil) {
    return Promise.reject(new Error("link resolve cached failure"));
  }
  let pending = resolveCache.get(url);
  if (!pending) {
    pending = invoke<LinkInfoResponse>("resolve_link_info", { url })
      .then((info) => {
        const resolved = info.resolved_url?.trim();
        if (resolved) {
          rememberResolved(url, resolved);
        } else {
          resolvedUrlByOriginal.delete(url);
        }
        return info;
      })
      .catch((err: unknown) => {
        resolveCache.delete(url);
        resolveFailUntil.set(url, Date.now() + RESOLVE_FAIL_TTL_MS);
        throw err;
      });
    resolveCache.set(url, pending);
  }
  return pending;
}

export function bindEmoteTooltip(opts: {
  host: HTMLElement;
  ring: MessageRing;
  tooltip: HTMLElement;
  img: HTMLImageElement;
  text: HTMLElement;
  getPreviewMode: () => TooltipPreviewMode;
  getScale: () => EmoteTooltipScale;
  getLinkInfoEnabled: () => boolean;
  getThumbnailSizePx: () => number;
  getHideLinkThumbnails: () => boolean;
}): { hide: () => void; refresh: () => void } {
  let lastImageUrl = "";
  let lastHit: TooltipHit | null = null;
  let lastX = 0;
  let lastY = 0;
  let lastShift = false;
  let activeResolveUrl = "";

  const hide = (): void => {
    opts.tooltip.hidden = true;
    opts.img.hidden = true;
    lastImageUrl = "";
    lastHit = null;
    activeResolveUrl = "";
  };

  const positionTooltip = (clientX: number, clientY: number): void => {
    const hostRect = opts.host.getBoundingClientRect();
    const tip = opts.tooltip;
    const tipW = tip.offsetWidth;
    const tipH = tip.offsetHeight;
    let left = clientX - hostRect.left + CURSOR_OFFSET;
    let top = clientY - hostRect.top + CURSOR_OFFSET;
    const maxLeft = Math.max(VIEWPORT_PAD, hostRect.width - tipW - VIEWPORT_PAD);
    const maxTop = Math.max(VIEWPORT_PAD, hostRect.height - tipH - VIEWPORT_PAD);
    left = Math.min(Math.max(VIEWPORT_PAD, left), maxLeft);
    top = Math.min(Math.max(VIEWPORT_PAD, top), maxTop);
    tip.style.left = `${left}px`;
    tip.style.top = `${top}px`;
  };

  const paintImage = (imageUrl: string, sizePx: number): void => {
    opts.img.style.width = `${sizePx}px`;
    opts.img.style.height = `${sizePx}px`;
    opts.img.hidden = false;
    if (imageUrl !== lastImageUrl) {
      opts.img.src = imageUrl;
      lastImageUrl = imageUrl;
    }
  };

  const clearImage = (): void => {
    opts.img.hidden = true;
    opts.img.removeAttribute("src");
    lastImageUrl = "";
  };

  const showEmote = (
    hit: TooltipHit,
    clientX: number,
    clientY: number,
    shiftKey: boolean,
  ): void => {
    opts.text.textContent = hit.text;
    const mode = opts.getPreviewMode();
    const scale = opts.getScale();
    const imageUrl =
      shouldShowImage(mode, shiftKey) && hit.imageUrl ? hit.imageUrl : "";
    if (imageUrl) {
      paintImage(imageUrl, tooltipScalePx(scale));
    } else {
      clearImage();
    }
    opts.tooltip.hidden = false;
    positionTooltip(clientX, clientY);
  };

  const showLink = async (
    hit: TooltipHit,
    clientX: number,
    clientY: number,
  ): Promise<void> => {
    const url = hit.resolveUrl;
    if (!url) {
      return;
    }
    activeResolveUrl = url;
    opts.text.textContent = hit.text;
    clearImage();
    opts.tooltip.hidden = false;
    positionTooltip(clientX, clientY);
    try {
      const info = await fetchLinkInfo(url);
      if (activeResolveUrl !== url || lastHit?.resolveUrl !== url) {
        return;
      }
      opts.text.textContent = info.tooltip || url;
      const thumbPx = opts.getThumbnailSizePx();
      const thumb = info.thumbnail_url ?? undefined;
      if (thumbPx > 0 && thumb && !opts.getHideLinkThumbnails()) {
        paintImage(thumb, thumbPx);
      } else {
        clearImage();
      }
      positionTooltip(clientX, clientY);
    } catch {
      if (activeResolveUrl !== url || lastHit?.resolveUrl !== url) {
        return;
      }
      opts.text.textContent = "No link info found";
      clearImage();
      positionTooltip(clientX, clientY);
    }
  };

  const present = (
    hit: TooltipHit,
    clientX: number,
    clientY: number,
    shiftKey: boolean,
  ): void => {
    if (hit.resolveUrl) {
      if (!opts.getLinkInfoEnabled()) {
        hide();
        return;
      }
      void showLink(hit, clientX, clientY);
      return;
    }
    activeResolveUrl = "";
    showEmote(hit, clientX, clientY, shiftKey);
  };

  const refresh = (): void => {
    if (lastHit === null) {
      return;
    }
    const hit = opts.ring.tooltipHitAt(lastX, lastY);
    if (!hit) {
      hide();
      return;
    }
    lastHit = hit;
    present(hit, lastX, lastY, lastShift);
  };

  const onPointer = (clientX: number, clientY: number, shiftKey: boolean): void => {
    lastX = clientX;
    lastY = clientY;
    lastShift = shiftKey;
    const hit = opts.ring.tooltipHitAt(clientX, clientY);
    if (!hit) {
      hide();
      return;
    }
    if (hit.resolveUrl && !opts.getLinkInfoEnabled()) {
      hide();
      return;
    }
    lastHit = hit;
    present(hit, clientX, clientY, shiftKey);
  };

  const onShiftChange = (): void => {
    if (lastHit === null || lastHit.resolveUrl) {
      return;
    }
    showEmote(lastHit, lastX, lastY, lastShift);
  };

  opts.host.addEventListener("pointermove", (ev) => {
    onPointer(ev.clientX, ev.clientY, ev.shiftKey);
  });
  opts.host.addEventListener("pointerleave", hide);
  window.addEventListener("keydown", (ev) => {
    if (ev.key !== "Shift") {
      return;
    }
    lastShift = true;
    onShiftChange();
  });
  window.addEventListener("keyup", (ev) => {
    if (ev.key !== "Shift") {
      return;
    }
    lastShift = false;
    onShiftChange();
  });
  opts.img.addEventListener("load", () => {
    if (lastHit !== null && !opts.tooltip.hidden) {
      positionTooltip(lastX, lastY);
    }
  });
  opts.img.addEventListener("error", () => {
    opts.img.hidden = true;
    if (lastHit !== null && !opts.tooltip.hidden) {
      positionTooltip(lastX, lastY);
    }
  });

  return { hide, refresh };
}
