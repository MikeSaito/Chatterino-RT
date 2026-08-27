import type { ChannelLive } from "../chat/types";

export type HeaderKnobs = {
  uptime: boolean;
  viewerCount: boolean;
  game: boolean;
  streamTitle: boolean;
};

/** Stock `thumbnailSizeStream`: 0 Off, 1 Small, 2 Medium, 3 Large. */
export type ThumbnailSizeStream = 0 | 1 | 2 | 3;

const STREAM_PREVIEW_SUFFIX: Record<1 | 2 | 3, string> = {
  1: "80x45",
  2: "160x90",
  3: "360x203",
};

const STREAM_PREVIEW_PX: Record<1 | 2 | 3, { w: number; h: number }> = {
  1: { w: 80, h: 45 },
  2: { w: 160, h: 90 },
  3: { w: 360, h: 203 },
};

const CURSOR_OFFSET = 12;
const VIEWPORT_PAD = 4;

export function parseThumbnailSizeStream(raw: unknown): ThumbnailSizeStream {
  const n = typeof raw === "number" ? raw : Number(raw);
  if (n === 0 || n === 1 || n === 2 || n === 3) {
    return n;
  }
  return 2;
}

/** Twitch CDN live preview URL; null when Off or invalid login. */
export function streamPreviewUrl(
  login: string,
  size: ThumbnailSizeStream,
): string | null {
  if (size === 0) {
    return null;
  }
  const name = login.trim().toLowerCase();
  if (!/^[a-z0-9_]{1,25}$/.test(name)) {
    return null;
  }
  return `https://static-cdn.jtvnw.net/previews-ttv/live_user_${name}-${STREAM_PREVIEW_SUFFIX[size]}.jpg`;
}

