/** Resolve link titles / Twitch clip cards and push into MessageRing. */

import { invoke } from "@tauri-apps/api/core";
import type { ChatEvent, EmoteSpan, LinkSpan, MentionSpan } from "./types";
import type { MessageRing } from "./ring";
import {
  applyLinkTitlesToBody,
  hostLabelFromUrl,
  isTwitchClipUrl,
  titleFromLinkTooltip,
  type HostSpanRange,
  type LinkTitleSpec,
} from "./linkDisplay";
import { rememberResolvedUrl } from "../shell/emoteTooltip";
import { t } from "../i18n";
import {
  createLinkEnrichmentPump,
  LINK_ENRICH_MAX_INFLIGHT,
} from "./linkEnrichmentPump";

export { LINK_ENRICH_MAX_INFLIGHT } from "./linkEnrichmentPump";

export type ClipCardInfo = {
  clipId: string;
  url: string;
  title: string;
  host: string;
  thumbnailUrl: string | null;
  durationSec: number;
  viewCount: number;
  creatorName: string;
  broadcasterName: string;
  gameName: string | null;
  createdAt: string | null;
};

type LinkInfoResponse = {
  tooltip: string;
  thumbnail_url?: string | null;
  resolved_url?: string | null;
};

type ClipInfoResponse = {
  clipId: string;
  url: string;
  title: string;
  host: string;
  thumbnailUrl?: string | null;
  durationSec: number;
  viewCount: number;
  creatorName: string;
  broadcasterName: string;
  gameName?: string | null;
  createdAt?: string | null;
};

/** Minimal ring surface for enrichment (MessageRing satisfies this). */
export type LinkEnrichmentRing = {
  peekLinkEnrichment(msgId: string): {
    bodySource: string;
    links: LinkSpan[];
    spans: EmoteSpan[];
    mentions: MentionSpan[];
  } | null;
  applyLinkEnrichment(
    msgId: string,
    payload: {
      body: string;
      links: LinkSpan[];
      hosts: HostSpanRange[];
      spans: EmoteSpan[];
      mentions: MentionSpan[];
      clip: ClipCardInfo | null;
    },
  ): void;
};

export type LinkEnrichmentIo = {
  resolveTitle: (url: string) => Promise<LinkTitleSpec | null>;
  resolveClip: (url: string) => Promise<ClipCardInfo | null>;
};

const titleCache = new Map<string, LinkTitleSpec>();
const clipCache = new Map<string, ClipCardInfo>();
const clipInflight = new Map<string, Promise<ClipCardInfo | null>>();
const TITLE_CACHE_LIMIT = 200;

function rememberTitle(spec: LinkTitleSpec): void {
  if (titleCache.has(spec.url)) {
    titleCache.delete(spec.url);
  }
  titleCache.set(spec.url, spec);
  while (titleCache.size > TITLE_CACHE_LIMIT) {
    const oldest = titleCache.keys().next().value;
    if (oldest === undefined) {
      break;
    }
    titleCache.delete(oldest);
  }
}

async function resolveTitle(url: string): Promise<LinkTitleSpec | null> {
  const hit = titleCache.get(url);
  if (hit) {
    return hit;
  }
  if (isTwitchClipUrl(url)) {
    const clip = await resolveClip(url);
    if (clip) {
      const spec: LinkTitleSpec = {
        url,
        title: clip.title,
        host: clip.host || "clip.twitch.tv",
      };
      rememberTitle(spec);
      return spec;
    }
  }
  try {
    const info = await invoke<LinkInfoResponse>("resolve_link_info", { url });
    const resolved = info.resolved_url?.trim();
    if (resolved) {
      rememberResolvedUrl(url, resolved);
    }
    const host = hostLabelFromUrl(resolved || url);
    const title = titleFromLinkTooltip(info.tooltip ?? "", host);
    if (!title) {
      return null;
    }
    const spec: LinkTitleSpec = { url, title, host };
    rememberTitle(spec);
    return spec;
  } catch {
    return null;
  }
}

async function resolveClip(url: string): Promise<ClipCardInfo | null> {
  const cached = clipCache.get(url);
  if (cached) {
    return cached;
  }
  const pending = clipInflight.get(url);
  if (pending) {
    return pending;
  }
  const job = (async (): Promise<ClipCardInfo | null> => {
    try {
      const info = await invoke<ClipInfoResponse>("resolve_clip_info", { url });
      const card: ClipCardInfo = {
        clipId: info.clipId,
        url: info.url || url,
        title: info.title,
        host: info.host || "clip.twitch.tv",
        thumbnailUrl: info.thumbnailUrl ?? null,
        durationSec: info.durationSec,
        viewCount: info.viewCount,
        creatorName: info.creatorName,
        broadcasterName: info.broadcasterName,
        gameName: info.gameName ?? null,
        createdAt: info.createdAt ?? null,
      };
      clipCache.set(url, card);
      while (clipCache.size > TITLE_CACHE_LIMIT) {
        const oldest = clipCache.keys().next().value;
        if (oldest === undefined) {
          break;
        }
        clipCache.delete(oldest);
      }
      return card;
    } catch {
      return null;
    } finally {
      clipInflight.delete(url);
    }
  })();
  clipInflight.set(url, job);
  return job;
}

