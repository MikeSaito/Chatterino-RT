/** Built-in Chatterino-like themes (values from stock theme JSON; not copied assets). */

export type ThemePresetName = "White" | "Light" | "Dark" | "Black";

export type ThemeCssTokens = {
  windowBg: string;
  windowText: string;
  splitBg: string;
  border: string;
  muted: string;
  inputBg: string;
  inputText: string;
  headerBg: string;
  headerBorder: string;
  headerText: string;
  scrollThumb: string;
};

export type ThemePixiFills = {
  canvasBg: number;
  body: number;
  timestamp: number;
  nickFallback: number;
  alternate: number;
  alternateAlpha: number;
  separator: number;
  disabled: number;
  disabledAlpha: number;
};

export type ThemeTokens = ThemeCssTokens & {
  pixi: ThemePixiFills;
};

const BUILTIN: Record<ThemePresetName, ThemeTokens> = {
  Dark: {
    windowBg: "#111111",
    windowText: "#ffffff",
    splitBg: "#191919",
    border: "#383838",
    muted: "#8c7f7f",
    inputBg: "#242424",
    inputText: "#ffffff",
    headerBg: "#2e2e2e",
    headerBorder: "#383838",
    headerText: "#ffffff",
    scrollThumb: "#575757",
    pixi: {
      canvasBg: 0x191919,
      body: 0xffffff,
      timestamp: 0x8c7f7f,
      nickFallback: 0x8c7f7f,
      alternate: 0x222222,
      alternateAlpha: 1,
      separator: 0x3c3c3c,
      disabled: 0x191919,
      disabledAlpha: 0x99 / 255,
    },
  },
  Black: {
    windowBg: "#040404",
    windowText: "#ffffff",
    splitBg: "#000000",
    border: "#2a2a2a",
    muted: "#8c7f7f",
    inputBg: "#080808",
    inputText: "#ffffff",
    headerBg: "#050505",
    headerBorder: "#1a1a1a",
    headerText: "#ffffff",
    scrollThumb: "#4d4d4d",
    pixi: {
      canvasBg: 0x000000,
      body: 0xffffff,
      timestamp: 0x8c7f7f,
      nickFallback: 0x8c7f7f,
      alternate: 0x0a0a0a,
      alternateAlpha: 1,
      separator: 0x3c3c3c,
      disabled: 0x000000,
      disabledAlpha: 0x99 / 255,
    },
  },
  Light: {
    windowBg: "#ffffff",
    windowText: "#000000",
    splitBg: "#e6e6e6",
    border: "#c8c8c8",
    muted: "#8c7f7f",
    inputBg: "#ffffff",
    inputText: "#000000",
    headerBg: "#dadada",
    headerBorder: "#c8c8c8",
    headerText: "#000000",
    scrollThumb: "#a0a0a0",
    pixi: {
      canvasBg: 0xe6e6e6,
      body: 0x000000,
      timestamp: 0x8c7f7f,
      nickFallback: 0x8c7f7f,
      alternate: 0xdddddd,
      alternateAlpha: 1,
      separator: 0x7f7f7f,
      disabled: 0xe6e6e6,
      disabledAlpha: 0x99 / 255,
    },
  },
  White: {
    windowBg: "#ffffff",
    windowText: "#000000",
    splitBg: "#ffffff",
    border: "#d0d0d0",
    muted: "#8c7f7f",
    inputBg: "#f2f2f2",
    inputText: "#000000",
    headerBg: "#ffffff",
    headerBorder: "#d0d0d0",
    headerText: "#000000",
    scrollThumb: "#b3b3b3",
    pixi: {
      canvasBg: 0xffffff,
      body: 0x000000,
      timestamp: 0x8c7f7f,
      nickFallback: 0x8c7f7f,
      alternate: 0xf5f5f5,
      alternateAlpha: 1,
      separator: 0x7f7f7f,
      disabled: 0xffffff,
      disabledAlpha: 0x99 / 255,
    },
  },
};

const PRESET_SET = new Set<string>(["White", "Light", "Dark", "Black"]);

export function isThemePreset(name: string): name is ThemePresetName {
  return PRESET_SET.has(name);
}

/** Parse stock ARGB `#AARRGGBB` or RGB `#RRGGBB`. */
export function parseArgb(hex: string): { color: number; alpha: number } {
  const raw = hex.trim().replace(/^#/, "");
  if (raw.length === 8) {
    const alpha = parseInt(raw.slice(0, 2), 16) / 255;
    const color = parseInt(raw.slice(2, 8), 16);
    return {
      color: Number.isFinite(color) ? color : 0,
      alpha: Number.isFinite(alpha) ? alpha : 1,
    };
  }
  if (raw.length === 6) {
    const color = parseInt(raw, 16);
    return { color: Number.isFinite(color) ? color : 0, alpha: 1 };
  }
  return { color: 0, alpha: 1 };
}

export function resolveThemePreset(opts: {
  theme: string;
  darkSystem: string;
  lightSystem: string;
  prefersDark?: boolean;
}): ThemePresetName {
  const theme = opts.theme.trim();
  if (theme === "System") {
    const dark = isThemePreset(opts.darkSystem) ? opts.darkSystem : "Dark";
    const light = isThemePreset(opts.lightSystem) ? opts.lightSystem : "Light";
    const prefersDark =
      opts.prefersDark ??
      (typeof matchMedia === "function"
        ? matchMedia("(prefers-color-scheme: dark)").matches
        : true);
    return prefersDark ? dark : light;
  }
  return isThemePreset(theme) ? theme : "Dark";
}

export function themeTokens(preset: ThemePresetName): ThemeTokens {
  return BUILTIN[preset];
}

export function applyThemeCss(tokens: ThemeTokens, root: HTMLElement = document.documentElement): void {
  root.style.setProperty("--c-window-bg", tokens.windowBg);
  root.style.setProperty("--c-window-text", tokens.windowText);
  root.style.setProperty("--c-split-bg", tokens.splitBg);
  root.style.setProperty("--c-border", tokens.border);
  root.style.setProperty("--c-muted", tokens.muted);
  root.style.setProperty("--c-input-bg", tokens.inputBg);
  root.style.setProperty("--c-input-text", tokens.inputText);
  root.style.setProperty("--c-header-bg", tokens.headerBg);
  root.style.setProperty("--c-header-border", tokens.headerBorder);
  root.style.setProperty("--c-header-text", tokens.headerText);
  root.style.setProperty("--c-scroll-thumb", tokens.scrollThumb);
}

/** Apply CSS vars and return tokens for the resolved preset. */
export function applyResolvedTheme(preset: ThemePresetName): ThemeTokens {
  const tokens = themeTokens(preset);
  applyThemeCss(tokens);
  document.documentElement.dataset.theme = preset;
  return tokens;
}

export function subscribeSystemTheme(onChange: () => void): () => void {
  if (typeof matchMedia !== "function") {
    return () => undefined;
  }
  const mq = matchMedia("(prefers-color-scheme: dark)");
  const handler = (): void => {
    onChange();
  };
  if (typeof mq.addEventListener === "function") {
    mq.addEventListener("change", handler);
    return () => mq.removeEventListener("change", handler);
  }
  mq.addListener(handler);
  return () => mq.removeListener(handler);
}
