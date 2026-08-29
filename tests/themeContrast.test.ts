import {
  WCAG_AA_TEXT,
  WCAG_AA_UI,
  contrastRatio,
  hexToPixi,
  passesAaText,
  passesAaUi,
} from "../src/shell/themeContrast.ts";
import { listThemePresets, themeTokens } from "../src/shell/theme.ts";

function assert(cond: boolean, msg: string): void {
  if (!cond) {
    throw new Error(msg);
  }
}

assert(hexToPixi("#efeff1") === 0xefeff1, "hexToPixi body");
assert(hexToPixi("#161616") === 0x161616, "hexToPixi canvas");
assert(Math.abs(contrastRatio("#000000", "#ffffff") - 21) < 0.01, "black/white 21");
assert(passesAaText("#1a1a1a", "#ffffff"), "text on white");
assert(!passesAaUi("#c98a2e", "#ffffff"), "old warning fails UI");

const TEXT_KEYS = ["windowText", "muted"] as const;
const UI_KEYS = ["accent", "danger", "success", "warning", "focusRing"] as const;

type BgKey = "windowBg" | "surface1" | "surface2" | "surface3";
const BGS: BgKey[] = ["windowBg", "surface1", "surface2", "surface3"];

for (const preset of listThemePresets()) {
  const t = themeTokens(preset);
  for (const bgKey of BGS) {
    const bg = t[bgKey];
    for (const key of TEXT_KEYS) {
      const fg = t[key];
      const ratio = contrastRatio(fg, bg);
      assert(
        passesAaText(fg, bg),
        `${preset} ${key} on ${bgKey}: ${ratio.toFixed(2)} < ${WCAG_AA_TEXT}`,
      );
    }
    for (const key of UI_KEYS) {
      const fg = t[key];
      const ratio = contrastRatio(fg, bg);
      assert(
        passesAaUi(fg, bg),
        `${preset} ${key} on ${bgKey}: ${ratio.toFixed(2)} < ${WCAG_AA_UI}`,
      );
    }
  }

  assert(t.pixi.canvasBg === hexToPixi(t.splitBg), `${preset} pixi canvasBg`);
  assert(t.pixi.body === hexToPixi(t.windowText), `${preset} pixi body`);
  assert(t.pixi.timestamp === hexToPixi(t.muted), `${preset} pixi timestamp`);
  assert(t.pixi.nickFallback === hexToPixi(t.muted), `${preset} pixi nick`);
  assert(t.pixi.alternate === hexToPixi(t.surface1), `${preset} pixi alternate`);
  assert(t.pixi.hover === hexToPixi(t.surface2), `${preset} pixi hover`);
  assert(t.pixi.separator === hexToPixi(t.border), `${preset} pixi separator`);
  assert(t.pixi.disabled === hexToPixi(t.splitBg), `${preset} pixi disabled`);
}

assert(themeTokens("Light").warning === "#a87022", "Light warning fixed");
assert(themeTokens("White").warning === "#a87022", "White warning fixed");

console.log("themeContrast tests ok");