export function bindStreamPreviewTooltip(opts: {
  titleEl: HTMLElement;
  tooltip: HTMLElement;
  img: HTMLImageElement;
  text: HTMLElement;
  getSize: () => ThumbnailSizeStream;
  /** Active channel login + live meta for caption; null when no channel. */
  getStream: () => {
    login: string;
    live: boolean;
    gameName?: string;
    streamTitle?: string;
  } | null;
}): { hide: () => void; refresh: () => void } {
  let hovering = false;
  let lastUrl = "";
  let failedUrl = "";
  let lastClientX = 0;
  let lastClientY = 0;

  const hide = (): void => {
    opts.tooltip.hidden = true;
    opts.img.hidden = true;
    opts.img.removeAttribute("src");
    lastUrl = "";
    failedUrl = "";
    opts.text.textContent = "";
  };

  const positionTooltip = (clientX: number, clientY: number): void => {
    const tip = opts.tooltip;
    const tipW = tip.offsetWidth;
    const tipH = tip.offsetHeight;
    let left = clientX + CURSOR_OFFSET;
    let top = clientY + CURSOR_OFFSET;
    const maxLeft = Math.max(VIEWPORT_PAD, window.innerWidth - tipW - VIEWPORT_PAD);
    const maxTop = Math.max(VIEWPORT_PAD, window.innerHeight - tipH - VIEWPORT_PAD);
    left = Math.min(Math.max(VIEWPORT_PAD, left), maxLeft);
    top = Math.min(Math.max(VIEWPORT_PAD, top), maxTop);
    tip.style.left = `${left}px`;
    tip.style.top = `${top}px`;
  };

  const captionFor = (stream: {
    gameName?: string;
    streamTitle?: string;
  }): string => {
    const parts: string[] = [];
    const title = stream.streamTitle?.replace(/\s+/g, " ").trim();
    if (title) {
      parts.push(title.length > 80 ? `${title.slice(0, 79)}…` : title);
    }
    if (stream.gameName) {
      parts.push(stream.gameName);
    }
    return parts.join("\n");
  };

  const paint = (clientX: number, clientY: number): void => {
    lastClientX = clientX;
    lastClientY = clientY;
    if (!hovering) {
      return;
    }
    const size = opts.getSize();
    const stream = opts.getStream();
    if (!stream?.live || size === 0) {
      hide();
      return;
    }
    const url = streamPreviewUrl(stream.login, size);
    if (!url) {
      hide();
      return;
    }
    const dims = STREAM_PREVIEW_PX[size];
    opts.img.style.width = `${dims.w}px`;
    opts.img.style.height = `${dims.h}px`;
    const caption = captionFor(stream);
    if (url === failedUrl) {
      opts.img.hidden = true;
      opts.text.textContent = caption
        ? `Couldn't fetch thumbnail\n${caption}`
        : "Couldn't fetch thumbnail";
      opts.tooltip.hidden = false;
      positionTooltip(clientX, clientY);
      return;
    }
    opts.text.textContent = caption;
    if (url !== lastUrl) {
      failedUrl = "";
      opts.img.hidden = false;
      opts.img.src = url;
      lastUrl = url;
    }
    opts.tooltip.hidden = false;
    positionTooltip(clientX, clientY);
  };

  const refresh = (): void => {
    if (!hovering) {
      return;
    }
    paint(lastClientX, lastClientY);
  };

  opts.img.addEventListener("error", () => {
    if (!hovering || !lastUrl || lastUrl === failedUrl) {
      return;
    }
    failedUrl = lastUrl;
    opts.img.hidden = true;
    const prior = opts.text.textContent?.trim() ?? "";
    const withoutErr = prior.replace(/^Couldn't fetch thumbnail\n?/, "");
    opts.text.textContent = withoutErr
      ? `Couldn't fetch thumbnail\n${withoutErr}`
      : "Couldn't fetch thumbnail";
    opts.tooltip.hidden = false;
    positionTooltip(lastClientX, lastClientY);
  });

  opts.titleEl.addEventListener("mouseenter", (ev) => {
    hovering = true;
    paint(ev.clientX, ev.clientY);
  });
  opts.titleEl.addEventListener("mousemove", (ev) => {
    if (!hovering) {
      return;
    }
    paint(ev.clientX, ev.clientY);
  });
  opts.titleEl.addEventListener("mouseleave", () => {
    hovering = false;
    hide();
  });

  return { hide, refresh };
}

export function parseHeaderKnobs(knobs: Record<string, unknown>): HeaderKnobs {
  return {
    uptime: knobs["appearance.headerUptime"] === true,
    viewerCount: knobs["appearance.headerViewerCount"] === true,
    game: knobs["appearance.headerGame"] === true,
    streamTitle: knobs["appearance.headerStreamTitle"] === true,
  };
}

/** Stock SplitHeader: hide uptime/viewers while streamer mode + knob. */
export function effectiveHeaderKnobs(
  appearance: HeaderKnobs,
  opts: { streamerActive: boolean; hideViewerCountAndDuration: boolean },
): HeaderKnobs {
  if (!(opts.streamerActive && opts.hideViewerCountAndDuration)) {
    return appearance;
  }
  return {
    ...appearance,
    uptime: false,
    viewerCount: false,
  };
}

function formatUptime(startedAt: string): string {
  const since = Date.parse(startedAt);
  if (!Number.isFinite(since)) {
    return "";
  }
  const diffSec = Math.max(0, Math.floor((Date.now() - since) / 1000));
  const hours = Math.floor(diffSec / 3600);
  const minutes = Math.floor((diffSec % 3600) / 60);
  return `${hours}h ${minutes}m`;
}

export type ChannelMetaParts = {
  uptime?: string;
  viewers?: string;
  game?: string;
  streamTitle?: string;
};

export function channelMetaParts(
  channel: string,
  stream: ChannelLive | null | undefined,
  knobs: HeaderKnobs,
): ChannelMetaParts {
  void channel;
  if (!stream?.live) {
    return {};
  }
  const parts: ChannelMetaParts = {};
  if (knobs.uptime && stream.startedAt) {
    const uptime = formatUptime(stream.startedAt);
    if (uptime) {
      parts.uptime = uptime;
    }
  }
  if (knobs.viewerCount && stream.viewerCount != null) {
    parts.viewers = stream.viewerCount.toLocaleString();
  }
  if (knobs.game && stream.gameName) {
    parts.game = stream.gameName;
  }
  if (knobs.streamTitle && stream.streamTitle) {
    const title = stream.streamTitle.replace(/\s+/g, " ").trim();
    if (title) {
      parts.streamTitle = title.length > 80 ? `${title.slice(0, 79)}…` : title;
    }
  }
  return parts;
}

export function formatChannelTitle(
  channel: string,
  stream: ChannelLive | null | undefined,
  knobs: HeaderKnobs,
): string {
  const parts = channelMetaParts(channel, stream, knobs);
  return [parts.uptime, parts.viewers, parts.game, parts.streamTitle]
    .filter((p): p is string => Boolean(p))
    .join(" · ");
}
