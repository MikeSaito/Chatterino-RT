/** Resolve link titles / Twitch clip cards and push into MessageRing. */

import { invoke } from "@tauri-apps/api/core";
import type { ChatEvent } from "./types";
import type { MessageRing } from "./ring";
import {
  applyLinkTitlesToBody,
  hostLabelFromUrl,
  isTwitchClipUrl,
  titleFromLinkTooltip,
  type LinkTitleSpec,
} from "./linkDisplay";
import { rememberResolvedUrl } from "../shell/emoteTooltip";
import { t } from "../i18n";

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

const titleCache = new Map<string, LinkTitleSpec>();
const clipCache = new Map<string, ClipCardInfo>();
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
  }
}

function eventHasLinks(event: ChatEvent): string | null {
  if (event.kind === "privmsg") {
    if ((event.linkSpans?.length ?? 0) > 0) {
      return event.id;
    }
    return null;
  }
  if (event.kind === "usernotice" && event.privmsg?.kind === "privmsg") {
    if ((event.privmsg.linkSpans?.length ?? 0) > 0) {
      return event.privmsg.id;
    }
  }
  return null;
}

export function bindLinkEnrichment(
  ring: MessageRing,
): {
  afterBatch: (events: ChatEvent[]) => void;
  stop: () => void;
} {
  let generation = 0;

  const enrichOne = async (msgId: string, gen: number): Promise<void> => {
    const target = ring.peekLinkEnrichment(msgId);
    if (!target || target.links.length === 0) {
      return;
    }
    const titles: LinkTitleSpec[] = [];
    let clip: ClipCardInfo | null = null;
    await Promise.all(
      target.links.map(async (link) => {
        const spec = await resolveTitle(link.url);
        if (spec) {
          titles.push(spec);
        }
        if (!clip && isTwitchClipUrl(link.url)) {
          clip = await resolveClip(link.url);
        }
      }),
    );
    if (gen !== generation) {
      return;
    }
    if (titles.length === 0 && !clip) {
      return;
    }
    if (titles.length === 0) {
      ring.applyLinkEnrichment(msgId, {
        body: target.bodySource,
        links: target.links,
        hosts: [],
        spans: target.spans,
        mentions: target.mentions,
        clip,
      });
      return;
    }
    const remap = [
      ...target.spans.map((s) => ({ start: s.start, end: s.end })),
      ...target.mentions.map((s) => ({ start: s.start, end: s.end })),
    ];
    const applied = applyLinkTitlesToBody(
      target.bodySource,
      target.links,
      titles,
      remap,
    );
    const spanCount = target.spans.length;
    const spans = target.spans.map((s, i) => ({
      ...s,
      start: remap[i].start,
      end: remap[i].end,
    }));
    const mentions = target.mentions.map((s, i) => ({
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

  return {
    afterBatch: (events) => {
      const gen = generation;
      const seen = new Set<string>();
      for (const event of events) {
        const id = eventHasLinks(event);
        if (!id || seen.has(id)) {
          continue;
        }
        seen.add(id);
        void enrichOne(id, gen);
      }
    },
    stop: () => {
      generation += 1;
    },
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
