/** Settings UI catalog for Chatterino RT. Labels match stock Chatterino. */

export type KnobType =
  | "checkbox"
  | "select"
  | "text"
  | "number"
  | "color"
  | "button"
  | "label";

export type SelectOption = { label: string; value: string };

export type KnobDef = {
  id: string;
  path: string;
  label: string;
  type: KnobType;
  options?: SelectOption[];
  min?: number;
  max?: number;
  step?: number;
  defaultValue: boolean | string | number;
  /** Stock inverseCheckbox: UI checked means !stored value. */
  inverse?: boolean;
  search?: string;
};

export type SectionDef = {
  title: string;
  knobs: KnobDef[];
};

export type TableColumn = {
  key: string;
  label: string;
  type: "text" | "checkbox" | "color" | "select";
  options?: { label: string; value: string }[];
};

export type TableDef = {
  id: string;
  columns: TableColumn[];
  path: string;
  blankRow: Record<string, string | boolean>;
};

export type PageDef = {
  id: string;
  title: string;
  navLabel: string;
  search: string;
  kind: "knobs" | "table" | "about" | "accounts" | "hotkeys" | "nested-tabs";
  sections?: SectionDef[];
  tabs?: {
    id: string;
    label: string;
    sections?: SectionDef[];
    table?: TableDef;
  }[];
  table?: TableDef;
};

function opt(label: string, value: string): SelectOption {
  return { label, value };
}

function cb(
  id: string,
  path: string,
  label: string,
  defaultValue: boolean,
  search?: string,
  inverse?: boolean,
): KnobDef {
  return { id, path, label, type: "checkbox", defaultValue, search, inverse };
}

function sel(
  id: string,
  path: string,
  label: string,
  options: SelectOption[],
  defaultValue: string,
  search?: string,
): KnobDef {
  return { id, path, label, type: "select", options, defaultValue, search };
}

function txt(
  id: string,
  path: string,
  label: string,
  defaultValue: string,
  search?: string,
): KnobDef {
  return { id, path, label, type: "text", defaultValue, search };
}

function num(
  id: string,
  path: string,
  label: string,
  defaultValue: number,
  min?: number,
  max?: number,
  step?: number,
  search?: string,
): KnobDef {
  return { id, path, label, type: "number", defaultValue, min, max, step, search };
}

function col(
  id: string,
  path: string,
  label: string,
  defaultValue: string,
  search?: string,
): KnobDef {
  return { id, path, label, type: "color", defaultValue, search };
}

function btn(
  id: string,
  path: string,
  label: string,
  search?: string,
): KnobDef {
  return { id, path, label, type: "button", defaultValue: "", search };
}

function lab(
  id: string,
  path: string,
  label: string,
  defaultValue = "",
  search?: string,
): KnobDef {
  return { id, path, label, type: "label", defaultValue, search };
}

/** Zoom dropdown values (stock ZOOM_LEVELS). Value is scale string. */
export const ZOOM_LEVELS: SelectOption[] = [
  opt("0.5x", "0.5"),
  opt("0.6x", "0.6"),
  opt("0.7x", "0.7"),
  opt("0.8x", "0.8"),
  opt("0.9x", "0.9"),
  opt("Default", "1"),
  opt("1.2x", "1.2"),
  opt("1.4x", "1.4"),
  opt("1.6x", "1.6"),
  opt("1.8x", "1.8"),
  opt("2x", "2"),
  opt("2.33x", "2.33"),
  opt("2.66x", "2.66"),
  opt("3x", "3"),
  opt("3.5x", "3.5"),
  opt("4x", "4"),
];

/** Message timestamp format options (GeneralPage). */
export const TIMESTAMP_FORMATS: SelectOption[] = [
  opt("Disable", "Disable"),
  opt("h:mm", "h:mm"),
  opt("hh:mm", "hh:mm"),
  opt("h:mm a", "h:mm a"),
  opt("hh:mm a", "hh:mm a"),
  opt("h:mm:ss", "h:mm:ss"),
  opt("hh:mm:ss", "hh:mm:ss"),
  opt("h:mm:ss a", "h:mm:ss a"),
  opt("hh:mm:ss a", "hh:mm:ss a"),
  opt("h:mm:ss.zzz", "h:mm:ss.zzz"),
  opt("h:mm:ss.zzz a", "h:mm:ss.zzz a"),
  opt("hh:mm:ss.zzz", "hh:mm:ss.zzz"),
  opt("hh:mm:ss.zzz a", "hh:mm:ss.zzz a"),
];

const THEME_OPTIONS: SelectOption[] = [
  opt("White", "White"),
  opt("Light", "Light"),
  opt("Dark", "Dark"),
  opt("Black", "Black"),
  opt("System", "System"),
];

const THEME_BUILTIN: SelectOption[] = [
  opt("White", "White"),
  opt("Light", "Light"),
  opt("Dark", "Dark"),
  opt("Black", "Black"),
];

const META_KEY = "Windows";

const PAUSE_HOVER: SelectOption[] = [
  opt("Disabled", "0"),
  opt("0.5s", "0.5"),
  opt("1s", "1"),
  opt("2s", "2"),
  opt("5s", "5"),
  opt("Indefinite", "-1"),
];

const PAUSE_MODIFIER: SelectOption[] = [
  opt("None", "None"),
  opt("Shift", "Shift"),
  opt("Control", "Control"),
  opt("Alt", "Alt"),
  opt(META_KEY, "Meta"),
];

const SCROLL_SPEED: SelectOption[] = [
  opt("0.5x", "0.5"),
  opt("0.75x", "0.75"),
  opt("Default", "1"),
  opt("1.5x", "1.5"),
  opt("2x", "2"),
];

const MESSAGE_OVERFLOW: SelectOption[] = [
  opt("Highlight", "Highlight"),
  opt("Prevent", "Prevent"),
  opt("Allow", "Allow"),
];

const USERNAME_RCLICK: SelectOption[] = [
  opt("Reply", "Reply"),
  opt("Mention", "Mention"),
  opt("Ignore", "Ignore"),
];

const USERNAME_RCLICK_MOD: SelectOption[] = [
  opt("Shift", "Shift"),
  opt("Control", "Control"),
  opt("Alt", "Alt"),
  opt(META_KEY, "Meta"),
];

const LIMIT_HEIGHT: SelectOption[] = [
  opt("Never", "0"),
  opt("2 lines", "2"),
  opt("3 lines", "3"),
  opt("4 lines", "4"),
  opt("5 lines", "5"),
];

const DELETED_LEN: SelectOption[] = [
  opt("No limit", "0"),
  opt("50 characters", "50"),
  opt("100 characters", "100"),
  opt("200 characters", "200"),
  opt("300 characters", "300"),
  opt("400 characters", "400"),
];

const LINE_STYLE: SelectOption[] = [opt("Solid", "Solid"), opt("Dotted", "Dotted")];

const EMOTE_SCALE: SelectOption[] = [
  opt("0.5x", "0.5"),
  opt("0.75x", "0.75"),
  opt("Default", "1"),
  opt("1.25x", "1.25"),
  opt("1.5x", "1.5"),
  opt("2x", "2"),
];

const THUMBNAIL_PREVIEW: SelectOption[] = [
  opt("Don't show", "DontShow"),
  opt("Always show", "AlwaysShow"),
  opt("Hold shift", "ShowOnShift"),
];

const EMOTE_TOOLTIP_SCALE: SelectOption[] = [
  opt("Small", "Small"),
  opt("Medium (default)", "Medium"),
  opt("Large", "Large"),
  opt("Huge", "Huge"),
];

