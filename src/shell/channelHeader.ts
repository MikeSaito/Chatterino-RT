import type { ChannelLive } from "../chat/types";

export type HeaderKnobs = {
  uptime: boolean;
  viewerCount: boolean;
  game: boolean;
  streamTitle: boolean;
};

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

export function formatChannelTitle(
  channel: string,
  stream: ChannelLive | null | undefined,
  knobs: HeaderKnobs,
): string {
  let text = `#${channel}`;
  if (!stream?.live) {
    return text;
  }
  text += " (live)";
  if (knobs.uptime && stream.startedAt) {
    const uptime = formatUptime(stream.startedAt);
    if (uptime) {
      text += ` - ${uptime}`;
    }
  }
  if (knobs.viewerCount && stream.viewerCount != null) {
    text += ` - ${stream.viewerCount.toLocaleString()}`;
  }
  if (knobs.game && stream.gameName) {
    text += ` - ${stream.gameName}`;
  }
  if (knobs.streamTitle && stream.streamTitle) {
    const title = stream.streamTitle.replace(/\s+/g, " ").trim();
    if (title) {
      text += ` - ${title.length > 80 ? `${title.slice(0, 79)}…` : title}`;
    }
  }
  return text;
}
