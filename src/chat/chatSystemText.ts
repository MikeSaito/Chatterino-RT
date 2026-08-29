/** Localized Pixi system-line formatters (CLEARCHAT, CLEARMSG, reply, whisper). */

import { t } from "../i18n/index.ts";

export function clearchatText(
  login: string | undefined,
  durationSec: number | undefined,
  stackCount?: number,
): string {
  let text: string;
  if (!login) {
    text = t("chat.clearchat.room");
  } else if (durationSec !== undefined) {
    text = t("chat.clearchat.timeout", {
      login,
      seconds: durationSec,
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