const EMOJI_STYLE: SelectOption[] = [
  opt("Twitter", "Twitter"),
  opt("Facebook", "Facebook"),
  opt("Apple", "Apple"),
  opt("Google", "Google"),
];

const STREAMER_MODE: SelectOption[] = [
  opt("Disabled", "Disabled"),
  opt("Enabled", "Enabled"),
  opt("Automatic (Detect streaming software)", "DetectStreamingSoftware"),
];

const THUMB_SIZE: SelectOption[] = [
  opt("Off", "0"),
  opt("Small", "100"),
  opt("Medium", "200"),
  opt("Large", "300"),
];

const THUMB_STREAM: SelectOption[] = [
  opt("Off", "0"),
  opt("Small", "1"),
  opt("Medium", "2"),
  opt("Large", "3"),
];

const SOUND_BACKEND: SelectOption[] = [
  opt("Miniaudio", "Miniaudio"),
  opt("Null", "Null"),
];

const SIMILARITY_PCT: SelectOption[] = [
  opt("0.5", "0.5"),
  opt("0.75", "0.75"),
  opt("0.9", "0.9"),
];

const SIMILARITY_DELAY: SelectOption[] = [
  opt("5s", "5"),
  opt("10s", "10"),
  opt("15s", "15"),
  opt("30s", "30"),
  opt("60s", "60"),
  opt("120s", "120"),
];

const SIMILARITY_CHECK: SelectOption[] = [
  opt("1", "1"),
  opt("2", "2"),
  opt("3", "3"),
  opt("4", "4"),
  opt("5", "5"),
];

const SEARCH_PRESET: SelectOption[] = [
  opt("DuckDuckGo", "DuckDuckGo"),
  opt("Bing", "Bing"),
  opt("Google", "Google"),
];

const USERNAME_STYLE: SelectOption[] = [
  opt("Username", "Username"),
  opt("Localized name", "LocalizedName"),
  opt("Username and localized name", "UsernameAndLocalizedName"),
];

const BOLD_SCALE: SelectOption[] = [
  opt("50", "50"),
  opt("Default", "63"),
  opt("75", "75"),
  opt("100", "100"),
];

const SHOW_MOD_STATE: SelectOption[] = [
  opt("Always", "Always"),
  opt("Never", "Never"),
];

const TIMEOUT_STACK: SelectOption[] = [
  opt("Stack", "0"),
  opt("Stack until timeout", "1"),
  opt("Don't stack", "2"),
];

const CHAT_SEND: SelectOption[] = [
  opt("Default", "Default"),
  opt("IRC", "IRC"),
  opt("Helix", "Helix"),
];

const TAB_LAYOUT: SelectOption[] = [
  opt("Top", "Top"),
  opt("Left", "Left"),
  opt("Right", "Right"),
  opt("Bottom", "Bottom"),
];

const TAB_VISIBILITY: SelectOption[] = [
  opt("All tabs", "AllTabs"),
  opt("Only live tabs", "LiveOnly"),
];

const TAB_STYLE: SelectOption[] = [
  opt("Normal", "Normal"),
  opt("Compact", "Compact"),
];

const BLOCKED_SHOW: SelectOption[] = [
  opt("Never", "0"),
  opt("If you are Moderator", "1"),
  opt("If you are Broadcaster", "2"),
];

const STREAMLINK_QUALITY: SelectOption[] = [
  opt("Choose", "Choose"),
  opt("Source", "Source"),
  opt("High", "High"),
  opt("Medium", "Medium"),
  opt("Low", "Low"),
  opt("Audio only", "AudioOnly"),
];

const TOAST_REACTION: SelectOption[] = [
  opt("Open stream in browser", "OpenInBrowser"),
  opt("Open player in browser", "OpenInPlayer"),
  opt("Open in streamlink", "OpenInStreamlink"),
  opt("Don't open", "DontOpen"),
  opt("Open in custom player", "OpenInCustomPlayer"),
];

const MANIFEST_FORMAT: SelectOption[] = [
  opt("Chrome", "Chrome"),
  opt("Firefox", "Firefox"),
];

const TIMEOUT_UNIT: SelectOption[] = [
  opt("s", "s"),
  opt("m", "m"),
  opt("h", "h"),
  opt("d", "d"),
  opt("w", "w"),
];

const NICKNAMES_TABLE: TableDef = {
  id: "nicknames",
  path: "nicknames",
  columns: [
    { key: "username", label: "Username", type: "text" },
    { key: "nickname", label: "Nickname", type: "text" },
    { key: "regex", label: "Enable regex", type: "checkbox" },
    { key: "caseSensitive", label: "Case-sensitive", type: "checkbox" },
  ],
  blankRow: {
    username: "",
    nickname: "",
    regex: false,
    caseSensitive: false,
  },
};

const COMMANDS_TABLE: TableDef = {
  id: "commands",
  path: "commands",
  columns: [
    { key: "trigger", label: "Trigger", type: "text" },
    { key: "command", label: "Command", type: "text" },
    {
      key: "showInMessageMenu",
      label: "Show In Message Menu",
      type: "checkbox",
    },
  ],
  blankRow: { trigger: "", command: "", showInMessageMenu: false },
};

const HIGHLIGHT_MESSAGES_TABLE: TableDef = {
  id: "highlight-messages",
  path: "highlightMessages",
  columns: [
    { key: "pattern", label: "Pattern", type: "text" },
    { key: "showInMentions", label: "Show in Mentions", type: "checkbox" },
    { key: "flashTaskbar", label: "Flash taskbar", type: "checkbox" },
    { key: "regex", label: "Enable regex", type: "checkbox" },
    { key: "caseSensitive", label: "Case-sensitive", type: "checkbox" },
    { key: "playSound", label: "Play sound", type: "checkbox" },
    { key: "customSound", label: "Custom sound", type: "text" },
    { key: "color", label: "Color", type: "color" },
  ],
  blankRow: {
    pattern: "",
    showInMentions: true,
    flashTaskbar: true,
    regex: false,
    caseSensitive: false,
    playSound: false,
    customSound: "",
    color: "",
  },
};

const HIGHLIGHT_USERS_TABLE: TableDef = {
  id: "highlight-users",
  path: "highlightUsers",
  columns: [
    { key: "username", label: "Username", type: "text" },
    { key: "showInMentions", label: "Show in Mentions", type: "checkbox" },
    { key: "flashTaskbar", label: "Flash taskbar", type: "checkbox" },
    { key: "playSound", label: "Play sound", type: "checkbox" },
    { key: "customSound", label: "Custom sound", type: "text" },
    { key: "color", label: "Color", type: "color" },
  ],
  blankRow: {
    username: "",
    showInMentions: true,
    flashTaskbar: true,
    playSound: false,
    customSound: "",
    color: "",
  },
};

const HIGHLIGHT_BADGES_TABLE: TableDef = {
  id: "highlight-badges",
  path: "highlightBadges",
  columns: [
    { key: "name", label: "Name", type: "text" },
    { key: "showInMentions", label: "Show In Mentions", type: "checkbox" },
    { key: "flashTaskbar", label: "Flash taskbar", type: "checkbox" },
    { key: "playSound", label: "Play sound", type: "checkbox" },
    { key: "customSound", label: "Custom sound", type: "text" },
    { key: "color", label: "Color", type: "color" },
  ],
  blankRow: {
    name: "",
    showInMentions: true,
    flashTaskbar: false,
    playSound: false,
    customSound: "",
    color: "",
  },
};