function eventHasLinks(event: ChatEvent): string | null {
  // Clip/title cards only for plain privmsg (system clouds skip clipCardRows).
  if (event.kind === "privmsg") {
    if ((event.linkSpans?.length ?? 0) > 0) {
      return event.id;
    }
  }
  return null;
}

const defaultIo: LinkEnrichmentIo = {
  resolveTitle,
  resolveClip,
};

export function bindLinkEnrichment(
  ring: LinkEnrichmentRing | MessageRing,
  io: LinkEnrichmentIo = defaultIo,
): {
  afterBatch: (events: ChatEvent[]) => void;
  stop: () => void;
  pendingCount: () => number;
  inflightCount: () => number;
} {
  const enrichOne = async (
    msgId: string,
    isCurrent: () => boolean,
  ): Promise<void> => {
    const target = ring.peekLinkEnrichment(msgId);
    if (!target || target.links.length === 0) {
      return;
    }
    const titles: LinkTitleSpec[] = [];
    let clip: ClipCardInfo | null = null;
    await Promise.all(
      target.links.map(async (link) => {
        const spec = await io.resolveTitle(link.url);
        if (spec) {
          titles.push(spec);
        }
      }),
    );
    for (const link of target.links) {
      if (isTwitchClipUrl(link.url)) {
        clip = await io.resolveClip(link.url);
        if (clip) {
          break;
        }
      }
    }
    if (!isCurrent()) {
      return;
    }
    // Re-read after await: channel reset / already enriched / body rewritten.
    const latest = ring.peekLinkEnrichment(msgId);
    if (!latest) {
      return;
    }
    if (titles.length === 0 && !clip) {
      return;
    }
    if (titles.length === 0) {
      ring.applyLinkEnrichment(msgId, {
        body: latest.bodySource,
        links: latest.links,
        hosts: [],
        spans: latest.spans,
        mentions: latest.mentions,
        clip,
      });
      return;
    }
    const remap = [
      ...latest.spans.map((s) => ({ start: s.start, end: s.end })),
      ...latest.mentions.map((s) => ({ start: s.start, end: s.end })),
    ];
    const applied = applyLinkTitlesToBody(
      latest.bodySource,
      latest.links,
      titles,
      remap,
    );
    const spanCount = latest.spans.length;
    const spans = latest.spans.map((s, i) => ({
      ...s,
      start: remap[i].start,
      end: remap[i].end,
    }));
    const mentions = latest.mentions.map((s, i) => ({
      ...s,
      start: remap[spanCount + i].start,
      end: remap[spanCount + i].end,
    }));
    ring.applyLinkEnrichment(msgId, {
      body: applied.body,
      links: applied.links,
      hosts: applied.hosts,
      spans,
      mentions,
      clip,
    });
  };

  const pump = createLinkEnrichmentPump({
    maxInflight: LINK_ENRICH_MAX_INFLIGHT,
    isEligible: (id) => ring.peekLinkEnrichment(id) !== null,
    enrich: enrichOne,
  });

  return {
    afterBatch: (events) => {
      const ids: string[] = [];
      for (const event of events) {
        const id = eventHasLinks(event);
        if (id) {
          ids.push(id);
        }
      }
      pump.afterIds(ids);
    },
    stop: () => {
      pump.stop();
    },
    pendingCount: () => pump.pendingCount(),
    inflightCount: () => pump.inflightCount(),
  };
}

export function formatClipDuration(sec: number): string {
  const n = Math.max(0, Math.round(sec));
  const m = Math.floor(n / 60);
  const s = n % 60;
  return `${m}:${s.toString().padStart(2, "0")}`;
}

export function formatClipViews(count: number): string {
  return t("clipCard.views", { count: count.toLocaleString() });
}

export function formatClipAge(iso: string | null | undefined): string {
  if (!iso) {
    return t("clipCard.justNow");
  }
  const ts = Date.parse(iso);
  if (!Number.isFinite(ts)) {
    return t("clipCard.justNow");
  }
  const diff = Math.max(0, Date.now() - ts);
  const sec = Math.floor(diff / 1000);
  if (sec < 90) {
    return t("clipCard.justNow");
  }
  const min = Math.floor(sec / 60);
  if (min < 60) {
    return t("clipCard.minutesAgo", { count: min });
  }
  const hours = Math.floor(min / 60);
  if (hours < 48) {
    return t("clipCard.hoursAgo", { count: hours });
  }
  const days = Math.floor(hours / 24);
  return t("clipCard.daysAgo", { count: days });
}
