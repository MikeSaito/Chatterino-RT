export const DEFAULT_SCROLLBACK_LIMIT = 1000;
export const SCROLLBACK_LIMIT = DEFAULT_SCROLLBACK_LIMIT;
export const MESSAGE_POOL_SIZE = DEFAULT_SCROLLBACK_LIMIT;

const SCROLLBACK_MIN = 100;
const SCROLLBACK_MAX = 100_000;

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
export const BADGE_SIZE = 18;
export const TEXTURE_LRU_LIMIT = 256;
/** Hard cap on decoded GIF/WebP animation frames per emote (VRAM bound). */
export const MAX_GIF_FRAMES = 48;
export const LINE_HEIGHT = 22;
export const FONT_SIZE = 15;
export const CHAR_WIDTH = 8.4;
export const CHAT_STATUS_EVENT = "chat:status";
export const CHAT_CHANNEL_LIVE_EVENT = "chat:channel_live";
export const CHAT_AUTH_EVENT = "chat:auth";
export const CHAT_PIPE_EVENT = "chat:pipe";
export const CHAT_ROOMS_EVENT = "chat:rooms";
export const CHAT_SEND_WAIT_EVENT = "chat:send-wait";
export const CHAT_HISTORY_LOADED_EVENT = "chat:history-loaded";
export const IPC_QUEUE_MAX = 8;
