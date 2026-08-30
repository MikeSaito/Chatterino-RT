/**
 * Localized Pixi system-line formatters (CLEARCHAT, CLEARMSG, USERNOTICE, NOTICE).
 * Duration shape matches Chatterino formatTime (d/h/m/s). MIT reimplementation.
 */

import { t } from "../i18n/index.ts";
import type { MentionSpan, UsernoticeParams } from "./types.ts";

export type FormattedSystemLine = {
  text: string;
  mentions: MentionSpan[];
};

/** Chatterino `formatTime`: up to `components` of d/h/m/s. */
export function formatDuration(totalSeconds: number, components = 4): string {
  const secTotal = Math.max(0, Math.floor(totalSeconds));
  if (secTotal === 0 || components <= 0) {
    return "0s";
  }
  let left = components;
  const seconds = secTotal % 60;
  const timeoutMinutes = Math.floor(secTotal / 60);
  const minutes = timeoutMinutes % 60;
  const timeoutHours = Math.floor(timeoutMinutes / 60);
  const hours = timeoutHours % 24;
  const days = Math.floor(timeoutHours / 24);
  const parts: string[] = [];
  if (days > 0 && left > 0) {
    parts.push(`${days}d`);
    left -= 1;
  }
  if (hours > 0 && left > 0) {
    parts.push(`${hours}h`);
    left -= 1;
  }
  if (minutes > 0 && left > 0) {
    parts.push(`${minutes}m`);
    left -= 1;
  }
  if (seconds > 0 && left > 0) {
    parts.push(`${seconds}s`);
  }
  return parts.length > 0 ? parts.join(" ") : "0s";
}

export function formatBitsThreshold(n: number): string {
  return `${Math.floor(n / 1000)}K`;
}

export function clearchatText(
  login: string | undefined,
  durationSec: number | undefined,
  stackCount?: number,
  sourceLogin?: string,
  moderatorLogin?: string,
): string {
  const source = sourceLogin?.trim() || undefined;
  const mod = moderatorLogin?.trim() || undefined;
  let text: string;
  if (!login) {
    text = t("chat.clearchat.room");
  } else if (durationSec !== undefined && source && mod) {
    text = t("chat.clearchat.timeoutSharedMod", {
      mod,
      login,
      duration: formatDuration(durationSec),
      source,
    });
  } else if (durationSec === undefined && source && mod) {
    text = t("chat.clearchat.banSharedMod", { mod, login, source });
  } else if (durationSec !== undefined && source) {
    text = t("chat.clearchat.timeoutShared", {
      login,
      duration: formatDuration(durationSec),
      source,
    });
  } else if (source) {
    text = t("chat.clearchat.banShared", { login, source });
  } else if (durationSec !== undefined) {
    text = t("chat.clearchat.timeout", {
      login,
      duration: formatDuration(durationSec),
    });
  } else {
    text = t("chat.clearchat.ban", { login });
  }
  if (stackCount !== undefined && stackCount > 1) {
    text += t("chat.clearchat.stack", { count: stackCount });
  }
  return text;
}

export function truncationEllipsis(): string {
  return "…";
}

export function truncateDeletedBody(body: string, limit: number): string {
  if (limit <= 0 || body.length <= limit) {
    return body;
  }
  return `${body.slice(0, limit)}${truncationEllipsis()}`;
}

export function deletionNoticeText(
  login: string,
  body: string,
  limit: number,
): string {
  return t("chat.clearmsg.deleted", {
    login,
    body: truncateDeletedBody(body, limit),
  });
}

export function whisperPrefix(): string {
  return t("chat.whisper.prefix");
}

/** Stock/Twitch-style reply chrome above the message (ChatMediumSmall). */
export function formatReplyHeader(login: string, text: string): string {
  const name = login.trim() || t("chat.reply.unknown");
  const body = text.replace(/\s+/g, " ").trim();
  const chars = Array.from(body);
  const snip =
    chars.length > 48 ? `${chars.slice(0, 48).join("").trimEnd()}...` : body;
  if (!snip) {
    return t("chat.reply.headerEmpty", { name });
  }
  return t("chat.reply.header", { name, snip });
}

function pushMention(
  mentions: MentionSpan[],
  text: string,
  display: string,
  login: string,
): void {
  if (!display || !login) {
    return;
  }
  let from = 0;
  while (from < text.length) {
    const at = text.indexOf(display, from);
    if (at < 0) {
      break;
    }
    const end = at + display.length;
    const beforeOk = at === 0 || /\s/.test(text[at - 1]!);
    const afterOk = end >= text.length || /[\s!.,?]/.test(text[end]!);
    if (beforeOk && afterOk) {
      mentions.push({ start: at, end, login: login.toLowerCase() });
    }
    from = end;
  }
}

function multimonthTier(plan: string | undefined): string {
  const n = Math.floor((Number.parseInt(plan ?? "", 10) || 0) / 1000);
  return n > 0 ? String(n) : "1";
}

function giftTierFromPlan(plan: string | undefined): string {
  if (!plan) {
    return "1";
  }
  return plan.charAt(0) || "1";
}

function displayOf(params: UsernoticeParams | undefined, fallbackLogin?: string): string {
  return (
    params?.displayName?.trim() ||
    params?.login?.trim() ||
    fallbackLogin?.trim() ||
    ""
  );
}

/**
 * Build localized USERNOTICE system line + mention spans.
 * Falls back to Twitch `systemText` when no override applies.
 */