const HIGHLIGHT_BLACKLIST_TABLE: TableDef = {
  id: "highlight-blacklist",
  path: "highlightBlacklist",
  columns: [
    { key: "username", label: "Username", type: "text" },
    { key: "regex", label: "Enable regex", type: "checkbox" },
  ],
  blankRow: { username: "", regex: false },
};

const IGNORE_MESSAGES_TABLE: TableDef = {
  id: "ignore-messages",
  path: "ignoreMessages",
  columns: [
    { key: "pattern", label: "Pattern", type: "text" },
    { key: "regex", label: "Regex", type: "checkbox" },
    { key: "caseSensitive", label: "Case-sensitive", type: "checkbox" },
    { key: "block", label: "Block", type: "checkbox" },
    { key: "replacement", label: "Replacement", type: "text" },
  ],
  blankRow: {
    pattern: "",
    regex: false,
    caseSensitive: false,
    block: true,
    replacement: "***",
  },
};

const IGNORE_USERS_TABLE: TableDef = {
  id: "ignore-users",
  path: "ignoreUsers",
  columns: [
    { key: "username", label: "Username", type: "text" },
    { key: "regex", label: "Enable regex", type: "checkbox" },
  ],
  blankRow: { username: "", regex: false },
};

const FILTERS_TABLE: TableDef = {
  id: "filters",
  path: "filters",
  columns: [
    { key: "name", label: "Name", type: "text" },
    { key: "filter", label: "Filter", type: "text" },
    { key: "valid", label: "Valid", type: "checkbox" },
  ],
  blankRow: { name: "", filter: "", valid: true },
};

const HOTKEYS_TABLE: TableDef = {
  id: "hotkeys",
  path: "hotkeys",
  columns: [
    {
      key: "action",
      label: "Action",
      type: "select",
      options: [
        { label: "Show search", value: "showSearch" },
        { label: "Open settings", value: "openSettings" },
        { label: "Open emotes popup", value: "openEmotesPopup" },
        { label: "Scroll to bottom", value: "scrollToBottom" },
        { label: "Zoom in", value: "zoomIn" },
        { label: "Zoom out", value: "zoomOut" },
        { label: "Zoom reset", value: "zoomReset" },
      ],
    },
    { key: "keybinding", label: "Keybinding", type: "text" },
  ],
  blankRow: { action: "showSearch", keybinding: "Ctrl+F", name: "Show search" },
};

const LOG_CHANNELS_TABLE: TableDef = {
  id: "log-channels",
  path: "logChannels",
  columns: [{ key: "channel", label: "Twitch channels", type: "text" }],
  blankRow: { channel: "" },
};

const MOD_ACTIONS_TABLE: TableDef = {
  id: "mod-actions",
  path: "modActions",
  columns: [
    { key: "action", label: "Action", type: "text" },
    { key: "icon", label: "Icon", type: "text" },
  ],
  blankRow: { action: "", icon: "" },
};

const NOTIFY_CHANNELS_TABLE: TableDef = {
  id: "notify-channels",
  path: "notifyChannels",
  columns: [{ key: "channel", label: "Twitch channels", type: "text" }],
  blankRow: { channel: "" },
};

