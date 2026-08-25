/** Stock Chatterino ModerationAction patterns for message-row buttons. */

export type ModActionBtn = {
  action: string;
  label: string;
};

export type ModActionExpandCtx = {
  userName: string;
  msgId: string;
  channel: string;
};

const MAX_ACTIONS = 8;
const MAX_ACTION_CHARS = 500;

const TIMEOUT_RE = /^[./]timeout\b.*\s(\d+)([mhdw]?)\s*$/i;

const MINUTE = 60;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const WEEK = 7 * DAY;

/** Label for a moderation action pattern (stock ModerationAction). */
export function modActionLabel(action: string): string {
  const trimmed = action.trim();
  const timeout = TIMEOUT_RE.exec(trimmed);
  if (timeout) {
    let amount = Number.parseInt(timeout[1]!, 10);
    const unit = (timeout[2] ?? "").toLowerCase();
    if (unit === "m") {
      amount *= MINUTE;
    } else if (unit === "h") {
      amount *= HOUR;
    } else if (unit === "d") {
      amount *= DAY;
    } else if (unit === "w") {
      amount *= WEEK;
    }
    if (amount < MINUTE) {
      return `${amount}s`;
    }
    if (amount < HOUR) {
      return `${Math.floor(amount / MINUTE)}m`;
    }
    if (amount < DAY) {
      return `${Math.floor(amount / HOUR)}h`;
    }
    if (amount < WEEK) {
      return `${Math.floor(amount / DAY)}d`;
    }
    if (amount > 2 * WEEK) {
      return ">2w";
    }
    return `${Math.floor(amount / WEEK)}w`;
  }
  const lower = trimmed.toLowerCase();
  if (lower.startsWith("/ban ") || lower === "/ban") {
    return "Ban";
  }
  if (lower.startsWith("/delete ") || lower === "/delete") {
    return "Del";
  }
  const alnum = trimmed.replace(/[!/.]/g, "").replace(/[^a-zA-Z0-9]/g, "");
  const chunk = alnum.slice(0, 4);
  return chunk || "…";
}

export function parseModActions(
  rows: ReadonlyArray<Record<string, string | boolean | number | null | undefined>>,
): ModActionBtn[] {
  const out: ModActionBtn[] = [];
  for (const row of rows) {
    if (out.length >= MAX_ACTIONS) {
      break;
    }
    const raw = typeof row.action === "string" ? row.action.trim() : "";
    if (!raw || raw.length > MAX_ACTION_CHARS) {
      continue;
    }
    out.push({ action: raw, label: modActionLabel(raw) });
  }
  return out;
}

const PLACEHOLDER_RE =
  /\{(user\.name|user|msg\.id|msg-id|channel\.name|channel)\}/gi;

/** Expand stock placeholders used by moderation button patterns. */
export function expandModAction(
  action: string,
  ctx: ModActionExpandCtx,
): string | null {
  const template = action.trim();
  if (!template || template.length > MAX_ACTION_CHARS) {
    return null;
  }
  const user = sanitizeToken(ctx.userName, 25);
  const msgId = sanitizeToken(ctx.msgId, 64);
  const channel = sanitizeToken(ctx.channel, 25);
  if (!user && /\{(user\.name|user)\}/i.test(template)) {
    return null;
  }
  if (!msgId && /\{(msg\.id|msg-id)\}/i.test(template)) {
    return null;
  }
  if (!channel && /\{(channel\.name|channel)\}/i.test(template)) {
    return null;
  }
  const expanded = template.replace(PLACEHOLDER_RE, (_m, name: string) => {
    switch (name.toLowerCase()) {
      case "user.name":
      case "user":
        return user;
      case "msg.id":
      case "msg-id":
        return msgId;
      case "channel.name":
      case "channel":
        return channel;
      default:
        return "";
    }
  });
  const text = expanded.trim();
  if (!text || text.length > MAX_ACTION_CHARS) {
    return null;
  }
  if (/[\r\n\0]/.test(text)) {
    return null;
  }
  return text;
}

function sanitizeToken(value: string, max: number): string {
  const t = value.trim();
  if (!t || t.length > max) {
    return "";
  }
  if (/[\s{}]/.test(t)) {
    return "";
  }
  return t;
}
