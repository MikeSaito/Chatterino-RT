import type { MessageRing, TooltipHit } from "../chat/ring";

export type TooltipPreviewMode = "DontShow" | "AlwaysShow" | "ShowOnShift";
export type EmoteTooltipScale = "Small" | "Medium" | "Large" | "Huge";

const CURSOR_OFFSET = 12;
const VIEWPORT_PAD = 4;

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

export function bindEmoteTooltip(opts: {
  host: HTMLElement;
  ring: MessageRing;
  tooltip: HTMLElement;
  img: HTMLImageElement;
  text: HTMLElement;
  getPreviewMode: () => TooltipPreviewMode;
  getScale: () => EmoteTooltipScale;
}): { hide: () => void; refresh: () => void } {
  let lastImageUrl = "";
  let lastHit: TooltipHit | null = null;
  let lastX = 0;
  let lastY = 0;
  let lastShift = false;

  const hide = (): void => {
    opts.tooltip.hidden = true;
    opts.img.hidden = true;
    lastImageUrl = "";
    lastHit = null;
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

  const show = (
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
      const px = tooltipScalePx(scale);
      opts.img.style.width = `${px}px`;
      opts.img.style.height = `${px}px`;
      opts.img.hidden = false;
      if (imageUrl !== lastImageUrl) {
        opts.img.src = imageUrl;
        lastImageUrl = imageUrl;
      }
    } else {
      opts.img.hidden = true;
      opts.img.removeAttribute("src");
      lastImageUrl = "";
    }
    opts.tooltip.hidden = false;
    positionTooltip(clientX, clientY);
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
    show(hit, lastX, lastY, lastShift);
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
    lastHit = hit;
    show(hit, clientX, clientY, shiftKey);
  };

  const onShiftChange = (): void => {
    if (lastHit === null) {
      return;
    }
    show(lastHit, lastX, lastY, lastShift);
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
