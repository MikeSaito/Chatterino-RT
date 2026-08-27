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

if (typeof document !== "undefined") {
  applyThemeCss(light);
  assert(
    document.documentElement.style.getPropertyValue("--c-window-bg") ===
      light.windowBg,
    "CSS window bg",
  );
}

console.log("theme tests ok");
