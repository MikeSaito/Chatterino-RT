import { webDarkTheme, webLightTheme } from "@fluentui/tokens";
import { hexToPixi } from "./themeContrast.ts";

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
  primary: string;
  primaryHover: string;
  primaryText: string;
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

type CssOnly = ThemeCssTokens & {
  hoverAlpha: number;
  alternateAlpha?: number;
  disabledAlpha?: number;
};

function buildTokens(css: CssOnly): ThemeTokens {
  const {
    hoverAlpha,
    alternateAlpha = 1,
    disabledAlpha = 0x99 / 255,
    ...rest
  } = css;
  return {
    ...rest,
    pixi: {
      canvasBg: hexToPixi(rest.splitBg),
      body: hexToPixi(rest.windowText),
      timestamp: hexToPixi(rest.muted),
      nickFallback: hexToPixi(rest.muted),
      alternate: hexToPixi(rest.surface1),
      alternateAlpha,
      hover: hexToPixi(rest.surface2),
      hoverAlpha,
      separator: hexToPixi(rest.border),
      disabled: hexToPixi(rest.splitBg),
      disabledAlpha,
    },
  };
}

export function isDarkTheme(preset: ThemePresetName): boolean {
  return preset === "Dark" || preset === "Black";
}

function fluentTokens(preset: ThemePresetName): ThemeTokens {
  const dark = isDarkTheme(preset);
  const palette = dark ? webDarkTheme : webLightTheme;
  const surface1 = palette.colorNeutralBackground1;
  const surface2 = palette.colorNeutralBackground3;
  const windowBg = palette.colorNeutralBackground2;
  const text = palette.colorNeutralForeground1;
  const border = palette.colorNeutralStroke2;
  const tokens: CssOnly = {
    windowBg,
    windowText: text,
    splitBg: windowBg,
    border,
    muted: palette.colorNeutralForeground3,
    inputBg: surface1,
    inputText: text,
    headerBg: surface1,
    headerBorder: border,
    headerText: text,
    scrollThumb: palette.colorNeutralStroke1,
    surface1,
    surface2,
    surface3: palette.colorNeutralBackground3Hover,
    accent: palette.colorBrandForeground1,
    accentHover: palette.colorBrandForegroundLinkHover,
    accentText: dark ? surface2 : palette.colorNeutralForegroundOnBrand,
    primary: palette.colorBrandBackground,
    primaryHover: palette.colorBrandBackgroundHover,
    primaryText: palette.colorNeutralForegroundOnBrand,
    success: dark ? "#5ed6a2" : "#2e8b3a",
    danger: dark ? "#ff838d" : "#c93a3a",
    warning: dark ? "#f0be6d" : "#a87022",
    focusRing: palette.colorStrokeFocus2,
    hoverAlpha: dark ? 0.35 : 0.45,
  };

  if (preset === "Black") {
    return buildTokens({
      ...tokens,
      windowBg: "#000000",
      splitBg: "#050505",
      headerBg: "#101010",
      inputBg: "#141414",
      surface1: "#121212",
      surface2: "#1a1a1a",
      surface3: "#242424",
    });
  }
  if (preset === "White") {
    return buildTokens({ ...tokens, windowBg: surface1, splitBg: surface1, surface1: surface2 });
  }
  return buildTokens(tokens);
}

const BUILTIN: Record<ThemePresetName, ThemeTokens> = {
  Dark: fluentTokens("Dark"),
  Black: fluentTokens("Black"),
  Light: fluentTokens("Light"),
  White: fluentTokens("White"),
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

export function listThemePresets(): ThemePresetName[] {
  return ["Dark", "Black", "Light", "White"];
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
  root.style.setProperty("--c-primary", tokens.primary);
  root.style.setProperty("--c-primary-hover", tokens.primaryHover);
  root.style.setProperty("--c-primary-text", tokens.primaryText);
  root.style.setProperty("--c-success", tokens.success);
  root.style.setProperty("--c-danger", tokens.danger);
  root.style.setProperty("--c-warning", tokens.warning);
  root.style.setProperty("--c-focus-ring", tokens.focusRing);
}

/** Apply CSS vars and return tokens for the resolved preset. */
export function applyResolvedTheme(
  preset: ThemePresetName,
  root: HTMLElement = document.documentElement,
): ThemeTokens {
  const tokens = themeTokens(preset);
  applyThemeCss(tokens, root);
  root.style.colorScheme = isDarkTheme(preset) ? "dark" : "light";
  root.dataset.theme = preset;
  if (typeof document !== "undefined" && root === document.documentElement) {
    try {
      localStorage.setItem("crt-startup-colors", JSON.stringify({
        background: tokens.windowBg,
        foreground: tokens.windowText,
        scheme: root.style.colorScheme,
      }));
    } catch {
      // Theme changes still work when local storage is unavailable.
    }
  }
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
