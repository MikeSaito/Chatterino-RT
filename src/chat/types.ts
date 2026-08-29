export type EmoteSpan = {
  start: number;
  end: number;
  emoteId: string;
  provider: string;
  url: string;
  zeroWidth: boolean;
  /** 7TV author display width (logical 1x pixels). */
  displayWidth?: number;
  displayHeight?: number;
  /** Stacked bits total (emotes.stackBits). */
  bitsAmount?: number;
  bitsColor?: string;
};

export type LinkSpan = {
  start: number;
  end: number;
  url: string;
};

export type MentionSpan = {
  start: number;
  end: number;
  login: string;
};

/** Parsed USERNOTICE msg-param-* (from Rust). */
export type UsernoticeParams = {
  displayName?: string;
  login?: string;
  userId?: string;
  color?: string;
  plan?: string;
  months?: number;
  cumulativeMonths?: number;
  multimonthDuration?: number;
  multimonthTenure?: number;
  giftMonths?: number;
  senderCount?: number;
  massGiftCount?: number;
  recipientLogin?: string;
  recipientDisplayName?: string;
  recipientId?: string;
  viewerCount?: number;
  raidLogin?: string;
  raidDisplayName?: string;
  bitsThreshold?: number;
  ritualName?: string;
  category?: string;
  value?: number;
  anon?: boolean;
};

export type NickPaintStop = {
  at: number;
  color: number;
};

export type NickPaintShadow = {
  xTenths: number;
  yTenths: number;
  radiusTenths: number;
  color: number;
};

export type NickPaint = {
  id: string;
  name?: string;
  angle: number;
  repeat: boolean;
  stops: NickPaintStop[];
  color?: number;
  shadow?: NickPaintShadow;
};

export type Badge = {
  set: string;
  version: string;
  url?: string;
  source?: string;
  tooltip?: string;
};

export type ChatEvent =
  | {
      kind: "privmsg";
      id: string;
      timestampMs: number;
      userId: string;
      login: string;
      displayName: string;
      color: string;
      badges: Badge[];
      text: string;
      emoteSpans: EmoteSpan[];
      linkSpans?: LinkSpan[];
      mentionSpans?: MentionSpan[];
      bits?: number;
      replyToId?: string;
      replyToLogin?: string;
      replyToText?: string;
      action: boolean;
      firstMsg?: boolean;
      customRewardId?: string;
      systemMsgId?: string;
      highlightColor?: string;
      highlightSound?: boolean;
      highlightSoundPath?: string;
      highlightFlash?: boolean;
      whisper?: boolean;
      /** Soft-disabled (similar / R9K). */
      disabled?: boolean;
      /** 7TV username paint. */
      paint?: NickPaint;
    }
  | {
      kind: "clearchat";
      id: string;
      timestampMs: number;
      targetLogin?: string;
      durationSec?: number;
      stackCount?: number;
    }
  | {
      kind: "clearmsg";
      id: string;
      timestampMs: number;
      targetId: string;
    }
  | {
      kind: "usernotice";
      id: string;
      timestampMs: number;
      systemText: string;
      login?: string;
      msgId?: string;
      params?: UsernoticeParams;
      privmsg?: ChatEvent;
      highlightColor?: string;
      highlightSound?: boolean;
      highlightSoundPath?: string;
      highlightFlash?: boolean;
    }
  | {
      kind: "roomstate";
      id: string;
      timestampMs: number;
      emoteOnly?: boolean;
      subsOnly?: boolean;
      slowSec?: number;
      followersOnly?: number;
    }
  | {
      kind: "userstate";
      id: string;
      timestampMs: number;
      badges: Badge[];
      isModTag?: boolean;
    }
  | {
      kind: "notice";
      id: string;
      timestampMs: number;
      text: string;
      msgId?: string;
      timeoutRemainingSec?: number;
    };

export type ChatBatch = {
  channelId: string;
  seq: number;
  dropped: number;
  events: ChatEvent[];
};

export type ChatStatus = {
  state: "connecting" | "connected" | "reconnecting" | "error";
  channel?: string;
  message?: string;
};

export type ViewerRole = {
  isMod: boolean;
  isBroadcaster: boolean;
};

export type ChannelLive = {
  channel: string;
  live: boolean;
  viewerCount?: number;
  gameName?: string;
  streamTitle?: string;
  startedAt?: string;
};

export type AuthAccountRow = {
  login: string;
  userId?: string;
  profileImageUrl?: string;
};

export type AuthInfo = {
  login?: string;
  accounts?: AuthAccountRow[];
  canSend: boolean;
  fromEnv: boolean;
  userCode?: string;
  pendingPaste?: boolean;
  message?: string;
  profileImageUrl?: string;
};

export type Filters = {
  enableSelfHighlight: boolean;
  ignoreLogins: string[];
  ignorePhrases: string[];
  highlightPhrases: string[];
  highlightLogins: string[];
};

/** @deprecated use AppSettings from settings/dialog; kept for narrow display fields */
export type DisplaySettings = {
  fontScale: number;
  showTimestamps: boolean;
  hideModerated: boolean;
  timestampFormat?: string;
};
