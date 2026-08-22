export type EmoteSpan = {
  start: number;
  end: number;
  emoteId: string;
  provider: string;
  url: string;
  zeroWidth: boolean;
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

export type Badge = {
  set: string;
  version: string;
  url?: string;
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
    }
  | {
      kind: "clearchat";
      id: string;
      timestampMs: number;
      targetLogin?: string;
      durationSec?: number;
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
      privmsg?: ChatEvent;
      highlightColor?: string;
      highlightSound?: boolean;
      highlightSoundPath?: string;
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

export type AuthInfo = {
  login?: string;
  canSend: boolean;
  fromEnv: boolean;
  userCode?: string;
  pendingPaste?: boolean;
  message?: string;
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
