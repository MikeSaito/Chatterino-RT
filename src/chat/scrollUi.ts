import type { MessageRing } from "./ring";
import type { ScrollSnapshot } from "./scroll";

export function bindScrollChrome(opts: {
  ring: MessageRing;
  host: HTMLElement;
  track: HTMLElement;
  thumb: HTMLElement;
  jump: HTMLButtonElement;
  onScroll?: (state: ScrollSnapshot) => void;
}): {
  setHideHighlights: (hide: boolean) => void;
} {
  const { ring, host, track, thumb, jump, onScroll } = opts;
  const marksLayer = track.querySelector<HTMLElement>("#chat-scroll-marks");
  let hideHighlights = false;
  let marksGen = -1;
  let marksTrackH = -1;

  const paint = (state: ScrollSnapshot): void => {
    track.classList.toggle("idle", !state.overflow);
    track.setAttribute("aria-valuemin", "0");
    track.setAttribute("aria-valuemax", String(state.bottom));
    track.setAttribute("aria-valuenow", String(state.current));
    jump.hidden = state.atBottom;
    layoutThumb(state);
    paintMarks(state);
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
    const t = state.bottom <= 0 ? 1 : state.current / state.bottom;
    thumb.style.height = `${thumbH}px`;
    thumb.style.transform = `translateY(${t * travel}px)`;
  };

  const clearMarks = (): void => {
    marksGen = -1;
    marksTrackH = -1;
    marksLayer?.replaceChildren();
  };

  const paintMarks = (state: ScrollSnapshot): void => {
    if (!marksLayer) {
      return;
    }
    if (hideHighlights || !state.overflow) {
      clearMarks();
      return;
    }
    const trackH = track.clientHeight;
    const trackW = track.clientWidth;
    if (trackH <= 0 || trackW <= 0) {
      clearMarks();
      return;
    }
    const gen = ring.highlightMarksGeneration();
    if (gen === marksGen && trackH === marksTrackH) {
      return;
    }
    const colors = ring.highlightMarks();
    const n = colors.length;
    if (n === 0) {
      clearMarks();
      return;
    }
    marksGen = gen;
    marksTrackH = trackH;
    const markH = Math.max(2, Math.ceil(trackH / n));
    const markW = Math.max(2, Math.floor(trackW / 4));
    const left = Math.max(0, Math.floor((trackW - markW) / 2));
    const needed: HTMLElement[] = [];
    for (let i = 0; i < n; i += 1) {
      const color = colors[i]?.trim() ?? "";
      if (!color || !isScrollbarMarkColor(color)) {
        continue;
      }
      const el = document.createElement("div");
      el.className = "chat-scroll-mark";
      el.style.left = `${left}px`;
      el.style.width = `${markW}px`;
      el.style.top = `${(i / n) * trackH}px`;
      el.style.height = `${markH}px`;
      el.style.backgroundColor = color;
      needed.push(el);
    }
    marksLayer.replaceChildren(...needed);
  };

  const setHideHighlights = (hide: boolean): void => {
    hideHighlights = hide;
    track.classList.toggle("is-hidden-marks", hide);
    if (hide) {
      clearMarks();
    } else {
      paintMarks(ring.scrollSnapshot());
    }
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
    const anim = ring.isSmoothScrolling();
    if (ev.key === "Home") {
      ev.preventDefault();
      ring.setDesired(0, anim);
      return;
    }
    if (ev.key === "End") {
      ev.preventDefault();
      ring.goToBottom();
      return;
    }
    if (ev.key === "ArrowUp") {
      ev.preventDefault();
      ring.setDesired(state.desired - 1, anim);
      return;
    }
    if (ev.key === "ArrowDown") {
      ev.preventDefault();
      ring.setDesired(state.desired + 1, anim);
      return;
    }
    if (ev.key === "PageUp") {
      ev.preventDefault();
      ring.setDesired(state.desired - state.viewRows, anim);
      return;
    }
    if (ev.key === "PageDown") {
      ev.preventDefault();
      ring.setDesired(state.desired + state.viewRows, anim);
    }
  });

  return { setHideHighlights };
}

/** Accept same #RRGGBB / #RRGGBBAA as ring row highlights. */
export function isScrollbarMarkColor(raw: string): boolean {
  return /^#[0-9a-fA-F]{6}([0-9a-fA-F]{2})?$/.test(raw);
}
