import type { MessageRing } from "../../chat/ring";
import type { Filters } from "../../chat/types";
import { setChatAppBackground } from "../../pixi/app";
import { configureHighlightFlash } from "../highlightFlash";
import { configureHighlightSound } from "../highlightSound";
import { configureHotkeys } from "../hotkeys";
import {
  parseLastReadColor,
  parseLastReadPattern,
} from "../lastRead";
import {
  parseBoldScale,
  parseUsernameDisplayMode,
} from "../nickStyle";
import { normalizeNicknameRules } from "../nicknames";
import {
  configureStreamerMode,
  isStreamerModeActive,
  streamerModeState,
} from "../streamerMode";
import {
  applyResolvedTheme,
  resolveThemePreset,
} from "../theme";
import { applyWindowTopMost } from "../windowTopMost";
import {
  defaultAppSettingsTables,
  defaultKnobs,
} from "./catalog";
import { defaultHotkeyTableRows, normalizeHotkeyRows } from "../hotkeys";

export type AppSettings = {
  fontScale: number;
  showTimestamps: boolean;
  hideModerated: boolean;
  timestampFormat: string;
  knobs: Record<string, boolean | string | number | null>;
  nicknames: Record<string, string | boolean>[];
  commands: Record<string, string | boolean>[];
  highlightMessages: Record<string, string | boolean>[];
  highlightUsers: Record<string, string | boolean>[];
  highlightBadges: Record<string, string | boolean>[];
  highlightBlacklist: Record<string, string | boolean>[];
  ignoreMessages: Record<string, string | boolean>[];
  ignoreUsers: Record<string, string | boolean>[];
  filters: Record<string, string | boolean>[];
  enableSelfHighlight: boolean;
  hotkeys: Record<string, string | boolean>[];
  modActions: Record<string, string | boolean>[];
  logChannels: Record<string, string | boolean>[];
  notifyChannels: Record<string, string | boolean>[];
};

export function emptySettings(): AppSettings {
  return {
    fontScale: 1,
    showTimestamps: true,
    hideModerated: false,
    timestampFormat: "hh:mm",
    knobs: { ...defaultKnobs() },
    enableSelfHighlight: true,
    ...defaultAppSettingsTables(),
    hotkeys: defaultHotkeyTableRows(),
  };
}

export function tablePathGet(
  data: AppSettings,
  path: string,
): Record<string, string | boolean>[] {
  const key = path as keyof AppSettings;
  const value = data[key];
  return Array.isArray(value) ? (value as Record<string, string | boolean>[]) : [];
}

export function filtersFromSettings(data: AppSettings): Filters {
  return {
    enableSelfHighlight: data.enableSelfHighlight,
    ignoreLogins: data.ignoreUsers
      .filter((row) => row.regex !== true)
      .map((row) => String(row.username ?? "").trim())
      .filter(Boolean),
    ignorePhrases: data.ignoreMessages
      .filter((row) => row.block !== false)
      .map((row) => String(row.pattern ?? "").trim())
      .filter(Boolean),
    highlightPhrases: data.highlightMessages
      .map((row) => String(row.pattern ?? "").trim())
      .filter(Boolean),
    highlightLogins: data.highlightUsers
      .map((row) => String(row.username ?? "").trim())
      .filter(Boolean),
  };
}

export function migrateFiltersIntoSettings(
  data: AppSettings,
  filters: Filters,
): AppSettings {
  const next = { ...data, enableSelfHighlight: filters.enableSelfHighlight };
  if (next.highlightMessages.length === 0 && filters.highlightPhrases.length > 0) {
    next.highlightMessages = filters.highlightPhrases.map((pattern) => ({
      pattern,
      showInMentions: true,
      flashTaskbar: false,
      regex: false,
      caseSensitive: false,
      playSound: false,
      customSound: "",
      color: "",
    }));
  }
  if (next.highlightUsers.length === 0 && filters.highlightLogins.length > 0) {
    next.highlightUsers = filters.highlightLogins.map((username) => ({
      username,
      showInMentions: true,
      flashTaskbar: false,
      playSound: false,
      customSound: "",
      color: "",
    }));
  }
  if (next.ignoreMessages.length === 0 && filters.ignorePhrases.length > 0) {
    next.ignoreMessages = filters.ignorePhrases.map((pattern) => ({
      pattern,
      regex: false,
      caseSensitive: false,
      block: true,
      replacement: "",
    }));
  }
  if (next.ignoreUsers.length === 0 && filters.ignoreLogins.length > 0) {
    next.ignoreUsers = filters.ignoreLogins.map((username) => ({
      username,
      regex: false,
    }));
  }
  return next;
}