const GENERAL_SECTIONS: SectionDef[] = [
  {
    title: "Interface",
    knobs: [
      sel("theme", "appearance.theme", "Theme", THEME_OPTIONS, "Dark"),
      sel(
        "dark-system-theme",
        "appearance.darkSystemTheme",
        "Dark system theme",
        THEME_BUILTIN,
        "Dark",
      ),
      sel(
        "light-system-theme",
        "appearance.lightSystemTheme",
        "Light system theme",
        THEME_BUILTIN,
        "Light",
      ),
      sel(
        "zoom",
        "__wired.fontScale",
        "Zoom",
        ZOOM_LEVELS,
        "1",
        "uiScale fontScale",
      ),
      sel("tab-layout", "appearance.tabDirection", "Tab layout", TAB_LAYOUT, "Top"),
      sel(
        "tab-visibility",
        "appearance.tabVisibility",
        "Tab visibility",
        TAB_VISIBILITY,
        "AllTabs",
      ),
      sel("tab-style", "appearance.tabStyle", "Tab style", TAB_STYLE, "Normal"),
      txt(
        "chat-font-family",
        "appearance.chatFontFamily",
        "Font family",
        "Segoe UI",
        "font weight size",
      ),
      num(
        "chat-font-size",
        "appearance.chatFontSize",
        "Font size",
        10,
        1,
        96,
        1,
        "font",
      ),
      num(
        "chat-font-weight",
        "appearance.chatFontWeight",
        "Font weight",
        50,
        1,
        999,
        1,
        "font",
      ),
      cb(
        "show-reply-context",
        "appearance.hideReplyContext",
        "Show message reply context",
        false,
        undefined,
        true,
      ),
      cb(
        "show-reply-button",
        "appearance.showReplyButton",
        "Show message reply button",
        false,
      ),
      cb(
        "show-tab-close",
        "appearance.showTabCloseButton",
        "Show tab close button",
        true,
      ),
      cb(
        "always-on-top",
        "appearance.windowTopMost",
        "Always on top",
        false,
      ),
      cb("autorun", "behaviour.autorun", "Start with Windows", false),
      cb(
        "show-preferences-button",
        "appearance.hidePreferencesButton",
        "Show preferences button",
        false,
        undefined,
        true,
      ),
      cb(
        "show-user-button",
        "appearance.hideUserButton",
        "Show user button",
        false,
        undefined,
        true,
      ),
      cb(
        "show-tab-live",
        "appearance.showTabLive",
        "Mark tabs with live channels",
        true,
      ),
    ],
  },
  {
    title: "Chat",
    knobs: [
      sel(
        "pause-hover",
        "behaviour.pauseOnHoverDuration",
        "Pause on mouse hover",
        PAUSE_HOVER,
        "0",
      ),
      sel(
        "pause-key",
        "behaviour.pauseChatModifier",
        "Pause while holding a key",
        PAUSE_MODIFIER,
        "None",
      ),
      sel(
        "scroll-speed",
        "behaviour.mouseScrollMultiplier",
        "Mousewheel scroll speed",
        SCROLL_SPEED,
        "1",
      ),
      cb(
        "smooth-scrolling",
        "appearance.enableSmoothScrolling",
        "Smooth scrolling",
        true,
      ),
      cb(
        "smooth-scrolling-new",
        "appearance.enableSmoothScrollingNewMessages",
        "Smooth scrolling on new messages",
        false,
      ),
      cb(
        "show-empty-input",
        "appearance.showEmptyInput",
        "Show input when it's empty",
        true,
      ),
      cb(
        "show-message-length",
        "appearance.showMessageLength",
        "Show message length while typing",
        false,
      ),
      cb(
        "show-send-wait",
        "appearance.showSendWaitTimer",
        "Show countdown on slow mode or when timed out",
        false,
        "slowmode timeout",
      ),
      cb(
        "allow-duplicate",
        "behaviour.allowDuplicateMessages",
        "Allow sending duplicate messages",
        true,
      ),
      sel(
        "message-overflow",
        "appearance.messageOverflow",
        "Message overflow",
        MESSAGE_OVERFLOW,
        "Highlight",
      ),
      sel(
        "username-rclick",
        "behaviour.usernameRightClickBehavior",
        "Username right-click behavior",
        USERNAME_RCLICK,
        "Mention",
      ),
      sel(
        "username-rclick-mod",
        "behaviour.usernameRightClickModifierBehavior",
        "Username right-click with modifier behavior",
        USERNAME_RCLICK,
        "Reply",
      ),
      sel(
        "username-rclick-modifier",
        "behaviour.usernameRightClickModifier",
        "Modifier for alternate right-click action",
        USERNAME_RCLICK_MOD,
        "Shift",
      ),
      cb(
        "hide-scrollbar-thumb",
        "appearance.hideScrollbarThumb",
        "Hide scrollbar thumb",
        false,
        "scroll bar",
      ),
      cb(
        "hide-scrollbar-highlights",
        "appearance.hideScrollbarHighlights",
        "Hide scrollbar highlights",
        false,
        "scroll bar",
      ),
      cb(
        "pulse-self-message",
        "appearance.pulseTextInputOnSelfMessage",
        "Pulse text input when one of your messages is successfully sent",
        false,
      ),
    ],
  },
  {
    title: "Messages",
    knobs: [
      cb(
        "separate-messages",
        "appearance.separateMessages",
        "Separate with lines",
        false,
      ),
      cb(
        "alternate-messages",
        "appearance.alternateMessages",
        "Alternate background color",
        false,
      ),
      cb(
        "fade-history",
        "appearance.fadeMessageHistory",
        "Reduce opacity of message history",
        true,
      ),
      cb(
        "hide-moderated",
        "__wired.hideModerated",
        "Hide deleted messages",
        false,
      ),
      cb(
        "hide-timestamps-live",
        "appearance.hideMessageTimestampsWhenLive",
        "Hide message timestamps when channel is live",
        false,
      ),
      sel(
        "timestamp-format",
        "__wired.timestampFormat",
        "Message timestamp format",
        TIMESTAMP_FORMATS,
        "hh:mm",
        "a am/pm zzz milliseconds showTimestamps",
      ),
      sel(
        "limit-message-height",
        "appearance.collpseMessagesMinLines",
        "Limit message height",
        LIMIT_HEIGHT,
        "0",
      ),
      sel(
        "deleted-message-length",
        "behaviour.deletedMessageLengthLimit",
        "Limit length of deleted messages",
        DELETED_LEN,
        "50",
      ),
      cb(
        "last-message-indicator",
        "appearance.showLastMessageIndicator",
        "Draw a line below the most recent message before switching applications.",
        false,
      ),
      sel(
        "last-message-pattern",
        "appearance.lastMessagePattern",
        "Line style",
        LINE_STYLE,
        "Solid",
      ),
      col(
        "last-message-color",
        "appearance.lastMessageColor",
        "Line color",
        "#7f2026",
      ),
    ],
  },
  {
    title: "Emotes",
    knobs: [
      cb("emotes-enable", "emotes.enableEmoteImages", "Enable", true),
      cb("emotes-animate", "emotes.animateEmotes", "Animate", true),
      cb(
        "emotes-animate-focused",
        "appearance.animationsWhenFocused",
        "Animate only when Chatterino is focused",
        false,
      ),
      cb(
        "emotes-zerowidth",
        "emotes.enableZeroWidthEmotes",
        "Enable zero-width emotes",
        true,
      ),
      cb(
        "emotes-colon",
        "behaviour.emoteCompletionWithColon",
        "Enable emote completion by typing :",
        true,
      ),
      cb(
        "emotes-smart",
        "experiments.useSmartEmoteCompletion",
        "Use experimental smarter emote completion.",
        false,
      ),
      sel("emotes-size", "emotes.emoteScale", "Size", EMOTE_SCALE, "1"),
      cb(
        "emotes-remove-spaces",
        "emotes.removeSpacesBetweenEmotes",
        "Remove spaces between emotes",
        false,
      ),
      cb(
        "emotes-unlisted-7tv",
        "emotes.showUnlistedSevenTVEmotes",
        "Show unlisted 7TV emotes",
        false,
        "seventv",
      ),
      sel(
        "emotes-tooltip-preview",
        "misc.emotesTooltipPreview",
        "Show emote & badge thumbnail on hover",
        THUMBNAIL_PREVIEW,
        "AlwaysShow",
      ),
      sel(
        "emotes-tooltip-scale",
        "emotes.emoteTooltipScale",
        "Emote & badge thumbnail size on hover",
        EMOTE_TOOLTIP_SCALE,
        "Medium",
      ),
      sel("emoji-style", "emotes.emojiSet", "Emoji style", EMOJI_STYLE, "Twitter"),
      cb(
        "bttv-global",
        "emotes.enableBTTVGlobalEmotes",
        "Show BetterTTV global emotes",
        true,
        "bttv",
      ),
      cb(
        "bttv-channel",
        "emotes.enableBTTVChannelEmotes",
        "Show BetterTTV channel emotes",
        true,
        "bttv",
      ),
      cb(
        "bttv-live",
        "emotes.enableBTTVLiveUpdates",
        "Enable BetterTTV live emote updates",
        true,
        "bttv",
      ),
      cb(
        "bttv-activity",
        "emotes.sendBTTVActivity",
        "Send activity to BetterTTV",
        true,
        "bttv",
      ),
      cb(
        "ffz-global",
        "emotes.enableFFZGlobalEmotes",
        "Show FrankerFaceZ global emotes",
        true,
        "ffz",
      ),
      cb(
        "ffz-channel",
        "emotes.enableFFZChannelEmotes",
        "Show FrankerFaceZ channel emotes",
        true,
        "ffz",
      ),
      cb(
        "7tv-global",
        "emotes.enableSevenTVGlobalEmotes",
        "Show 7TV global emotes",
        true,
        "seventv",
      ),
      cb(
        "7tv-channel",
        "emotes.enableSevenTVChannelEmotes",
        "Show 7TV channel emotes",
        true,
        "seventv",
      ),
      cb(
        "7tv-live",
        "emotes.enableSevenTVEventAPI",
        "Enable 7TV live emote updates",
        true,
        "seventv",
      ),
      cb(
        "7tv-activity",
        "emotes.sendSevenTVActivity",
        "Send activity to 7TV",
        true,
        "seventv",
      ),
    ],
  },
  {
    title: "Streamer Mode",
    knobs: [
      sel(
        "streamer-mode",
        "streamerMode.enabled",
        "Enable Streamer Mode",
        STREAMER_MODE,
        "DetectStreamingSoftware",
      ),
      cb(
        "sm-hide-avatars",
        "streamerMode.hideUsercardAvatars",
        "Hide usercard avatars",
        true,
      ),
      cb(
        "sm-hide-link-thumbs",
        "streamerMode.hideLinkThumbnails",
        "Hide link thumbnails",
        true,
      ),
      cb(
        "sm-hide-viewer-count",
        "streamerMode.hideViewerCountAndDuration",
        "Hide viewer count and stream length while hovering over split header",
        false,
      ),
      cb(
        "sm-hide-mod-actions",
        "streamerMode.hideModActions",
        "Hide moderation actions",
        true,
      ),
      cb(
        "sm-hide-restricted",
        "streamerMode.hideRestrictedUsers",
        "Hide messages from restricted users",
        true,
      ),
      cb(
        "sm-hide-blocked-terms",
        "streamerMode.hideBlockedTermText",
        "Hide blocked terms",
        true,
      ),
      cb(
        "sm-hide-notes",
        "streamerMode.hideUserNotes",
        "Hide user notes",
        true,
      ),
      cb(
        "sm-mute-mentions",
        "streamerMode.muteMentions",
        "Mute mention sounds",
        true,
      ),
      cb(
        "sm-suppress-live",
        "streamerMode.suppressLiveNotifications",
        "Suppress Live Notifications",
        false,
      ),
      cb(
        "sm-suppress-whispers",
        "streamerMode.suppressInlineWhispers",
        "Suppress Inline Whispers",
        true,
      ),
    ],
  },
  {
    title: "Link Previews",
    knobs: [
      cb("link-info", "links.linkInfoTooltip", "Enable", false),
      sel(
        "thumbnail-size",
        "appearance.thumbnailSize",
        "Also show thumbnails if available",
        THUMB_SIZE,
        "0",
      ),
      sel(
        "thumbnail-stream",
        "appearance.thumbnailSizeStream",
        "Show thumbnails of streams",
        THUMB_STREAM,
        "2",
      ),
    ],
  },
  {
    title: "Beta",
    knobs: [
      cb("beta-updates", "misc.betaUpdates", "Receive beta updates", false),
    ],
  },
  {
    title: "Browser Integration",
    knobs: [
      cb(
        "attach-any-browser",
        "misc.attachExtensionToAnyProcess",
        "Attach to any browser (may cause issues)",
        false,
      ),
      txt(
        "extra-extension-ids",
        "misc.additionalExtensionIDs",
        "Extra extension IDs",
        "",
      ),
      txt(
        "custom-manifest-path",
        "misc.customNativeMessagingManifestPath",
        "Custom manifest path",
        "",
      ),
      sel(
        "custom-manifest-format",
        "misc.customNativeMessagingManifestFormat",
        "Custom manifest format",
        MANIFEST_FORMAT,
        "Chrome",
      ),
    ],
  },
  {
    title: "AppData & Cache",
    knobs: [
      lab(
        "appdata-section",
        "__label.appData",
        "Application Data",
        "All local files like settings and cache files are stored in this directory.",
      ),
      btn("__action.openAppData", "__action.openAppData", "Open AppData directory"),
      lab(
        "cache-section",
        "__label.cache",
        "Temporary files (Cache)",
        "Files that are used often (such as emotes) are saved to disk to reduce bandwidth usage and to speed up loading.",
      ),
      lab("cache-path-display", "__label.cachePathDisplay", "Cache path", ""),
      btn("__action.chooseCachePath", "__action.chooseCachePath", "Choose cache path"),
      btn("__action.resetCachePath", "__action.resetCachePath", "Reset"),
      btn("__action.clearCache", "__action.clearCache", "Clear Cache"),
    ],
  },
  {
    title: "Sound",
    knobs: [
      sel(
        "sound-backend",
        "sound.backend",
        "Sound backend (requires restart)",
        SOUND_BACKEND,
        "Miniaudio",
      ),
      cb(
        "sound-keep-alive",
        "sound.miniaudioKeepEngineAlive",
        "Keep sound backend alive (requires restart)",
        false,
      ),
    ],
  },
  {
    title: "Chat title",
    knobs: [
      cb("header-uptime", "appearance.headerUptime", "Uptime", false),
      cb(
        "header-viewer-count",
        "appearance.headerViewerCount",
        "Viewer count",
        false,
      ),
      cb("header-game", "appearance.headerGame", "Category", false),
      cb("header-title", "appearance.headerStreamTitle", "Title", false),
    ],
  },
  {
    title: "Unique chat (R9K)",
    knobs: [
      cb(
        "similarity-enabled",
        "similarity.similarityEnabled",
        "Enable similarity checks",
        false,
      ),
      cb(
        "similarity-same-user",
        "similarity.hideSimilarBySameUser",
        "Only if by the same user",
        true,
      ),
      cb(
        "similarity-myself",
        "similarity.hideSimilarMyself",
        "Hide my own messages",
        false,
      ),
      cb(
        "similarity-sounds",
        "similarity.shownSimilarTriggerHighlights",
        "Receive notification sounds from hidden messages",
        false,
      ),
      sel(
        "similarity-threshold",
        "similarity.similarityPercentage",
        "Similarity threshold",
        SIMILARITY_PCT,
        "0.9",
      ),
      sel(
        "similarity-delay",
        "similarity.hideSimilarMaxDelay",
        "Maximum delay between messages",
        SIMILARITY_DELAY,
        "5",
      ),
      sel(
        "similarity-check-count",
        "similarity.hideSimilarMaxMessagesToCheck",
        "Amount of previous messages to check",
        SIMILARITY_CHECK,
        "3",
      ),
    ],
  },
  {
    title: "Visible badges",
    knobs: [
      cb(
        "badge-authority",
        "appearance.showBadgesGlobalAuthority",
        "Authority",
        true,
        "staff admin",
      ),
      cb(
        "badge-predictions",
        "appearance.showBadgesPredictions",
        "Predictions",
        true,
      ),
      cb(
        "badge-channel",
        "appearance.showBadgesChannelAuthority",
        "Channel",
        true,
        "broadcaster moderator",
      ),
      cb(
        "badge-sub",
        "appearance.showBadgesSubscription",
        "Subscriber",
        true,
      ),
      cb(
        "badge-vanity",
        "appearance.showBadgesVanity",
        "Vanity",
        true,
        "prime bits sub gifter",
      ),
      cb(
        "badge-chatterino",
        "appearance.showBadgesChatterino",
        "Chatterino",
        true,
      ),
      cb(
        "badge-ffz",
        "appearance.showBadgesFfz",
        "FrankerFaceZ",
        true,
        "ffz",
      ),
      cb(
        "badge-7tv",
        "appearance.showBadgesSevenTV",
        "7TV",
        true,
        "seventv",
      ),
      cb("badge-bttv", "appearance.showBadgesBttv", "BetterTTV", true, "bttv"),
      cb(
        "badge-ffz-mod",
        "appearance.useCustomFfzModeratorBadges",
        "Use custom FrankerFaceZ moderator badges",
        true,
        "ffz",
      ),
      cb(
        "badge-ffz-vip",
        "appearance.useCustomFfzVipBadges",
        "Use custom FrankerFaceZ VIP badges",
        true,
        "ffz",
      ),
    ],
  },
  {
    title: "Overlay",
    knobs: [
      sel(
        "overlay-zoom",
        "appearance.overlayScaleFactor",
        "Zoom factor",
        ZOOM_LEVELS,
        "1",
      ),
      num(
        "overlay-bg-opacity",
        "appearance.overlayBackgroundOpacity",
        "Background opacity (0-255)",
        50,
        0,
        255,
        1,
      ),
      cb(
        "overlay-shadow",
        "appearance.enableOverlayShadow",
        "Enable Shadow",
        true,
      ),
      num(
        "overlay-shadow-opacity",
        "appearance.overlayShadowOpacity",
        "Shadow opacity (0-255)",
        255,
        0,
        255,
        1,
      ),
      col(
        "overlay-shadow-color",
        "appearance.overlayShadowColor",
        "Shadow color",
        "#000",
      ),
      num(
        "overlay-shadow-radius",
        "appearance.overlayShadowRadius",
        "Shadow radius",
        8,
        0,
        40,
        1,
      ),
      num(
        "overlay-shadow-x",
        "appearance.overlayShadowOffsetX",
        "Shadow offset x",
        2,
        -20,
        20,
        1,
      ),
      num(
        "overlay-shadow-y",
        "appearance.overlayShadowOffsetY",
        "Shadow offset y",
        2,
        -20,
        20,
        1,
      ),
    ],
  },
  {
    title: "Search",
    knobs: [
      cb(
        "search-enabled",
        "behaviour.searchEnabled",
        "Enable search in right-click context menu",
        false,
      ),
      sel(
        "search-preset",
        "behaviour.searchEnginePreset",
        "Search engine preset",
        SEARCH_PRESET,
        "",
      ),
      txt(
        "search-url",
        "behaviour.searchEngineUrl",
        "Search engine URL",
        "",
      ),
      txt(
        "search-name",
        "behaviour.searchEngineName",
        "Search engine name",
        "",
      ),
      cb(
        "search-incognito",
        "behaviour.searchIncognito",
        "Search in incognito/private mode",
        false,
      ),
    ],
  },
  {
    title: "Miscellaneous",
    knobs: [
      cb(
        "open-links-incognito",
        "misc.openLinksIncognito",
        "Open links in incognito/private mode",
        false,
      ),
      cb(
        "restart-on-crash",
        "misc.restartOnCrash",
        "Restart on crash (requires restart)",
        false,
      ),
      cb(
        "show-moderation-messages",
        "appearance.hideModerationActions",
        "Show moderation messages",
        false,
        undefined,
        true,
      ),
      cb(
        "show-deletion-actions",
        "appearance.hideDeletionActions",
        "Show deletions of single messages",
        false,
        undefined,
        true,
      ),
      cb(
        "colorize-nicknames",
        "appearance.colorizeNicknames",
        "Colorize users without color set (gray names)",
        true,
      ),
      cb(
        "mention-comma",
        "behaviour.mentionUsersWithComma",
        "Mention users with a comma",
        true,
      ),
      cb(
        "show-joins",
        "behaviour.showJoins",
        "Show joined users (< 1000 chatters)",
        false,
      ),
      cb(
        "show-parts",
        "behaviour.showParts",
        "Show parted users (< 1000 chatters)",
        false,
      ),
      cb(
        "auto-close-user",
        "behaviour.autoCloseUserPopup",
        "Automatically close user popup when it loses focus",
        true,
      ),
      cb(
        "auto-close-thread",
        "behaviour.autoCloseThreadPopup",
        "Automatically close reply thread popup when it loses focus",
        false,
      ),
      cb(
        "always-show-pinned",
        "behaviour.alwaysShowPinnedMessage",
        "Always show pinned channel message",
        false,
      ),
      cb(
        "lowercase-domains",
        "links.lowercaseDomains",
        "Lowercase domains (anti-phishing)",
        true,
      ),
      cb(
        "show-pronouns",
        "misc.showPronouns",
        "Show user's pronouns in user card",
        false,
      ),
      cb(
        "show-title-live",
        "misc.showTitleInLiveMessage",
        "Show stream title in live message",
        false,
      ),
      cb(
        "bold-usernames",
        "appearance.boldUsernames",
        "Bold @usernames",
        true,
      ),
      cb(
        "color-usernames",
        "appearance.colorUsernames",
        "Color @usernames",
        true,
      ),
      cb(
        "find-all-usernames",
        "appearance.findAllUsernames",
        "Try to find usernames without @ prefix",
        false,
      ),
      cb(
        "username-completion-menu",
        "behaviour.showUsernameCompletionMenu",
        "Show username autocompletion popup menu",
        true,
      ),
      cb(
        "always-include-broadcaster",
        "behaviour.alwaysIncludeBroadcasterInUserCompletions",
        "Always include broadcaster in user completions",
        true,
      ),
      sel(
        "username-style",
        "appearance.usernameDisplayMode",
        "Username style",
        USERNAME_STYLE,
        "UsernameAndLocalizedName",
      ),
      sel(
        "username-font-weight",
        "appearance.boldScale",
        "Username font weight",
        BOLD_SCALE,
        "63",
      ),
      cb(
        "links-double-click",
        "links.linksDoubleClickOnly",
        "Double click to open links and other elements in chat",
        false,
        "pause",
      ),
      cb("unshort-links", "links.unshortLinks", "Unshorten links", false),
      cb(
        "prefix-emote-completion",
        "behaviour.prefixOnlyEmoteCompletion",
        "Only search for emote autocompletion at the start of emote names",
        true,
      ),
      cb(
        "user-completion-at",
        "behaviour.userCompletionOnlyWithAt",
        "Only search for username autocompletion with an @",
        false,
      ),
      cb(
        "inline-whispers",
        "whispers.inlineWhispers",
        "Show Twitch whispers inline",
        true,
      ),
      cb(
        "highlight-inline-whispers",
        "whispers.highlightInlineWhispers",
        "Highlight received inline whispers",
        false,
      ),
      cb(
        "auto-sub-threads",
        "behaviour.autoSubToParticipatedThreads",
        "Automatically subscribe to participated reply threads",
        true,
      ),
      cb(
        "load-history",
        "misc.loadTwitchMessageHistoryOnConnect",
        "Load message history on connect",
        true,
      ),
      num(
        "history-limit",
        "misc.twitchMessageHistoryLimit",
        "Max number of history messages to load on connect",
        800,
        10,
        800,
        10,
      ),
      num(
        "scrollback-split",
        "misc.scrollbackSplitLimit",
        "Split message scrollback limit (requires restart)",
        1000,
        100,
        100000,
        100,
      ),
      num(
        "scrollback-usercard",
        "misc.scrollbackUsercardLimit",
        "Usercard scrollback limit",
        1000,
        100,
        100000,
        100,
      ),
      sel(
        "blocked-term-automod",
        "moderation.showBlockedTermAutomodMessages",
        "Show blocked term automod messages",
        SHOW_MOD_STATE,
        "Always",
      ),
      sel(
        "stack-timeouts",
        "moderation.timeoutStackStyle",
        "Stack timeouts",
        TIMEOUT_STACK,
        "1",
      ),
      cb(
        "stack-bits",
        "emotes.stackBits",
        "Combine multiple bit tips into one",
        false,
      ),
      cb(
        "highlight-mentions-tab",
        "highlighting.highlightMentions",
        "Messages in /mentions highlights tab",
        true,
      ),
      cb(
        "strip-reply-mention",
        "appearance.stripReplyMention",
        "Strip leading mention in replies",
        true,
      ),
      sel(
        "chat-send-protocol",
        "misc.chatSendProtocol",
        "Chat send protocol",
        CHAT_SEND,
        "Default",
      ),
      cb(
        "show-send-button",
        "ui.showSendButton",
        "Show send message button",
        false,
      ),
      cb(
        "disable-tab-rename",
        "behaviour.disableTabRenamingOnClick",
        "Disable renaming of tabs on double-click",
        false,
      ),
      num(
        "shared-chat-refresh",
        "behaviour.sharedChatSessionRefreshInterval",
        "Shared chat session status refresh interval",
        60,
        5,
        999,
        1,
      ),
      cb(
        "shared-chat-badge",
        "behaviour.sharedChatAlwaysShowBadge",
        "Show shared chat badge for all messages",
        true,
      ),
    ],
  },
];

