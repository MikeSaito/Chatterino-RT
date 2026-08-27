/** Extended player/chat column split (fraction of stage width for the player). */

export const DEFAULT_PLAYER_CHAT_SPLIT = 0.58;
export const MIN_PLAYER_CHAT_SPLIT = 0.35;
export const MAX_PLAYER_CHAT_SPLIT = 0.75;
export const MIN_PLAYER_PX = 400;
export const MIN_CHAT_PX = 280;
export const SPLIT_GUTTER_PX = 6;

export function parsePlayerChatSplit(raw: unknown): number {
  const n = typeof raw === "number" ? raw : Number(raw);
  if (!Number.isFinite(n)) {
    return DEFAULT_PLAYER_CHAT_SPLIT;
  }
  return clampRatio(n);
}

export function clampRatio(ratio: number): number {
  return Math.min(MAX_PLAYER_CHAT_SPLIT, Math.max(MIN_PLAYER_CHAT_SPLIT, ratio));
}

/** Pixel-aware ratio bounds for the current stage width. */
export function ratioBounds(stageWidth: number): { min: number; max: number } {
  const usable = Math.max(1, stageWidth - SPLIT_GUTTER_PX);
  const min = Math.max(MIN_PLAYER_CHAT_SPLIT, MIN_PLAYER_PX / usable);
  const max = Math.min(MAX_PLAYER_CHAT_SPLIT, (usable - MIN_CHAT_PX) / usable);
  if (min <= max) {
    return { min, max };
  }
  const mid = clampRatio((MIN_PLAYER_CHAT_SPLIT + MAX_PLAYER_CHAT_SPLIT) / 2);
  return { min: mid, max: mid };
}

export function clampRatioForStage(stageWidth: number, ratio: number): number {
  const { min, max } = ratioBounds(stageWidth);
  return Math.min(max, Math.max(min, ratio));
}

/** Convert desired player pixel width into a clamped ratio for the stage. */
export function ratioFromPlayerWidth(stageWidth: number, playerWidth: number): number {
  const usable = Math.max(1, stageWidth - SPLIT_GUTTER_PX);
  return clampRatioForStage(stageWidth, playerWidth / usable);
}

export function applyStageColumns(stage: HTMLElement, ratio: number): void {
  const width = stage.getBoundingClientRect().width || stage.clientWidth || 960;
  const r = clampRatioForStage(width, ratio);
  const playerFr = Math.max(0.01, r);
  const chatFr = Math.max(0.01, 1 - r);
  stage.style.gridTemplateColumns = `minmax(${MIN_PLAYER_PX}px, ${playerFr}fr) ${SPLIT_GUTTER_PX}px minmax(${MIN_CHAT_PX}px, ${chatFr}fr)`;
}

export function clearStageColumns(stage: HTMLElement): void {
  stage.style.removeProperty("grid-template-columns");
}

function syncAria(split: HTMLElement, ratio: number, enabled: boolean): void {
  split.tabIndex = enabled ? 0 : -1;
  split.setAttribute("aria-disabled", enabled ? "false" : "true");
  const pct = Math.round(clampRatio(ratio) * 100);
  split.setAttribute("aria-valuemin", String(Math.round(MIN_PLAYER_CHAT_SPLIT * 100)));
  split.setAttribute("aria-valuemax", String(Math.round(MAX_PLAYER_CHAT_SPLIT * 100)));
  split.setAttribute("aria-valuenow", String(pct));
}

