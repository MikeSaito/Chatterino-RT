/** Stock Chatterino UserInfoPopup timeout button durations. */

export type TimeoutButton = {
  label: string;
  seconds: number;
};

export type KnobMap = Record<string, boolean | string | number | null | undefined>;

const UNIT_SECONDS: Record<string, number> = {
  s: 1,
  m: 60,
  h: 3600,
  d: 86400,
  w: 604800,
};

const DEFAULTS: ReadonlyArray<{ duration: number; unit: string }> = [
  { duration: 1, unit: "s" },
  { duration: 30, unit: "s" },
  { duration: 1, unit: "m" },
  { duration: 5, unit: "m" },
  { duration: 30, unit: "m" },
  { duration: 1, unit: "h" },
  { duration: 1, unit: "d" },
  { duration: 1, unit: "w" },
];

/** Convert duration + unit to seconds. Returns null if invalid. */
export function durationSeconds(duration: number, unit: string): number | null {
  if (!Number.isFinite(duration) || duration < 1 || duration > 99) {
    return null;
  }
  const mult = UNIT_SECONDS[unit.trim().toLowerCase()];
  if (mult == null) {
    return null;
  }
  const secs = Math.floor(duration) * mult;
  if (secs < 1) {
    return null;
  }
  return secs;
}

export function formatTimeoutLabel(duration: number, unit: string): string {
  const u = unit.trim().toLowerCase() || "s";
  return `${Math.floor(duration)}${u}`;
}

function knobNumber(knobs: KnobMap, key: string, fallback: number): number {
  const v = knobs[key];
  if (typeof v === "number" && Number.isFinite(v)) {
    return v;
  }
  if (typeof v === "string" && v.trim() !== "") {
    const n = Number(v);
    if (Number.isFinite(n)) {
      return n;
    }
  }
  return fallback;
}

function knobUnit(knobs: KnobMap, key: string, fallback: string): string {
  const v = knobs[key];
  if (typeof v === "string" && v.trim() !== "") {
    return v.trim().toLowerCase();
  }
  return fallback;
}

/** Parse up to 8 User Timeout Buttons from settings knobs. */
export function parseTimeoutButtons(knobs: KnobMap): TimeoutButton[] {
  const out: TimeoutButton[] = [];
  for (let i = 0; i < 8; i++) {
    const def = DEFAULTS[i]!;
    const n = i + 1;
    const duration = knobNumber(knobs, `timeouts.button${n}.duration`, def.duration);
    const unit = knobUnit(knobs, `timeouts.button${n}.unit`, def.unit);
    const seconds = durationSeconds(duration, unit);
    if (seconds == null) {
      continue;
    }
    out.push({
      label: formatTimeoutLabel(duration, unit),
      seconds,
    });
  }
  return out;
}

export type ModerationCommandKind =
  | "timeout"
  | "ban"
  | "unban"
  | "mod"
  | "unmod"
  | "vip"
  | "unvip";

/** Build slash command for chat_send. Login must already be normalized. */
export function moderationSlashCommand(
  kind: ModerationCommandKind,
  login: string,
  seconds?: number,
): string | null {
  const user = login.trim().toLowerCase();
  if (!user || !/^[a-z0-9_]{1,25}$/.test(user)) {
    return null;
  }
  if (kind === "timeout") {
    if (seconds == null || !Number.isFinite(seconds) || seconds < 1) {
      return null;
    }
    return `/timeout ${user} ${Math.floor(seconds)}`;
  }
  if (kind === "ban") {
    return `/ban ${user}`;
  }
  if (kind === "unban") {
    return `/unban ${user}`;
  }
  if (kind === "mod") {
    return `/mod ${user}`;
  }
  if (kind === "unmod") {
    return `/unmod ${user}`;
  }
  if (kind === "vip") {
    return `/vip ${user}`;
  }
  return `/unvip ${user}`;
}

const WARN_REASON_MAX = 500;

function reasonCodePointCount(reason: string): number {
  return [...reason].length;
}

/** Build `/warn` slash command. Reason is required (Twitch Helix). */
export function warnSlashCommand(login: string, reason: string): string | null {
  const user = login.trim().toLowerCase();
  if (!user || !/^[a-z0-9_]{1,25}$/.test(user)) {
    return null;
  }
  const trimmed = reason.trim();
  if (!trimmed) {
    return null;
  }
  if (/[\r\n\0]/.test(trimmed)) {
    return null;
  }
  if (reasonCodePointCount(trimmed) > WARN_REASON_MAX) {
    return null;
  }
  return `/warn ${user} ${trimmed}`;
}

export function warnReasonRejectReason(
  reason: string,
): "empty" | "controls" | "too_long" | null {
  const trimmed = reason.trim();
  if (!trimmed) {
    return "empty";
  }
  if (/[\r\n\0]/.test(trimmed)) {
    return "controls";
  }
  if (reasonCodePointCount(trimmed) > WARN_REASON_MAX) {
    return "too_long";
  }
  return null;
}
