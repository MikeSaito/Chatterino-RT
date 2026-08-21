import type { MessageRing } from "./ring";
import type { ScrollSnapshot } from "./scroll";

export function bindScrollChrome(opts: {
  ring: MessageRing;
  host: HTMLElement;
  track: HTMLElement;
  thumb: HTMLElement;
  jump: HTMLButtonElement;
  onScroll?: (state: ScrollSnapshot) => void;
}): void {
  const { ring, host, track, thumb, jump, onScroll } = opts;

  const paint = (state: ScrollSnapshot): void => {
    track.classList.toggle("idle", !state.overflow);
    track.setAttribute("aria-valuemin", "0");
    track.setAttribute("aria-valuemax", String(state.bottom));
    track.setAttribute("aria-valuenow", String(state.desired));
    jump.hidden = state.atBottom;
    layoutThumb(state);
    onScroll?.(state);
  };

  const layoutThumb = (state: ScrollSnapshot): void => {
    const trackH = track.clientHeight;
    if (trackH <= 0 || !state.overflow || state.contentRows <= 0) {
      thumb.style.height = "0px";
      thumb.style.transform = "translateY(0)";
      return;
    }
    const ratio = Math.min(1, state.viewRows / state.contentRows);
    const thumbH = Math.max(16, trackH * ratio);
    const travel = Math.max(0, trackH - thumbH);
    const t = state.bottom <= 0 ? 1 : state.desired / state.bottom;
    thumb.style.height = `${thumbH}px`;
    thumb.style.transform = `translateY(${t * travel}px)`;
  };

  ring.setOnScroll(paint);
  paint(ring.scrollSnapshot());

  const onWheel = (ev: WheelEvent): void => {
    ring.handleWheel(ev);
  };
  host.addEventListener("wheel", onWheel, { passive: false });
  track.addEventListener("wheel", onWheel, { passive: false });

  host.addEventListener("pointerenter", () => {
    ring.noteChatHover();
  });
  host.addEventListener("pointermove", () => {
    ring.noteChatHover();
  });
  host.addEventListener("pointerleave", () => {
    ring.leaveChatHover();
  });

  const syncKeyPause = (ev: KeyboardEvent | FocusEvent): void => {
    const mod = ring.pauseModifierName();
    if (mod === "None") {
      ring.setKeyPause(false);
      return;
    }
    if (ev instanceof FocusEvent) {
      ring.setKeyPause(false);
      return;
    }
    const shift = ev.shiftKey;
    const ctrl = ev.ctrlKey;
    const alt = ev.altKey;
    const meta = ev.metaKey;
    const down =
      (mod === "Shift" && shift && !ctrl && !alt && !meta) ||
      (mod === "Control" && ctrl && !shift && !alt && !meta) ||
      (mod === "Alt" && alt && !shift && !ctrl && !meta) ||
      (mod === "Meta" && meta && !shift && !ctrl && !alt);
    ring.setKeyPause(down);
  };
  window.addEventListener("keydown", syncKeyPause);
  window.addEventListener("keyup", syncKeyPause);
  window.addEventListener("blur", syncKeyPause);

  jump.addEventListener("click", () => {
    ring.goToBottom();
  });

  const yToDesired = (clientY: number, state: ScrollSnapshot): number => {
    const rect = track.getBoundingClientRect();
    const trackH = rect.height;
    const ratio =
      state.contentRows > 0 ? Math.min(1, state.viewRows / state.contentRows) : 1;
    const thumbH = Math.max(16, trackH * ratio);
    const travel = Math.max(1, trackH - thumbH);
    const y = clientY - rect.top - thumbH / 2;
    const t = Math.min(1, Math.max(0, y / travel));
    return t * state.bottom;
  };

  let dragging = false;
  track.addEventListener("pointerdown", (ev) => {
    if (ev.button !== 0) {
      return;
    }
    const state = ring.scrollSnapshot();
    if (!state.overflow) {
      return;
    }
    ev.preventDefault();
    track.setPointerCapture(ev.pointerId);
    dragging = true;
    track.focus();
    ring.setDesired(yToDesired(ev.clientY, state));
  });
  track.addEventListener("pointermove", (ev) => {
    if (!dragging) {
      return;
    }
    ring.setDesired(yToDesired(ev.clientY, ring.scrollSnapshot()));
  });
  const endDrag = (): void => {
    dragging = false;
  };
  track.addEventListener("pointerup", endDrag);
  track.addEventListener("pointercancel", endDrag);

  track.addEventListener("keydown", (ev) => {
    const state = ring.scrollSnapshot();
    if (ev.key === "Home") {
      ev.preventDefault();
      ring.setDesired(0);
      return;
    }
    if (ev.key === "End") {
      ev.preventDefault();
      ring.goToBottom();
      return;
    }
    if (ev.key === "ArrowUp") {
      ev.preventDefault();
      ring.setDesired(state.desired - 1);
      return;
    }
    if (ev.key === "ArrowDown") {
      ev.preventDefault();
      ring.setDesired(state.desired + 1);
      return;
    }
    if (ev.key === "PageUp") {
      ev.preventDefault();
      ring.setDesired(state.desired - state.viewRows);
      return;
    }
    if (ev.key === "PageDown") {
      ev.preventDefault();
      ring.setDesired(state.desired + state.viewRows);
    }
  });
}
