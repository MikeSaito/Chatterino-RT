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
  surface1: string;
  surface2: string;
  surface3: string;
  accent: string;
  accentHover: string;
  accentText: string;
  success: string;
  danger: string;
  warning: string;
  focusRing: string;
};

export type ThemePixiFills = {
  canvasBg: number;
  body: number;
  timestamp: number;
  nickFallback: number;
  alternate: number;
  alternateAlpha: number;
  /** Row hover fill (surface-2), alpha separate. */
  hover: number;
  hoverAlpha: number;
  separator: number;
  disabled: number;
  disabledAlpha: number;
};

export type ThemeTokens = ThemeCssTokens & {
  pixi: ThemePixiFills;
};

const BUILTIN: Record<ThemePresetName, ThemeTokens> = {
  Dark: {
    windowBg: "#0f0f0f",
    windowText: "#efeff1",
    splitBg: "#161616",
    border: "#2e2e2e",
    muted: "#9a9a9a",
    inputBg: "#1f1f1f",
    inputText: "#efeff1",
    headerBg: "#1a1a1a",
    headerBorder: "#2e2e2e",
    headerText: "#efeff1",
    scrollThumb: "#4a4a4a",
    surface1: "#1a1a1a",
    surface2: "#222222",
    surface3: "#2a2a2a",
    accent: "#9147ff",
    accentHover: "#772ce8",
    accentText: "#ffffff",
    success: "#3cba54",
    danger: "#e05555",
    warning: "#efad4e",
    focusRing: "#9147ff",
    pixi: {
      canvasBg: 0x161616,
      body: 0xefeff1,
      timestamp: 0x9a9a9a,
      nickFallback: 0x9a9a9a,
      alternate: 0x1c1c1c,
      alternateAlpha: 1,
      hover: 0x222222,
      hoverAlpha: 0.35,
      separator: 0x2e2e2e,
      disabled: 0x161616,
      disabledAlpha: 0x99 / 255,
    },
  },
  Black: {
    windowBg: "#000000",
    windowText: "#efeff1",
    splitBg: "#050505",
    border: "#1a1a1a",
    muted: "#8a8a8a",
    inputBg: "#0a0a0a",
    inputText: "#efeff1",
    headerBg: "#080808",
    headerBorder: "#1a1a1a",
    headerText: "#efeff1",
    scrollThumb: "#3a3a3a",
    surface1: "#0a0a0a",
    surface2: "#121212",
    surface3: "#1a1a1a",
    accent: "#9147ff",
    accentHover: "#772ce8",
    accentText: "#ffffff",
    success: "#3cba54",
    danger: "#e05555",
    warning: "#efad4e",
    focusRing: "#9147ff",
    pixi: {
      canvasBg: 0x000000,
      body: 0xefeff1,
      timestamp: 0x8a8a8a,
      nickFallback: 0x8a8a8a,
      alternate: 0x0a0a0a,
      alternateAlpha: 1,
      hover: 0x121212,
      hoverAlpha: 0.35,
      separator: 0x1a1a1a,
      disabled: 0x000000,
      disabledAlpha: 0x99 / 255,
    },
  },
  Light: {
    windowBg: "#f5f5f5",
    windowText: "#1a1a1a",
    splitBg: "#e8e8e8",
    border: "#d0d0d0",
    muted: "#5a5a5a",
    inputBg: "#ffffff",
    inputText: "#1a1a1a",
    headerBg: "#e0e0e0",
    headerBorder: "#d0d0d0",
    headerText: "#1a1a1a",
    scrollThumb: "#b0b0b0",
    surface1: "#ffffff",
    surface2: "#f0f0f0",
    surface3: "#e8e8e8",
    accent: "#9147ff",
    accentHover: "#772ce8",
    accentText: "#ffffff",
    success: "#2e8b3a",
    danger: "#c93a3a",
    warning: "#c98a2e",
    focusRing: "#9147ff",
    pixi: {
      canvasBg: 0xe8e8e8,
      body: 0x1a1a1a,
      timestamp: 0x5a5a5a,
      nickFallback: 0x5a5a5a,
      alternate: 0xdfdfdf,
      alternateAlpha: 1,
      hover: 0xd8d8d8,
      hoverAlpha: 0.45,
      separator: 0xb0b0b0,
      disabled: 0xe8e8e8,
      disabledAlpha: 0x99 / 255,
    },
  },
  White: {
    windowBg: "#ffffff",
    windowText: "#1a1a1a",
    splitBg: "#ffffff",
    border: "#e0e0e0",
    muted: "#5a5a5a",
    inputBg: "#f8f8f8",
    inputText: "#1a1a1a",
    headerBg: "#ffffff",
    headerBorder: "#e0e0e0",
    headerText: "#1a1a1a",
    scrollThumb: "#c0c0c0",
    surface1: "#ffffff",
    surface2: "#f8f8f8",
    surface3: "#f0f0f0",
    accent: "#9147ff",
    accentHover: "#772ce8",
    accentText: "#ffffff",
    success: "#2e8b3a",
    danger: "#c93a3a",
    warning: "#c98a2e",
    focusRing: "#9147ff",
    pixi: {
      canvasBg: 0xffffff,
      body: 0x1a1a1a,
      timestamp: 0x5a5a5a,
      nickFallback: 0x5a5a5a,
      alternate: 0xf5f5f5,
      alternateAlpha: 1,
      hover: 0xf0f0f0,
      hoverAlpha: 0.5,
      separator: 0xb0b0b0,
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
  root.style.setProperty("--c-surface-1", tokens.surface1);
  root.style.setProperty("--c-surface-2", tokens.surface2);
  root.style.setProperty("--c-surface-3", tokens.surface3);
  root.style.setProperty("--c-accent", tokens.accent);
  root.style.setProperty("--c-accent-hover", tokens.accentHover);
  root.style.setProperty("--c-accent-text", tokens.accentText);
  root.style.setProperty("--c-success", tokens.success);
  root.style.setProperty("--c-danger", tokens.danger);
  root.style.setProperty("--c-warning", tokens.warning);
  root.style.setProperty("--c-focus-ring", tokens.focusRing);
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
