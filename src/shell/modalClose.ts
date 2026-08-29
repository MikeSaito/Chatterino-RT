/** Modal close: `.is-closing` fade+scale, then `hidden`. */

export const MODAL_CLOSE_MS = 120;
export const MODAL_CLOSE_FALLBACK_MS = 140;

export type ModalCloseDecision = "instant" | "animate";

/** Pure: skip animation when already hidden or reduced-motion. */
export function modalCloseDecision(
  hidden: boolean,
  reducedMotion: boolean,
): ModalCloseDecision {
  return hidden || reducedMotion ? "instant" : "animate";
}

export function modalCloseFallbackMs(durationMs = MODAL_CLOSE_MS): number {
  return Math.max(durationMs + 20, MODAL_CLOSE_FALLBACK_MS);
}

type Inflight = {
  cancelled: boolean;
  promise: Promise<void>;
  abort: () => void;
  settle: () => void;
};

const inflight = new WeakMap<HTMLElement, Inflight>();

function prefersReducedMotion(): boolean {
  return (
    typeof matchMedia === "function" &&
    matchMedia("(prefers-reduced-motion: reduce)").matches
  );
}

function findDialog(modal: HTMLElement): HTMLElement | null {
  const byRole = modal.querySelector<HTMLElement>('[role="dialog"]');
  if (byRole) {
    return byRole;
  }
  return modal.querySelector<HTMLElement>("[id$='-dialog']");
}

function finishHide(modal: HTMLElement): void {
  modal.classList.remove("is-closing");
  modal.hidden = true;
}

/** Cancel an in-flight close so open can show immediately. */
export function cancelModalClose(modal: HTMLElement): void {
  const cur = inflight.get(modal);
  if (cur) {
    cur.cancelled = true;
    cur.abort();
    inflight.delete(modal);
    cur.settle();
  }
  modal.classList.remove("is-closing");
}

/** Instant hide (force-close, teardown). */
export function closeModalImmediate(modal: HTMLElement): void {
  cancelModalClose(modal);
  modal.hidden = true;
}

/**
 * Animated close. Concurrent calls share the same promise.
 * Call `cancelModalClose` / `prepareModalOpen` before reopening mid-animation.
 */
export function closeModal(
  modal: HTMLElement,
  opts?: { durationMs?: number },
): Promise<void> {
  const existing = inflight.get(modal);
  if (existing) {
    return existing.promise;
  }

  if (modal.hidden) {
    modal.classList.remove("is-closing");
    return Promise.resolve();
  }

  const duration = opts?.durationMs ?? MODAL_CLOSE_MS;
  if (modalCloseDecision(false, prefersReducedMotion()) === "instant") {
    finishHide(modal);
    return Promise.resolve();
  }

  let fallback = 0;
  let onEnd: ((ev: TransitionEvent) => void) | null = null;
  let resolveFn: (() => void) | null = null;
  const dialog = findDialog(modal);

  const state: Inflight = {
    cancelled: false,
    promise: Promise.resolve(),
    abort: () => {
      if (fallback !== 0) {
        window.clearTimeout(fallback);
        fallback = 0;
      }
      if (onEnd && dialog) {
        dialog.removeEventListener("transitionend", onEnd);
        onEnd = null;
      }
    },
    settle: () => {
      const r = resolveFn;
      resolveFn = null;
      r?.();
    },
  };

  state.promise = new Promise<void>((resolve) => {
    resolveFn = resolve;
    modal.classList.add("is-closing");
    let done = false;
    const complete = (): void => {
      if (done) {
        return;
      }
      done = true;
      state.abort();
      if (state.cancelled) {
        state.settle();
        return;
      }
      if (inflight.get(modal) === state) {
        inflight.delete(modal);
      }
      finishHide(modal);
      state.settle();
    };
    onEnd = (ev: TransitionEvent): void => {
      if (ev.target !== dialog) {
        return;
      }
      if (ev.propertyName !== "opacity" && ev.propertyName !== "transform") {
        return;
      }
      complete();
    };
    fallback = window.setTimeout(complete, modalCloseFallbackMs(duration));
    dialog?.addEventListener("transitionend", onEnd);
  });

  inflight.set(modal, state);
  return state.promise;
}

/** Show modal, cancelling any in-flight close animation. */
export function prepareModalOpen(modal: HTMLElement): void {
  cancelModalClose(modal);
  modal.hidden = false;
}