export const SETTINGS_PAGES: PageDef[] = [
  {
    id: "general",
    title: "General",
    navLabel: "General",
    search: "general interface chat messages emotes streamer zoom theme",
    kind: "knobs",
    sections: GENERAL_SECTIONS,
  },
  {
    id: "accounts",
    title: "Accounts",
    navLabel: "Accounts",
    search: "accounts login twitch",
    kind: "accounts",
  },
  {
    id: "nicknames",
    title: "Nicknames",
    navLabel: "Nicknames",
    search: "nicknames username alias regex",
    kind: "table",
    table: NICKNAMES_TABLE,
  },
  {
    id: "commands",
    title: "Commands",
    navLabel: "Commands",
    search: "commands trigger custom",
    kind: "table",
    table: COMMANDS_TABLE,
  },
  {
    id: "highlights",
    title: "Highlights",
    navLabel: "Highlights",
    search: "highlights ping sound flash mentions badges blacklist",
    kind: "nested-tabs",
    tabs: [
      {
        id: "messages",
        label: "Messages",
        table: HIGHLIGHT_MESSAGES_TABLE,
      },
      {
        id: "users",
        label: "Users",
        table: HIGHLIGHT_USERS_TABLE,
      },
      {
        id: "badges",
        label: "Badges",
        table: HIGHLIGHT_BADGES_TABLE,
      },
      {
        id: "blacklist",
        label: "Blacklisted Users",
        table: HIGHLIGHT_BLACKLIST_TABLE,
      },
    ],
    sections: [
      {
        title: "Self",
        knobs: [
          cb(
            "enable-self-highlight",
            "__wired.enableSelfHighlight",
            "Highlight messages containing your name",
            true,
            "self nick username",
          ),
          cb(
            "enable-self-highlight-sound",
            "highlighting.enableSelfHighlightSound",
            "Play sound when your name is mentioned",
            true,
            "self sound ping",
          ),
          txt(
            "self-highlight-color",
            "highlighting.selfHighlightColor",
            "Self highlight color",
            "",
            "self color #RRGGBB",
          ),
          cb(
            "enable-self-message-highlight",
            "highlighting.enableSelfMessageHighlight",
            "Highlight your own messages",
            false,
            "self message own",
          ),
          txt(
            "self-message-highlight-color",
            "highlighting.selfMessageHighlightColor",
            "Self message highlight color",
            "",
            "self message color #RRGGBB",
          ),
        ],
      },
      {
        title: "Default sound",
        knobs: [
          txt(
            "highlight-default-sound",
            "highlighting.pathHighlightSound",
            "Default sound",
            "",
            "sound path wav",
          ),
          btn(
            "highlight-sound-change",
            "__action.highlightSoundChange",
            "Change...",
          ),
          btn(
            "highlight-sound-clear",
            "__action.highlightSoundClear",
            "Clear",
          ),
          cb(
            "highlight-always-play",
            "highlighting.highlightAlwaysPlaySound",
            "Play highlight sound even when Chatterino is focused",
            false,
          ),
          cb(
            "highlight-long-alerts",
            "highlighting.longAlerts",
            "Flash taskbar only stops highlighting when Chatterino is focused",
            false,
          ),
        ],
      },
      {
        title: "Extra message kinds",
        knobs: [
          cb(
            "enable-sub-highlight",
            "highlighting.enableSubHighlight",
            "Highlight subscriptions / resubs / gifts",
            true,
            "sub resub gift scrollbar",
          ),
          txt(
            "sub-highlight-color",
            "highlighting.subHighlightColor",
            "Subscription highlight color",
            "",
            "sub color",
          ),
          cb(
            "enable-first-message-highlight",
            "highlighting.enableFirstMessageHighlight",
            "Highlight first messages in a channel",
            true,
            "first-msg scrollbar",
          ),
          txt(
            "first-message-highlight-color",
            "highlighting.firstMessageHighlightColor",
            "First message highlight color",
            "",
            "first color",
          ),
          cb(
            "enable-redeemed-highlight",
            "highlighting.enableRedeemedHighlight",
            "Highlight redeemed channel point messages",
            true,
            "redeem reward scrollbar",
          ),
          txt(
            "redeemed-highlight-color",
            "highlighting.redeemedHighlightColor",
            "Redeemed highlight color",
            "",
            "redeem color",
          ),
        ],
      },
    ],
  },
  {
    id: "ignores",
    title: "Ignores",
    navLabel: "Ignores",
    search: "ignores block filter phrases blocked users",
    kind: "nested-tabs",
    tabs: [
      {
        id: "messages",
        label: "Messages",
        table: IGNORE_MESSAGES_TABLE,
      },
      {
        id: "users",
        label: "Users",
        table: IGNORE_USERS_TABLE,
        sections: [
          {
            title: "Twitch blocked users",
            knobs: [
              cb(
                "enable-twitch-blocked",
                "ignore.enableTwitchBlockedUsers",
                "Enable Twitch blocked users",
                true,
              ),
              sel(
                "show-blocked-messages",
                "ignore.showBlockedUsersMessages",
                "Show messages from blocked users",
                BLOCKED_SHOW,
                "0",
              ),
              lab(
                "blocked-users-list",
                "__label.twitchBlockedUsers",
                "List of blocked users (Twitch block list is separate from ignore table above)",
                "",
              ),
            ],
          },
        ],
      },
    ],
  },
  {
    id: "filters",
    title: "Filters",
    navLabel: "Filters",
    search: "filters expression",
    kind: "table",
    table: FILTERS_TABLE,
    sections: [
      {
        title: "Options",
        knobs: [
          cb(
            "exclude-own-from-filter",
            "filtering.excludeUserMessagesFromFilter",
            "Do not filter my own messages",
            false,
          ),
        ],
      },
    ],
  },
  {
    id: "hotkeys",
    title: "Hotkeys",
    navLabel: "Hotkeys",
    search: "hotkeys shortcuts keybinding",
    kind: "hotkeys",
    table: HOTKEYS_TABLE,
    sections: [
      {
        title: "Defaults",
        knobs: [
          btn(
            "reset-hotkeys",
            "__action.resetHotkeys",
            "Reset to defaults",
          ),
        ],
      },
    ],
  },
  {
    id: "moderation",
    title: "Moderation",
    navLabel: "Moderation",
    search: "moderation logs timeout buttons",
    kind: "nested-tabs",
    tabs: [
      {
        id: "logs",
        label: "Logs",
        sections: [
          {
            title: "Logging",
            knobs: [
              cb(
                "enable-logging",
                "logging.enableLogging",
                "Enable logging",
                false,
              ),
              txt("log-path-display", "logging.logPath", "Log directory", ""),
              btn(
                "select-log-dir",
                "__action.selectLogDirectory",
                "Select log directory",
              ),
              btn("reset-log-dir", "__action.resetLogDirectory", "Reset"),
              sel(
                "log-timestamp",
                "logging.logTimestampFormat",
                "Log file timestamp format",
                TIMESTAMP_FORMATS,
                "hh:mm:ss",
              ),
              cb(
                "use-twitch-timestamps",
                "logging.tryUseTwitchTimestamps",
                "Use Twitch's timestamps",
                false,
              ),
              cb(
                "only-log-listed",
                "logging.onlyLogListedChannels",
                "Only log channels listed below",
                false,
              ),
              cb(
                "separate-stream-logs",
                "logging.separatelyStoreStreamLogs",
                "Store live stream logs as separate files",
                false,
              ),
            ],
          },
        ],
        table: LOG_CHANNELS_TABLE,
      },
      {
        id: "mod-buttons",
        label: "Moderation buttons",
        table: MOD_ACTIONS_TABLE,
      },
      {
        id: "timeout-buttons",
        label: "User Timeout Buttons",
        sections: [
          {
            title: "Timeout buttons",
            knobs: [
              num("timeout-btn-1-dur", "timeouts.button1.duration", "Button 1 duration", 1, 1, 99, 1),
              sel("timeout-btn-1-unit", "timeouts.button1.unit", "Button 1 unit", TIMEOUT_UNIT, "s"),
              num("timeout-btn-2-dur", "timeouts.button2.duration", "Button 2 duration", 30, 1, 99, 1),
              sel("timeout-btn-2-unit", "timeouts.button2.unit", "Button 2 unit", TIMEOUT_UNIT, "s"),
              num("timeout-btn-3-dur", "timeouts.button3.duration", "Button 3 duration", 1, 1, 99, 1),
              sel("timeout-btn-3-unit", "timeouts.button3.unit", "Button 3 unit", TIMEOUT_UNIT, "m"),
              num("timeout-btn-4-dur", "timeouts.button4.duration", "Button 4 duration", 5, 1, 99, 1),
              sel("timeout-btn-4-unit", "timeouts.button4.unit", "Button 4 unit", TIMEOUT_UNIT, "m"),
              num("timeout-btn-5-dur", "timeouts.button5.duration", "Button 5 duration", 30, 1, 99, 1),
              sel("timeout-btn-5-unit", "timeouts.button5.unit", "Button 5 unit", TIMEOUT_UNIT, "m"),
              num("timeout-btn-6-dur", "timeouts.button6.duration", "Button 6 duration", 1, 1, 99, 1),
              sel("timeout-btn-6-unit", "timeouts.button6.unit", "Button 6 unit", TIMEOUT_UNIT, "h"),
              num("timeout-btn-7-dur", "timeouts.button7.duration", "Button 7 duration", 1, 1, 99, 1),
              sel("timeout-btn-7-unit", "timeouts.button7.unit", "Button 7 unit", TIMEOUT_UNIT, "d"),
              num("timeout-btn-8-dur", "timeouts.button8.duration", "Button 8 duration", 1, 1, 99, 1),
              sel("timeout-btn-8-unit", "timeouts.button8.unit", "Button 8 unit", TIMEOUT_UNIT, "w"),
            ],
          },
        ],
      },
    ],
  },
  {
    id: "notifications",
    title: "Live Notifications",
    navLabel: "Live Notifications",
    search: "notifications live toast sound flash",
    kind: "nested-tabs",
    tabs: [
      {
        id: "options",
        label: "Options",
        sections: [
          {
            title: "Options",
            knobs: [
              cb(
                "notif-flash",
                "notifications.notificationFlashTaskbar",
                "Flash taskbar",
                false,
              ),
              cb(
                "notif-sound-selected",
                "notifications.notificationPlaySound",
                "Play sound for selected channels",
                false,
              ),
              cb(
                "notif-sound-any",
                "notifications.notificationOnAnyChannel",
                "Play sound for any channel going live",
                false,
              ),
              cb(
                "notif-suppress-startup",
                "notifications.suppressInitialLiveNotification",
                "Suppress live notifications on startup",
                false,
              ),
              cb(
                "notif-toast",
                "notifications.notificationToast",
                "Show notification",
                false,
              ),
              cb(
                "notif-shortcut",
                "notifications.createShortcutForToasts",
                "Create start menu shortcut (requires restart)",
                true,
              ),
              sel(
                "notif-click-action",
                "notifications.openFromToast",
                "Action when clicking on a notification",
                TOAST_REACTION,
                "OpenInBrowser",
              ),
              cb(
                "notif-custom-sound",
                "notifications.notificationCustomSound",
                "Custom sound",
                false,
              ),
              txt(
                "notif-sound-path",
                "notifications.notificationPathSound",
                "Custom sound file",
                "",
              ),
              btn(
                "notif-select-sound",
                "__action.selectNotificationSound",
                "Select custom sound file",
              ),
            ],
          },
        ],
      },
      {
        id: "selected-channels",
        label: "Selected Channels",
        table: NOTIFY_CHANNELS_TABLE,
      },
    ],
  },
  {
    id: "external",
    title: "External tools",
    navLabel: "External tools",
    search: "streamlink player image uploader external",
    kind: "knobs",
    sections: [
      {
        title: "Streamlink",
        knobs: [
          cb(
            "streamlink-custom-path",
            "external.streamlinkUseCustomPath",
            "Use custom path (Enable if using non-standard streamlink installation path)",
            false,
          ),
          txt(
            "streamlink-path",
            "external.streamlinkPath",
            "Custom streamlink path",
            "",
          ),
          sel(
            "streamlink-quality",
            "external.preferredQuality",
            "Preferred quality",
            STREAMLINK_QUALITY,
            "Choose",
          ),
          txt(
            "streamlink-opts",
            "external.streamlinkOpts",
            "Additional options",
            "",
          ),
        ],
      },
      {
        title: "Custom stream player",
        knobs: [
          txt(
            "custom-uri-scheme",
            "external.customURIScheme",
            "Custom stream player URI Scheme",
            "",
          ),
        ],
      },
      {
        title: "Image Uploader",
        knobs: [
          cb(
            "image-uploader-enabled",
            "external.imageUploaderEnabled",
            "Enable image uploader",
            false,
          ),
          cb(
            "image-uploader-ask",
            "misc.askOnImageUpload",
            "Ask for confirmation when uploading an image",
            true,
          ),
          txt(
            "image-uploader-url",
            "external.imageUploaderUrl",
            "Request URL",
            "",
          ),
          txt(
            "image-uploader-field",
            "external.imageUploaderFormField",
            "Form field",
            "",
          ),
          txt(
            "image-uploader-headers",
            "external.imageUploaderHeaders",
            "Extra Headers",
            "",
          ),
          txt(
            "image-uploader-link",
            "external.imageUploaderLink",
            "Image link",
            "",
          ),
          txt(
            "image-uploader-deletion",
            "external.imageUploaderDeletionLink",
            "Deletion link",
            "",
          ),
          btn(
            "image-uploader-import",
            "__action.importImageUploader",
            "Import Settings from Clipboard",
          ),
          btn(
            "image-uploader-export",
            "__action.exportImageUploader",
            "Export Settings to Clipboard",
          ),
        ],
      },
    ],
  },
  {
    id: "about",
    title: "About",
    navLabel: "About",
    search: "about version license chatterino rt",
    kind: "about",
  },
];

