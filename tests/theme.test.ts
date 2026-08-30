import {
  applyThemeCss,
  isThemePreset,
  parseArgb,
  resolveThemePreset,
  themeTokens,
} from "../src/shell/theme.ts";

function assert(cond: boolean, msg: string): void {
  if (!cond) {
    throw new Error(msg);
  }
}

assert(isThemePreset("Dark"), "Dark preset");
assert(!isThemePreset("System"), "System not preset");

assert(
  resolveThemePreset({
    theme: "Light",
    darkSystem: "Dark",
    lightSystem: "Light",
  }) === "Light",
  "direct Light",
);
assert(
  resolveThemePreset({
    theme: "System",
    darkSystem: "Black",
    lightSystem: "White",
    prefersDark: true,
  }) === "Black",
  "system dark → Black",
);
assert(
  resolveThemePreset({
    theme: "System",
    darkSystem: "Black",
    lightSystem: "White",
    prefersDark: false,
  }) === "White",
  "system light → White",
);
assert(
  resolveThemePreset({
    theme: "Nope",
    darkSystem: "Dark",
    lightSystem: "Light",
  }) === "Dark",
  "invalid → Dark",
);

const dark = themeTokens("Dark");
const light = themeTokens("Light");
assert(dark.pixi.body !== light.pixi.body, "Dark body ≠ Light body");
assert(dark.pixi.canvasBg !== light.pixi.canvasBg, "Dark canvas ≠ Light");
assert(light.pixi.body === 0x1a1a1a, "Light body dark");
assert(dark.pixi.body === 0xefeff1, "Dark body light");

const argb = parseArgb("#99191919");
assert(Math.abs(argb.alpha - 0x99 / 255) < 1e-6, "ARGB alpha");
assert(argb.color === 0x191919, `ARGB rgb got ${argb.color.toString(16)}`);

const rgb = parseArgb("#ffffff");
assert(rgb.alpha === 1 && rgb.color === 0xffffff, "RGB parse");

{
  const props = new Map<string, string>();
  const root = {
    style: {
      setProperty(key: string, value: string) {
        props.set(key, value);
      },
      getPropertyValue(key: string) {
        return props.get(key) ?? "";
      },
    },
  } as unknown as HTMLElement;
  applyThemeCss(light, root);
  const expected: Array<[string, string]> = [
    ["--c-window-bg", light.windowBg],
    ["--c-window-text", light.windowText],
    ["--c-split-bg", light.splitBg],
    ["--c-border", light.border],
    ["--c-muted", light.muted],
    ["--c-input-bg", light.inputBg],
    ["--c-input-text", light.inputText],
    ["--c-header-bg", light.headerBg],
    ["--c-header-border", light.headerBorder],
    ["--c-header-text", light.headerText],
    ["--c-scroll-thumb", light.scrollThumb],
    ["--c-surface-1", light.surface1],
    ["--c-surface-2", light.surface2],
    ["--c-surface-3", light.surface3],
    ["--c-accent", light.accent],
    ["--c-accent-hover", light.accentHover],
    ["--c-accent-text", light.accentText],
    ["--c-success", light.success],
    ["--c-danger", light.danger],
    ["--c-warning", light.warning],
    ["--c-focus-ring", light.focusRing],
  ];
  assert(props.size === expected.length, `css var count ${props.size}`);
  for (const [key, value] of expected) {
    assert(
      root.style.getPropertyValue(key) === value,
      `CSS ${key}`,
    );
  }
}

console.log("theme tests ok");
