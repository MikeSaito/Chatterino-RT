/** Horizontal tab strip: wheel-scroll + edge fade markers. */

export function bindTabOverflow(opts: {
  list: HTMLElement;
  host: HTMLElement;
}): { refresh: () => void; dispose: () => void } {
  const { list, host } = opts;
  let disposed = false;

  const refresh = (): void => {
    if (disposed) {
      return;
    }
    const max = Math.max(0, list.scrollWidth - list.clientWidth);
    const left = list.scrollLeft;
    host.classList.toggle("has-overflow-start", left > 1);
    host.classList.toggle("has-overflow-end", max > 1 && left < max - 1);
  };

  const onWheel = (ev: WheelEvent): void => {
    if (disposed) {
      return;
    }
    if (Math.abs(ev.deltaY) < Math.abs(ev.deltaX)) {
      return;
    }
    if (list.scrollWidth <= list.clientWidth + 1) {
      return;
    }
    ev.preventDefault();
    list.scrollLeft += ev.deltaY;
    refresh();
  };

  const onScroll = (): void => {
    refresh();
  };

  list.addEventListener("wheel", onWheel, { passive: false });
  list.addEventListener("scroll", onScroll, { passive: true });

  const ro = new ResizeObserver(() => {
    refresh();
  });
  ro.observe(list);
  ro.observe(host);

  const mo = new MutationObserver(() => {
    refresh();
  });
  mo.observe(list, { childList: true, subtree: true });

  refresh();

  return {
    refresh,
    dispose: () => {
      if (disposed) {
        return;
      }
      disposed = true;
      list.removeEventListener("wheel", onWheel);
      list.removeEventListener("scroll", onScroll);
      ro.disconnect();
      mo.disconnect();
      host.classList.remove("has-overflow-start", "has-overflow-end");
    },
  };
}
