import type { AutomodRange, Badge, EmoteSpan, LinkSpan, MentionSpan, NickPaint, UsernoticeParams } from "./types";
import type { HostSpanRange } from "./linkDisplay";
import type { ClipCardInfo } from "./linkEnrichment";
import type { WrapLine } from "./wrap";
import type { LaidSlot } from "./scroll";

export type MessageRow = {
  nickPaint: NickPaint | null;
  badgesRaw: Badge[];
  automodMessageId: string;
  automodStatus: string;
  automodCaught: AutomodRange[];
  /** Low Trust status for streamer-mode hide (`restricted` | `monitored` | ""). */
  lowTrustStatus: string;
  msgId: string;
  login: string;
  /** Текст до host-display transform (whisper/action lead). */
  bodySource: string;
  /** Painted body (may lowercase link hosts). */
  bodyRaw: string;
  nickRaw: string;
  copyText: string;
  replyToId: string;
  timestampMs: number;
  spansRaw: EmoteSpan[];
  linkSpans: LinkSpan[];
  hostSpans: HostSpanRange[];
  mentionSpans: MentionSpan[];
  clipCard: ClipCardInfo | null;
  clipCardRows: number;
  /** True after title/host rewrite; displayBody must not rebuild from bodySource. */
  linkEnriched: boolean;
  wrapLines: WrapLine[];
  /** Per-line body row heights (tall GIF/emote rows expand beyond lineHeight). */
  wrapLineHeights: number[];
  /** false until paintClip finishes metrics for current bodyRaw. */
  wrapReady: boolean;
  lineCount: number;
  /** Pixel origin of first body wrap line (ceil-aligned to char grid). */
  bodyIndent: number;
  /** Pixel origin of wrap lines 2+ (under timestamp / after mod gutter). */
  bodyContIndent: number;
  /** Left-aligned system cloud bounds (null when not a cloud). */
  systemCloudBounds: {
    x: number;
    y: number;
    w: number;
    h: number;
    radius: number;
    /** Row height used inside the pill (fontSize − delta). */
    lineHeight: number;
    fontSize: number;
  } | null;
  /** Rows occupied by reply header above the main line. */
  replyRows: number;
  startRow: number;
  scrollLayout: LaidSlot;
  highlightColor: string;
  disabled: boolean;
  /** Scrollback snapshot (stock MessageFlag::RecentMessage). */
  fromHistory: boolean;
  /** Privmsg-like: stock MessageFlag::Collapsed + expand on click. */
  collapsible: boolean;
  expanded: boolean;
  /** Set in paintClip when body is truncated this frame. */
  collapsed: boolean;
  /** System/timeout-like: не гасить при room CLEARCHAT (как MessageFlag::System). */
  system: boolean;
  /** Author nick chrome (privmsg); empty → system / fallback. */
  nickUserId: string;
  nickColorRaw: string;
  nickLogin: string;
  nickDisplay: string;
  useNickStyle: boolean;
  replyToLogin: string;
  replyToText: string;
  isAction: boolean;
  isWhisper: boolean;
  /** Символы до reply/action + copyText (Whisper: / system lead usernotice). */
  leadLen: number;
  /** Rebuild CLEARCHAT/CLEARMSG/USERNOTICE/NOTICE body on locale change. */
  systemTextKind: "" | "clearchat" | "clearmsg" | "usernotice" | "notice";
  clearLogin: string;
  clearDurationSec: number | undefined;
  clearStackCount: number;
  clearSourceLogin: string;
  clearModeratorLogin: string;
  clearmsgBody: string;
  usernoticeMsgId: string;
  usernoticeSystemText: string;
  usernoticeLogin: string;
  usernoticeParams: UsernoticeParams | null;
  /** Attached USERNOTICE privmsg body (action prefix included); survives locale switch. */
  usernoticeInnerBody: string;
  noticeMsgId: string;
  noticeFallback: string;
  noticeTimeoutSec: number | undefined;
};

export function createMessageRow(): MessageRow {
  return {
    nickPaint: null,
    badgesRaw: [],
    automodMessageId: "",
    automodStatus: "",
    automodCaught: [],
    lowTrustStatus: "",
    msgId: "",
    login: "",
    bodySource: "",
    bodyRaw: "",
    nickRaw: "",
    copyText: "",
    replyToId: "",
    timestampMs: 0,
    spansRaw: [],
    linkSpans: [],
    hostSpans: [],
    mentionSpans: [],
    clipCard: null,
    clipCardRows: 0,
    linkEnriched: false,
    wrapLines: [{ start: 0, end: 0 }],
    wrapLineHeights: [],
    wrapReady: false,
    lineCount: 1,
    bodyIndent: 0,
    bodyContIndent: 0,
    systemCloudBounds: null,
    replyRows: 0,
    startRow: 0,
    scrollLayout: { msgId: "", startRow: 0, lineCount: 0 },
    highlightColor: "",
    disabled: false,
    fromHistory: false,
    collapsible: false,
    expanded: false,
    collapsed: false,
    system: false,
    nickUserId: "",
    nickColorRaw: "",
    nickLogin: "",
    nickDisplay: "",
    useNickStyle: false,
    replyToLogin: "",
    replyToText: "",
    isAction: false,
    isWhisper: false,
    leadLen: 0,
    systemTextKind: "",
    clearLogin: "",
    clearDurationSec: undefined,
    clearStackCount: 0,
    clearSourceLogin: "",
    clearModeratorLogin: "",
    clearmsgBody: "",
    usernoticeMsgId: "",
    usernoticeSystemText: "",
    usernoticeLogin: "",
    usernoticeParams: null,
    usernoticeInnerBody: "",
    noticeMsgId: "",
    noticeFallback: "",
    noticeTimeoutSec: undefined,
  };
}
