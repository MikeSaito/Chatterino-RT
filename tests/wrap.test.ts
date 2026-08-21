import {
  indexToLineCol,
  lineColToIndex,
  renderWrapped,
  wrapBody,
} from "../src/chat/wrap.ts";
import { resolveEmoteUrl } from "../src/chat/emoteUrl.ts";

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

const wide = wrapBody(text, 80, emotes, { emoteMinCols: 8 });
const widePos = indexToLineCol(text, wide, 15, emotes, { emoteMinCols: 8 });
if (!widePos || widePos.col !== 9) {
  throw new Error(`emoteMinCols 8 should place extra at col 9, got ${JSON.stringify(widePos)}`);
}
const wideMask = renderWrapped(text, wide, emotes, { emoteMinCols: 8 });
if (wideMask.length !== 14) {
  throw new Error(`masked line with emoteMinCols 8 should be 14, got ${wideMask.length}`);
}

const noMask = renderWrapped(text, lines, emotes, { maskEmotes: false });
if (!noMask.includes("Kappa") || !noMask.includes("cvHazmat")) {
  throw new Error("maskEmotes false must keep emote codes visible");
}

// Как ring.wrapOpts: images off ⇒ ZW off, иначе visual ≠ bitmap length.
const imagesOff = { maskEmotes: false, enableZeroWidth: false } as const;
const imagesOffLines = wrapBody(text, 80, emotes, imagesOff);
const imagesOffMask = renderWrapped(text, imagesOffLines, emotes, imagesOff);
const imagesOffExtra = indexToLineCol(text, imagesOffLines, 15, emotes, imagesOff);
if (!imagesOffExtra || imagesOffExtra.col !== 15) {
  throw new Error(
    `images-off wrap must keep ZW columns, got ${JSON.stringify(imagesOffExtra)}`,
  );
}
if (imagesOffMask.length !== text.length) {
  throw new Error(
    `images-off mask length must equal text (${text.length}), got ${imagesOffMask.length}`,
  );
}

const noZw = wrapBody(text, 80, emotes, { enableZeroWidth: false });
const noZwRender = renderWrapped(text, noZw, emotes, { enableZeroWidth: false });
if (!noZwRender.includes(" ") || noZwRender.length <= 11) {
  throw new Error("ZW off should reserve columns for overlay code");
}
const noZwExtra = indexToLineCol(text, noZw, 15, emotes, { enableZeroWidth: false });
if (!noZwExtra || noZwExtra.col !== 15) {
  throw new Error(`ZW off extra at col 15, got ${JSON.stringify(noZwExtra)}`);
}

const twitch =
  "https://static-cdn.jtvnw.net/emoticons/v2/25/default/dark/1.0";
if (
  resolveEmoteUrl(twitch, false) !==
  "https://static-cdn.jtvnw.net/emoticons/v2/25/static/dark/1.0"
) {
  throw new Error("animate off must rewrite Twitch default→static");
}
if (resolveEmoteUrl(twitch, true) !== twitch) {
  throw new Error("animate on must keep Twitch URL");
}

const mentionText = "hi @verylongusernameok bye";
const mentionSpan = { start: 3, end: 22 };
const mentionOpts = { maskMentions: [mentionSpan] };
const mentionLines = wrapBody(mentionText, 10, [], mentionOpts);
const mentionMask = renderWrapped(mentionText, mentionLines, [], mentionOpts);
if (mentionMask.includes("@") || mentionMask.includes("verylong")) {
  throw new Error("maskMentions must replace mention with spaces");
}
let mentionVisual = 0;
for (const line of mentionLines) {
  mentionVisual += line.end - line.start;
}
const mentionMaskUnits = mentionMask.replace(/\n/g, "").length;
if (mentionMaskUnits !== mentionVisual) {
  throw new Error(
    `maskMentions lines must match source slices (${mentionVisual}), got ${mentionMaskUnits}`,
  );
}

const snapText = "aaaaaaaa @bob";
const snapSpan = { start: 9, end: 13 };
const snapOpts = { maskMentions: [snapSpan] };
const snapLines = wrapBody(snapText, 10, [], snapOpts);
const mid = snapLines.find((l) => l.start > snapSpan.start && l.start < snapSpan.end);
if (mid) {
  throw new Error("snapBeforeMention must keep short @login on one line");
}

console.log("wrap tests ok");