export function usernoticeFormatted(opts: {
  systemText: string;
  login?: string;
  msgId?: string;
  params?: UsernoticeParams;
}): FormattedSystemLine {
  const msgId = (opts.msgId ?? "").toLowerCase();
  const p = opts.params;
  const mentions: MentionSpan[] = [];
  let text = opts.systemText;

  if (msgId === "announcement") {
    text = t("chat.usernotice.announcement");
  } else if (msgId === "bitsbadgetier" && p?.bitsThreshold !== undefined) {
    const name = displayOf(p, opts.login);
    text = t("chat.usernotice.bitsBadge", {
      name,
      threshold: formatBitsThreshold(p.bitsThreshold),
    });
    if (name && (p.login || opts.login)) {
      pushMention(mentions, text, name, p.login || opts.login || "");
    }
  } else if (
    (msgId === "sub" || msgId === "resub") &&
    p?.multimonthTenure === 0 &&
    (p.multimonthDuration ?? 0) > 1
  ) {
    const name = displayOf(p, opts.login);
    const tier = multimonthTier(p.plan);
    const months = p.multimonthDuration ?? 0;
    if (msgId === "resub") {
      text = t("chat.usernotice.resubMultimonth", {
        name,
        tier,
        months,
        cumulative: p.cumulativeMonths ?? months,
      });
    } else {
      text = t("chat.usernotice.subMultimonth", { name, tier, months });
    }
    if (name && (p.login || opts.login)) {
      pushMention(mentions, text, name, p.login || opts.login || "");
    }
  } else if (msgId === "subgift" || msgId === "anonsubgift") {
    const giftMonths = p?.giftMonths ?? 0;
    if (giftMonths > 1 && p) {
      const gifter = p.anon
        ? t("chat.usernotice.anonymousGifter")
        : displayOf(p, opts.login);
      const recipient =
        p.recipientDisplayName?.trim() || p.recipientLogin?.trim() || "";
      const tier = giftTierFromPlan(p.plan);
      text = t("chat.usernotice.subgiftMonths", {
        gifter,
        months: giftMonths,
        tier,
        recipient,
      });
      if ((p.senderCount ?? 0) > giftMonths) {
        text += t("chat.usernotice.subgiftSenderTotal", {
          count: p.senderCount ?? 0,
        });
      }
      if (!p.anon && gifter && (p.login || opts.login)) {
        pushMention(mentions, text, gifter, p.login || opts.login || "");
      }
      if (recipient && p.recipientLogin) {
        pushMention(mentions, text, recipient, p.recipientLogin);
      }
    } else if (text) {
      // Stock system-msg with nick mentions.
      const gifter = displayOf(p, opts.login);
      const recipient =
        p?.recipientDisplayName?.trim() || p?.recipientLogin?.trim() || "";
      if (!p?.anon && gifter && (p?.login || opts.login)) {
        pushMention(mentions, text, gifter, p?.login || opts.login || "");
      }
      if (recipient && p?.recipientLogin) {
        pushMention(mentions, text, recipient, p.recipientLogin);
      }
    }
  } else if (
    (msgId === "submysterygift" || msgId === "anonsubmysterygift") &&
    p &&
    (p.massGiftCount ?? 0) > 0
  ) {
    const gifter = p.anon
      ? t("chat.usernotice.anonymousGifter")
      : displayOf(p, opts.login);
    const tier = giftTierFromPlan(p.plan);
    text = t("chat.usernotice.submystery", {
      gifter,
      count: p.massGiftCount ?? 0,
      tier,
    });
    if (!p.anon && gifter && (p.login || opts.login)) {
      pushMention(mentions, text, gifter, p.login || opts.login || "");
    }
  } else if (msgId === "raid") {
    const name =
      p?.raidDisplayName?.trim() ||
      displayOf(p, opts.login) ||
      p?.raidLogin?.trim() ||
      "";
    const viewers = p?.viewerCount;
    if (name && viewers !== undefined) {
      text = t("chat.usernotice.raid", { name, viewers });
    }
    const login = p?.raidLogin || p?.login || opts.login || "";
    if (name && login) {
      pushMention(mentions, text, name, login);
    }
  } else if (msgId === "modiversary" && text) {
    // Twitch often omits the nick from system-msg; Chatterino prefixes displayName.
    const name = displayOf(p, opts.login);
    const login = (p?.login || opts.login || "").toLowerCase();
    if (
      name &&
      !text.toLowerCase().startsWith(name.toLowerCase()) &&
      !(login && text.toLowerCase().startsWith(login))
    ) {
      text = `${name} ${text}`;
    }
    if (name && login) {
      pushMention(mentions, text, name, login);
    }
  } else if (text) {
    const name = displayOf(p, opts.login);
    const login = p?.login || opts.login || "";
    if (name && login) {
      pushMention(mentions, text, name, login);
    }
  }

  return { text, mentions };
}

export function noticeFormatted(opts: {
  text: string;
  msgId?: string;
  timeoutRemainingSec?: number;
}): FormattedSystemLine {
  const msgId = (opts.msgId ?? "").toLowerCase();
  if (msgId === "msg_timedout") {
    const sec = opts.timeoutRemainingSec;
    if (sec !== undefined) {
      return {
        text: t("chat.notice.timedOut", { duration: formatDuration(sec) }),
        mentions: [],
      };
    }
  }
  return { text: opts.text, mentions: [] };
}

export function clearchatFormatted(
  login: string | undefined,
  durationSec: number | undefined,
  stackCount?: number,
  sourceLogin?: string,
  moderatorLogin?: string,
): FormattedSystemLine {
  const text = clearchatText(
    login,
    durationSec,
    stackCount,
    sourceLogin,
    moderatorLogin,
  );
  const mentions: MentionSpan[] = [];
  if (login) {
    pushMention(mentions, text, login, login);
  }
  if (sourceLogin) {
    pushMention(mentions, text, sourceLogin, sourceLogin);
  }
  if (moderatorLogin) {
    pushMention(mentions, text, moderatorLogin, moderatorLogin);
  }
  return { text, mentions };
}
