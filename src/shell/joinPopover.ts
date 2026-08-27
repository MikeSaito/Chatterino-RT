/** Compact join control for Classic narrow chrome. */

export function bindJoinPopover(opts: {
  form: HTMLFormElement;
  toggle: HTMLButtonElement;
  popover: HTMLElement;
  popoverForm: HTMLFormElement;
  popoverInput: HTMLInputElement;
  isCompact: () => boolean;
  onJoin: (channel: string) => void;
}): { sync: () => void; hide: () => void; dispose: () => void } {
  const { form, toggle, popover, popoverForm, popoverInput, isCompact, onJoin } =
    opts;
  let disposed = false;

  const hide = (): void => {
    popover.hidden = true;
    toggle.setAttribute("aria-expanded", "false");
  };

  const show = (): void => {
    if (!isCompact()) {
      return;
    }
    popover.hidden = false;
    toggle.setAttribute("aria-expanded", "true");
    const rect = toggle.getBoundingClientRect();
    const pad = 8;
    popover.style.left = `${Math.max(pad, Math.min(rect.left, window.innerWidth - 220 - pad))}px`;
    popover.style.top = `${rect.bottom + 4}px`;
    popoverInput.value = "";
    popoverInput.focus();
  };

  const sync = (): void => {
    if (disposed) {
      return;
    }
    const compact = isCompact();
    form.hidden = compact;
    toggle.hidden = !compact;
    if (!compact) {
      hide();
    }
  };

  const onToggleClick = (ev: MouseEvent): void => {
    ev.stopPropagation();
    if (popover.hidden) {
      show();
    } else {
      hide();
    }
  };

  const onPopoverSubmit = (ev: Event): void => {
    ev.preventDefault();
    const channel = popoverInput.value.trim();
    hide();
    if (channel) {
      onJoin(channel);
    }
  };

  const onPointerDown = (ev: PointerEvent): void => {
    if (popover.hidden) {
      return;
    }
    const t = ev.target;
    if (!(t instanceof Node)) {
      return;
    }
    if (popover.contains(t) || toggle.contains(t)) {
      return;
    }
    hide();
  };

  const onKeyDown = (ev: KeyboardEvent): void => {
    if (ev.key === "Escape" && !popover.hidden) {
      hide();
    }
  };

  const onResize = (): void => {
    sync();
  };

  toggle.addEventListener("click", onToggleClick);
  popoverForm.addEventListener("submit", onPopoverSubmit);
  document.addEventListener("pointerdown", onPointerDown, true);
  document.addEventListener("keydown", onKeyDown);
  window.addEventListener("resize", onResize);
  sync();

  return {
    sync,
    hide,
    dispose: () => {
      if (disposed) {
        return;
      }
      disposed = true;
      hide();
      toggle.removeEventListener("click", onToggleClick);
      popoverForm.removeEventListener("submit", onPopoverSubmit);
      document.removeEventListener("pointerdown", onPointerDown, true);
      document.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("resize", onResize);
    },
  };
}
