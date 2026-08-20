const observers = new WeakMap<HTMLElement, ResizeObserver>();

export function mountPlayer(host: HTMLElement, channel: string): HTMLIFrameElement {
  unmountPlayer(host);
  const frame = document.createElement("iframe");
  frame.title = "Twitch player";
  frame.allow =
    "autoplay; encrypted-media; picture-in-picture; storage-access; accelerometer; gyroscope";
  frame.allowFullscreen = true;
  frame.setAttribute("allowfullscreen", "");
  const parent = window.location.hostname || "localhost";
  const params = new URLSearchParams({
    channel,
    parent,
    muted: "true",
    autoplay: "true",
  });

  const applySize = () => {
    const box = host.getBoundingClientRect();
    const w = Math.max(400, Math.floor(box.width));
    const h = Math.max(300, Math.floor(box.height));
    frame.width = String(w);
    frame.height = String(h);
  };

  host.appendChild(frame);
  applySize();
  const ro = new ResizeObserver(() => applySize());
  ro.observe(host);
  observers.set(host, ro);

  const start = () => {
    applySize();
    if (!frame.isConnected || frame.src) {
      return;
    }
    frame.src = `https://player.twitch.tv/?${params.toString()}`;
  };

  whenSlotReady(host, start);
  return frame;
}

export function unmountPlayer(host: HTMLElement): void {
  const ro = observers.get(host);
  if (ro) {
    ro.disconnect();
    observers.delete(host);
  }
  const frames = host.querySelectorAll("iframe");
  for (const frame of frames) {
    frame.remove();
  }
  host.replaceChildren();
}

function whenSlotReady(host: HTMLElement, run: () => void): void {
  let frames = 0;
  const tick = () => {
    const box = host.getBoundingClientRect();
    if ((box.width >= 400 && box.height >= 300) || frames >= 16) {
      run();
      return;
    }
    frames += 1;
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
}