export function bindStageSplit(opts: {
  stage: HTMLElement;
  split: HTMLElement;
  isEnabled: () => boolean;
  getRatio: () => number;
  setRatio: (ratio: number) => void;
  onCommit: (ratio: number) => void;
}): {
  refresh: () => void;
  dispose: () => void;
  isDragging: () => boolean;
} {
  let dragging = false;
  let pointerId: number | null = null;
  let raf = 0;
  let pendingX = 0;
  let suppressCommit = false;

  const paint = (ratio: number): void => {
    const enabled = opts.isEnabled();
    syncAria(opts.split, ratio, enabled);
    if (!enabled) {
      clearStageColumns(opts.stage);
      opts.split.classList.remove("is-dragging");
      return;
    }
    applyStageColumns(opts.stage, ratio);
  };

  const refresh = (): void => {
    if (dragging) {
      return;
    }
    paint(opts.getRatio());
  };

  const applyPointerX = (): void => {
    if (!opts.isEnabled()) {
      return;
    }
    const rect = opts.stage.getBoundingClientRect();
    if (rect.width <= SPLIT_GUTTER_PX + MIN_PLAYER_PX + MIN_CHAT_PX) {
      return;
    }
    let playerW = pendingX - rect.left;
    const maxPlayer = rect.width - SPLIT_GUTTER_PX - MIN_CHAT_PX;
    playerW = Math.min(maxPlayer, Math.max(MIN_PLAYER_PX, playerW));
    const next = ratioFromPlayerWidth(rect.width, playerW);
    opts.setRatio(next);
    paint(next);
  };

  const flushMove = (): void => {
    raf = 0;
    if (!dragging) {
      return;
    }
    applyPointerX();
  };

  const finishDrag = (commit: boolean): void => {
    if (!dragging) {
      return;
    }
    if (raf !== 0) {
      cancelAnimationFrame(raf);
      raf = 0;
      applyPointerX();
    }
    dragging = false;
    pointerId = null;
    opts.split.classList.remove("is-dragging");
    if (commit && !suppressCommit) {
      opts.onCommit(opts.getRatio());
    }
  };

  const onPointerDown = (ev: PointerEvent): void => {
    if (!opts.isEnabled() || ev.button !== 0) {
      return;
    }
    dragging = true;
    pointerId = ev.pointerId;
    opts.split.classList.add("is-dragging");
    opts.split.setPointerCapture(ev.pointerId);
    pendingX = ev.clientX;
    ev.preventDefault();
  };

  const onPointerMove = (ev: PointerEvent): void => {
    if (!dragging || pointerId !== ev.pointerId) {
      return;
    }
    pendingX = ev.clientX;
    if (raf === 0) {
      raf = requestAnimationFrame(flushMove);
    }
  };

  const onPointerUp = (ev: PointerEvent): void => {
    if (pointerId != null && pointerId !== ev.pointerId) {
      return;
    }
    try {
      opts.split.releasePointerCapture(ev.pointerId);
    } catch {
      /* already released */
    }
    finishDrag(true);
  };

  const onLostCapture = (): void => {
    finishDrag(true);
  };

  const onDblClick = (ev: MouseEvent): void => {
    if (!opts.isEnabled() || ev.button !== 0) {
      return;
    }
    suppressCommit = true;
    finishDrag(false);
    suppressCommit = false;
    opts.setRatio(DEFAULT_PLAYER_CHAT_SPLIT);
    paint(DEFAULT_PLAYER_CHAT_SPLIT);
    opts.onCommit(DEFAULT_PLAYER_CHAT_SPLIT);
  };

  const onKeyDown = (ev: KeyboardEvent): void => {
    if (!opts.isEnabled()) {
      return;
    }
    const width = opts.stage.getBoundingClientRect().width;
    const { min, max } = ratioBounds(width);
    const step = ev.shiftKey ? 0.05 : 0.02;
    let next = opts.getRatio();
    if (ev.key === "ArrowLeft") {
      next = next - step;
    } else if (ev.key === "ArrowRight") {
      next = next + step;
    } else if (ev.key === "Home") {
      next = min;
    } else if (ev.key === "End") {
      next = max;
    } else {
      return;
    }
    ev.preventDefault();
    next = clampRatioForStage(width, next);
    opts.setRatio(next);
    paint(next);
    opts.onCommit(next);
  };

  opts.split.addEventListener("pointerdown", onPointerDown);
  opts.split.addEventListener("pointermove", onPointerMove);
  opts.split.addEventListener("pointerup", onPointerUp);
  opts.split.addEventListener("pointercancel", onPointerUp);
  opts.split.addEventListener("lostpointercapture", onLostCapture);
  opts.split.addEventListener("dblclick", onDblClick);
  opts.split.addEventListener("keydown", onKeyDown);

  refresh();

  return {
    refresh,
    isDragging: () => dragging,
    dispose: () => {
      if (raf !== 0) {
        cancelAnimationFrame(raf);
        raf = 0;
      }
      dragging = false;
      opts.split.removeEventListener("pointerdown", onPointerDown);
      opts.split.removeEventListener("pointermove", onPointerMove);
      opts.split.removeEventListener("pointerup", onPointerUp);
      opts.split.removeEventListener("pointercancel", onPointerUp);
      opts.split.removeEventListener("lostpointercapture", onLostCapture);
      opts.split.removeEventListener("dblclick", onDblClick);
      opts.split.removeEventListener("keydown", onKeyDown);
      opts.split.classList.remove("is-dragging");
      clearStageColumns(opts.stage);
    },
  };
}
