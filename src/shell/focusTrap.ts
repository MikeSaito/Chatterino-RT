/** Focus trap helpers for modal dialogs (Tab cycle + Escape). */

const FOCUSABLE_SEL =
  'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

export function listFocusables(root: HTMLElement): HTMLElement[] {
  const nodes = root.querySelectorAll<HTMLElement>(FOCUSABLE_SEL);
  return [...nodes].filter((el) => !el.hidden && el.getClientRects().length > 0);
}

/** Pure: next index for Tab / Shift+Tab within a focusable list. */
export function cycleFocusIndex(
  current: number,
  length: number,
  shift: boolean,
): number {
  if (length <= 0) {
    return -1;
  }
  if (current < 0 || current >= length) {
    return shift ? length - 1 : 0;
  }
  if (shift) {
    return current <= 0 ? length - 1 : current - 1;
  }
  return current >= length - 1 ? 0 : current + 1;
}

/** Pure: next channel tab index for Ctrl+Tab / Ctrl+Shift+Tab. */
export function cycleChannelIndex(
  current: number,
  length: number,
  backward: boolean,
): number {
  if (length <= 0) {
    return -1;
  }
  if (length === 1) {
    return 0;
  }
  const i = ((current % length) + length) % length;
  return backward ? (i - 1 + length) % length : (i + 1) % length;
}

export type FocusTrap = {
  activate: () => void;
  deactivate: () => void;
  active: () => boolean;
};

export function bindFocusTrap(
  root: HTMLElement,
  opts?: {
    /** Return true if Escape was handled (close). False → do not preventDefault. */
    onEscape?: () => boolean;
    /** Extra gate (e.g. modal still open). Defaults to always true while activated. */
    isActive?: () => boolean;
  },
): FocusTrap {
  let on = false;

  const onKeyDown = (ev: KeyboardEvent): void => {
    if (!on) {
      return;
    }
    if (opts?.isActive && !opts.isActive()) {
      return;
    }
    if (ev.key === "Escape") {
      if (opts?.onEscape) {
        if (opts.onEscape()) {
          ev.preventDefault();
        }
      }
      return;
    }
    if (ev.key !== "Tab" || ev.ctrlKey || ev.metaKey) {
      return;
    }
    const items = listFocusables(root);
    if (items.length === 0) {
      ev.preventDefault();
      return;
    }
    const active = document.activeElement as HTMLElement | null;
    const cur = active && root.contains(active) ? items.indexOf(active) : -1;
    const next = cycleFocusIndex(cur, items.length, ev.shiftKey);
    if (next < 0) {
      return;
    }
    const atEdge =
      cur < 0 ||
      !active ||
      !root.contains(active) ||
      (ev.shiftKey ? cur <= 0 : cur >= items.length - 1);
    if (atEdge) {
      ev.preventDefault();
      items[next]?.focus();
    }
  };

  return {
    activate: () => {
      if (on) {
        return;
      }
      on = true;
      window.addEventListener("keydown", onKeyDown, true);
    },
    deactivate: () => {
      if (!on) {
        return;
      }
      on = false;
      window.removeEventListener("keydown", onKeyDown, true);
    },
    active: () => on,
  };
}
