export function mountPlayer(host: HTMLElement, channel: string): HTMLIFrameElement {
  unmountPlayer(host);
  const frame = document.createElement("iframe");
  frame.title = "Twitch player";
  frame.allow = "autoplay; encrypted-media; picture-in-picture";
  frame.allowFullscreen = true;
  const parent = window.location.hostname || "localhost";
  const params = new URLSearchParams({
    channel,
    parent,
    muted: "true",
  });
  frame.src = `https://player.twitch.tv/?${params.toString()}`;
  host.appendChild(frame);
  return frame;
}

export function unmountPlayer(host: HTMLElement): void {
  const frames = host.querySelectorAll("iframe");
  for (const frame of frames) {
    frame.remove();
  }
  host.replaceChildren();
}
