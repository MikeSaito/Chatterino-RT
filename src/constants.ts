export const DEFAULT_SCROLLBACK_LIMIT = 1000;
export const SCROLLBACK_LIMIT = DEFAULT_SCROLLBACK_LIMIT;
export const MESSAGE_POOL_SIZE = DEFAULT_SCROLLBACK_LIMIT;

const SCROLLBACK_MIN = 100;
/** GPU Pixi slot pool hard cap (not Rust history alone — avoids OOM on knob). */
const SCROLLBACK_MAX = 10_000;

type KnobMap = Record<string, boolean | string | number | null>;

function clampScrollbackLimit(raw: number): number {
  return Math.min(SCROLLBACK_MAX, Math.max(SCROLLBACK_MIN, Math.floor(raw)));
}

export function scrollbackLimitFromKnobs(knobs: KnobMap): number {
  const raw = knobs["misc.scrollbackSplitLimit"];
  const n =
    typeof raw === "number" && Number.isFinite(raw)
      ? raw
      : DEFAULT_SCROLLBACK_LIMIT;
  return clampScrollbackLimit(n);
}

export function scrollbackUsercardLimitFromKnobs(knobs: KnobMap): number {
  const raw = knobs["misc.scrollbackUsercardLimit"];
  const n =
    typeof raw === "number" && Number.isFinite(raw)
      ? raw
      : DEFAULT_SCROLLBACK_LIMIT;
  return clampScrollbackLimit(n);
}

export const BATCH_FLUSH_MS = 40;
export const BATCH_MAX_MESSAGES = 64;
export const BATCH_MAX_BYTES = 64 * 1024;
export const EMOTE_SLOTS_PER_ROW = 12;
export const MENTION_SLOTS_PER_ROW = 8;
export const BADGE_SLOTS_PER_ROW = 12;
export const MOD_ACTION_SLOTS_PER_ROW = 8;
/** Twitch badge base is 18; slightly under line height at default chat font. */
export const BADGE_SIZE = 14;
export const TEXTURE_LRU_LIMIT = 256;
/** Hard cap on decoded GIF/WebP animation frames per emote (VRAM bound). */
export const MAX_GIF_FRAMES = 48;
export const LINE_HEIGHT = 22;
export const FONT_SIZE = 15;
export const CHAR_WIDTH = 8.4;
export const CHAT_STATUS_EVENT = "chat:status";
export const CHAT_CHANNEL_LIVE_EVENT = "chat:channel_live";
export const CHAT_ROOMSTATE_EVENT = "chat:roomstate";
export const CHAT_AUTH_EVENT = "chat:auth";
export const CHAT_PIPE_EVENT = "chat:pipe";
export const CHAT_ROOMS_EVENT = "chat:rooms";
export const CHAT_SEND_WAIT_EVENT = "chat:send-wait";
export const CHAT_HISTORY_LOADED_EVENT = "chat:history-loaded";
export const CHAT_CROSS_MENTION_EVENT = "chat:cross_mention";
export const CHAT_TYPING_EVENT = "chat:typing";
export const CHAT_GIFT_TOAST_EVENT = "chat:gift_toast";
export const CHAT_OUTGOING_RAID_EVENT = "chat:outgoing_raid";
export const IPC_QUEUE_MAX = 8;