function collectKnobs(pages: PageDef[]): KnobDef[] {
  const out: KnobDef[] = [];
  for (const page of pages) {
    for (const section of page.sections ?? []) {
      out.push(...section.knobs);
    }
    for (const tab of page.tabs ?? []) {
      for (const section of tab.sections ?? []) {
        out.push(...section.knobs);
      }
    }
  }
  return out;
}

/** Defaults for AppSettings.knobs (excludes __wired and action/label controls). */
export function defaultKnobs(): Record<string, boolean | string | number> {
  const result: Record<string, boolean | string | number> = {};
  for (const knob of collectKnobs(SETTINGS_PAGES)) {
    if (knob.path.startsWith("__wired.") || knob.path.startsWith("__action.") || knob.path.startsWith("__label.")) {
      continue;
    }
    if (knob.type === "button" || knob.type === "label") {
      continue;
    }
    result[knob.path] = knob.defaultValue;
  }
  if (result["cache.path"] === undefined) {
    result["cache.path"] = "";
  }
  return result;
}

/** Empty table arrays matching AppSettings. */
export function defaultAppSettingsTables(): {
  nicknames: [];
  commands: [];
  highlightMessages: [];
  highlightUsers: [];
  highlightBadges: [];
  highlightBlacklist: [];
  ignoreMessages: [];
  ignoreUsers: [];
  filters: [];
  hotkeys: [];
  modActions: [];
  logChannels: [];
  notifyChannels: [];
} {
  return {
    nicknames: [],
    commands: [],
    highlightMessages: [],
    highlightUsers: [],
    highlightBadges: [],
    highlightBlacklist: [],
    ignoreMessages: [],
    ignoreUsers: [],
    filters: [],
    hotkeys: [],
    modActions: [],
    logChannels: [],
    notifyChannels: [],
  };
}
