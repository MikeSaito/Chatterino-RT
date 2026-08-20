let playerEpoch = 0;
let slotWaitCleanup: (() => void) | null = null;

export function mountPlayer(host: HTMLElement, channel: string): HTMLIFrameElement {
  unmountPlayer(host);
  const epoch = ++playerEpoch;
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

  const isLive = () => epoch === playerEpoch && frame.isConnected;

  host.appendChild(frame);
  whenSlotReady(host, isLive, () => {
    if (!isLive() || frame.getAttribute("src")) {
      return;
    }
    const box = host.getBoundingClientRect();
    frame.width = String(Math.floor(box.width));
    frame.height = String(Math.floor(box.height));
    frame.src = `https://player.twitch.tv/?${params.toString()}`;
  });
  return frame;
}

export function unmountPlayer(host: HTMLElement): void {
  playerEpoch += 1;
  slotWaitCleanup?.();
  slotWaitCleanup = null;
  const frames = host.querySelectorAll("iframe");
  for (const frame of frames) {
    frame.remove();
  }
  host.replaceChildren();
}

function whenSlotReady(host: HTMLElement, isLive: () => boolean, run: () => void): void {
  slotWaitCleanup?.();
  let done = false;
  let raf = 0;
  const observer = new ResizeObserver(() => {
    kick();
  });

  const cleanup = () => {
    observer.disconnect();
    if (raf !== 0) {
      cancelAnimationFrame(raf);
      raf = 0;
    }
    if (slotWaitCleanup === cleanup) {
      slotWaitCleanup = null;
    }
  };

  const kick = () => {
    if (done) {
      return;
    }
    if (!isLive()) {
      done = true;
      cleanup();
      return;
    }
    const box = host.getBoundingClientRect();
    if (box.width < 400 || box.height < 300) {
      return;
    }
    done = true;
    cleanup();
    run();
  };

  slotWaitCleanup = cleanup;
  observer.observe(host);
  raf = requestAnimationFrame(() => {
    raf = 0;
    kick();
  });
}
