import {
  indexToLineCol,
  lineColToIndex,
  renderWrapped,
  wrapBody,
} from "../src/chat/wrap.ts";

const text = "Kappa cvHazmat extra";
const emotes = [
  { start: 0, end: 5, zeroWidth: false },
  { start: 6, end: 14, zeroWidth: true },
];

const lines = wrapBody(text, 80, emotes);
if (lines.length !== 1 || lines[0].start !== 0 || lines[0].end !== text.length) {
  throw new Error("expected a single wrap line");
}

const rendered = renderWrapped(text, lines, emotes);
if (rendered.includes("cvHazmat")) {
  throw new Error("zero-width code must not occupy the bitmap line");
}
if (rendered.includes("Kappa")) {
  throw new Error("base emote code must be masked");
}
if (!rendered.endsWith("extra")) {
  throw new Error(`expected trailing extra, got ${JSON.stringify(rendered)}`);
}
if (rendered.length !== 11) {
  throw new Error(`collapsed overlay should be 11 visible units, got ${rendered.length}`);
}

const extra = indexToLineCol(text, lines, 15, emotes);
if (!extra || extra.line !== 0 || extra.col !== 6) {
  throw new Error(`extra should start at visual col 6, got ${JSON.stringify(extra)}`);
}

const hit = lineColToIndex(text, lines, 0, 6, emotes);
if (hit !== 15) {
  throw new Error(`col 6 should map back to extra, got ${hit}`);
}

const emojiText = "ab😀c";
const emojiLines = wrapBody(emojiText, 80, []);
const inner = lineColToIndex(emojiText, emojiLines, 0, 3, []);
if (inner !== 2) {
  throw new Error(`wide grapheme inner col should map to start, got ${inner}`);
}

const narrow = wrapBody(text, 6, emotes);
if (narrow.length < 2) {
  throw new Error("width 6 should wrap after stacked emote and its trailing space");
}