export function mergeLoadedSettings(
  loaded: AppSettings,
  filters: Filters,
): AppSettings {
  return migrateFiltersIntoSettings(
    {
      ...emptySettings(),
      ...loaded,
      knobs: { ...defaultKnobs(), ...(loaded.knobs ?? {}) },
      hotkeys: normalizeHotkeyRows(loaded.hotkeys ?? []).map((r) => ({
        action: r.action,
        keybinding: r.keybinding,
        name: r.name,
      })),
      enableSelfHighlight: filters.enableSelfHighlight,
    },
    filters,
  );
}

export function applySettingsDisplay(
  ring: MessageRing,
  data: AppSettings,
  onDisplay?: (data: AppSettings) => void,
): void {
  configureStreamerMode({
    mode: String(data.knobs["streamerMode.enabled"] ?? "DetectStreamingSoftware"),
    muteMentions: data.knobs["streamerMode.muteMentions"] !== false,
    hideModActions: data.knobs["streamerMode.hideModActions"] !== false,
    hideViewerCountAndDuration:
      data.knobs["streamerMode.hideViewerCountAndDuration"] === true,
  });
  const scaleRaw = Number(data.knobs["emotes.emoteScale"] ?? 1);
  const sm = streamerModeState();
  const hideMod =
    data.knobs["appearance.hideModerationActions"] === true ||
    (sm.active && sm.hideModActions);
  const hideDel = data.knobs["appearance.hideDeletionActions"] === true;
  const delLenRaw = Number(data.knobs["behaviour.deletedMessageLengthLimit"] ?? 50);
  const delLen = Number.isFinite(delLenRaw) ? delLenRaw : 50;
  const fadeHistory = data.knobs["appearance.fadeMessageHistory"] !== false;
  const hideTsLive = data.knobs["appearance.hideMessageTimestampsWhenLive"] === true;
  const preset = resolveThemePreset({
    theme: String(data.knobs["appearance.theme"] ?? "Dark"),
    darkSystem: String(data.knobs["appearance.darkSystemTheme"] ?? "Dark"),
    lightSystem: String(data.knobs["appearance.lightSystemTheme"] ?? "Light"),
  });
  const tokens = applyResolvedTheme(preset);
  ring.applyThemeFills(tokens.pixi);
  setChatAppBackground(tokens.pixi.canvasBg);
  const fontSizeRaw = Number(data.knobs["appearance.chatFontSize"] ?? 10);
  const fontWeightRaw = Number(data.knobs["appearance.chatFontWeight"] ?? 50);
  ring.configureChatFont({
    family: String(data.knobs["appearance.chatFontFamily"] ?? "Segoe UI"),
    size: Number.isFinite(fontSizeRaw) ? fontSizeRaw : 10,
    weight: Number.isFinite(fontWeightRaw) ? fontWeightRaw : 50,
  });
  ring.applyDisplay(
    data.fontScale,
    data.showTimestamps,
    data.hideModerated,
    data.timestampFormat,
    data.knobs["appearance.alternateMessages"] === true,
    data.knobs["appearance.separateMessages"] === true,
    Number(data.knobs["appearance.collpseMessagesMinLines"] ?? 0),
    hideMod,
    hideDel,
    delLen,
    fadeHistory,
    hideTsLive,
    data.knobs["appearance.showReplyButton"] !== false,
    data.knobs["links.linksDoubleClickOnly"] === true,
    {
      scale: Number.isFinite(scaleRaw) ? scaleRaw : 1,
      images: data.knobs["emotes.enableEmoteImages"] !== false,
      zeroWidth: data.knobs["emotes.enableZeroWidthEmotes"] !== false,
      animate: data.knobs["emotes.animateEmotes"] !== false,
      animateOnlyFocused: data.knobs["appearance.animationsWhenFocused"] === true,
      removeSpaces: data.knobs["emotes.removeSpacesBetweenEmotes"] === true,
      emojiSet: String(data.knobs["emotes.emojiSet"] ?? "Twitter"),
    },
  );
  const root = document.documentElement;
  root.style.setProperty("--chat-ui-scale", String(data.fontScale));
  configureHighlightSound({
    alwaysPlay: data.knobs["highlighting.highlightAlwaysPlaySound"] === true,
    path: String(data.knobs["highlighting.pathHighlightSound"] ?? ""),
    muted: isStreamerModeActive() && sm.muteMentions,
  });
  configureHighlightFlash({
    longAlerts: data.knobs["highlighting.longAlerts"] === true,
    muted: isStreamerModeActive() && sm.muteMentions,
  });
  configureHotkeys(data.hotkeys ?? []);
  const hoverRaw = Number(data.knobs["behaviour.pauseOnHoverDuration"] ?? 0);
  const multRaw = Number(data.knobs["behaviour.mouseScrollMultiplier"] ?? 1);
  ring.configureScrollBehaviour({
    pauseOnHoverSec: Number.isFinite(hoverRaw) ? hoverRaw : 0,
    pauseModifier: String(data.knobs["behaviour.pauseChatModifier"] ?? "None"),
    wheelMultiplier: Number.isFinite(multRaw) ? multRaw : 1,
    smoothScrolling: data.knobs["appearance.enableSmoothScrolling"] !== false,
    smoothScrollingNewMessages:
      data.knobs["appearance.enableSmoothScrollingNewMessages"] === true,
  });
  ring.configureLastReadIndicator({
    enabled: data.knobs["appearance.showLastMessageIndicator"] === true,
    pattern: parseLastReadPattern(data.knobs["appearance.lastMessagePattern"]),
    color: parseLastReadColor(data.knobs["appearance.lastMessageColor"]),
  });
  ring.configureBadgeVisibility({
    globalAuthority: data.knobs["appearance.showBadgesGlobalAuthority"] !== false,
    predictions: data.knobs["appearance.showBadgesPredictions"] !== false,
    channelAuthority: data.knobs["appearance.showBadgesChannelAuthority"] !== false,
    subscription: data.knobs["appearance.showBadgesSubscription"] !== false,
    vanity: data.knobs["appearance.showBadgesVanity"] !== false,
    chatterino: data.knobs["appearance.showBadgesChatterino"] !== false,
    ffz: data.knobs["appearance.showBadgesFfz"] !== false,
    bttv: data.knobs["appearance.showBadgesBttv"] !== false,
    sevenTv: data.knobs["appearance.showBadgesSevenTV"] !== false,
  });
  ring.configureLowercaseDomains(
    data.knobs["links.lowercaseDomains"] !== false,
  );
  ring.configureNickStyle({
    colorize: data.knobs["appearance.colorizeNicknames"] !== false,
    mode: parseUsernameDisplayMode(data.knobs["appearance.usernameDisplayMode"]),
    boldScale: parseBoldScale(data.knobs["appearance.boldScale"]),
  });
  ring.configureNicknames(normalizeNicknameRules(data.nicknames));
  ring.configureMentionStyle({
    bold: data.knobs["appearance.boldUsernames"] !== false,
    color: data.knobs["appearance.colorUsernames"] !== false,
  });
  ring.configureReplyContext({
    hide: data.knobs["appearance.hideReplyContext"] === true,
  });
  ring.configureStackBits(data.knobs["emotes.stackBits"] === true);
  applyWindowTopMost(data.knobs["appearance.windowTopMost"] === true);
  onDisplay?.(data);
}
