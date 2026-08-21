import {
  indexToLineCol,
  lineColToIndex,
  renderWrapped,
  wrapBody,
} from "../src/chat/wrap.ts";
import { resolveEmojiUrl, resolveEmoteUrl } from "../src/chat/emoteUrl.ts";

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

const emojiTw = resolveEmojiUrl("1f600", "Twitter");
if (!emojiTw.includes("/twitter/64/1f600.png")) {
  throw new Error(`twitter emoji url, got ${emojiTw}`);
}
const emojiGo = resolveEmojiUrl("1f600", "Google");
if (!emojiGo.includes("/google/64/1f600.png") || emojiGo.includes("/twitter/")) {
  throw new Error(`google emoji url, got ${emojiGo}`);
}
if (resolveEmojiUrl("1f600", "nope").includes("/twitter/64/") === false) {
  throw new Error("unknown emoji set must fall back to Twitter");
}
const fbMissing = resolveEmojiUrl("00a9-fe0f", "Facebook");
if (!fbMissing.includes("/twitter/64/00a9-fe0f.png")) {
  throw new Error(`facebook missing must use twitter, got ${fbMissing}`);
}
const appleMissing = resolveEmojiUrl("2640-fe0f", "Apple");
if (!appleMissing.includes("/twitter/64/2640-fe0f.png")) {
  throw new Error(`apple missing must use twitter, got ${appleMissing}`);
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

const hugText = "Kappa PogChamp";
const hugEmotes = [
  { start: 0, end: 5, zeroWidth: false },
  { start: 6, end: 14, zeroWidth: false },
];
const hugOff = wrapBody(hugText, 80, hugEmotes);
const hugOffMask = renderWrapped(hugText, hugOff, hugEmotes);
const hugOffSecond = indexToLineCol(hugText, hugOff, 6, hugEmotes);
if (!hugOffSecond || hugOffSecond.col !== 6) {
  throw new Error(
    `hug off: second emote at col 6, got ${JSON.stringify(hugOffSecond)}`,
  );
}
if (hugOffMask.length !== hugText.length) {
  throw new Error(
    `hug off mask length ${hugOffMask.length} != ${hugText.length}`,
  );
}

const hugOnOpts = { removeSpacesBetweenEmotes: true } as const;
const hugOn = wrapBody(hugText, 80, hugEmotes, hugOnOpts);
const hugOnMask = renderWrapped(hugText, hugOn, hugEmotes, hugOnOpts);
const hugOnSecond = indexToLineCol(hugText, hugOn, 6, hugEmotes, hugOnOpts);
if (!hugOnSecond || hugOnSecond.col !== 5) {
  throw new Error(
    `hug on: second emote at col 5, got ${JSON.stringify(hugOnSecond)}`,
  );
}
if (hugOnMask.length !== hugText.length - 1) {
  throw new Error(
    `hug on mask should drop one space (${hugText.length - 1}), got ${hugOnMask.length}`,
  );
}
const hugHit = lineColToIndex(hugText, hugOn, 0, 5, hugEmotes, hugOnOpts);
if (hugHit !== 6) {
  throw new Error(`hug on col 5 should map to PogChamp start, got ${hugHit}`);
}

const doubleText = "Kappa  PogChamp";
const doubleEmotes = [
  { start: 0, end: 5, zeroWidth: false },
  { start: 7, end: 15, zeroWidth: false },
];
const doubleOpts = { removeSpacesBetweenEmotes: true } as const;
const doubleLines = wrapBody(doubleText, 80, doubleEmotes, doubleOpts);
const doubleSecond = indexToLineCol(
  doubleText,
  doubleLines,
  7,
  doubleEmotes,
  doubleOpts,
);
if (!doubleSecond || doubleSecond.col !== 7) {
  throw new Error(
    `double space: no hug when gap>1, second at col 7, got ${JSON.stringify(doubleSecond)}`,
  );
}

const hugZwText = "Kappa cvHazmat PogChamp";
const hugZwEmotes = [
  { start: 0, end: 5, zeroWidth: false },
  { start: 6, end: 14, zeroWidth: true },
  { start: 15, end: 23, zeroWidth: false },
];
const hugZwOpts = { removeSpacesBetweenEmotes: true } as const;
const hugZwLines = wrapBody(hugZwText, 80, hugZwEmotes, hugZwOpts);
const hugZwPos = indexToLineCol(hugZwText, hugZwLines, 15, hugZwEmotes, hugZwOpts);
if (!hugZwPos || hugZwPos.col !== 5) {
  throw new Error(
    `ZW layer: hug space after stack, Pog at col 5, got ${JSON.stringify(hugZwPos)}`,
  );
}
const hugZwMask = renderWrapped(hugZwText, hugZwLines, hugZwEmotes, hugZwOpts);
if (hugZwMask.includes("cvHazmat")) {
  throw new Error("hug must not break ZW collapse");
}

const hugWrapOpts = {
  removeSpacesBetweenEmotes: true,
  emoteMinCols: 7,
} as const;
const hugWrapText = "Kappa PogChamp";
const hugWrapEmotes = [
  { start: 0, end: 5, zeroWidth: false },
  { start: 6, end: 14, zeroWidth: false },
];
const hugWrapLines = wrapBody(hugWrapText, 10, hugWrapEmotes, hugWrapOpts);
if (hugWrapLines.length < 2) {
  throw new Error("narrow wrap should put second emote on next line");
}
const hugWrapMask = renderWrapped(hugWrapText, hugWrapLines, hugWrapEmotes, hugWrapOpts);
const hugWrapFirst = hugWrapMask.split("\n")[0] ?? "";
if (hugWrapFirst.length !== 8) {
  throw new Error(
    `same-line: first line keeps trailing space (7+1=8), got ${hugWrapFirst.length}`,
  );
}
const hugWrapSecond = indexToLineCol(
  hugWrapText,
  hugWrapLines,
  6,
  hugWrapEmotes,
  hugWrapOpts,
);
if (!hugWrapSecond || hugWrapSecond.line !== 1 || hugWrapSecond.col !== 0) {
  throw new Error(
    `wrapped second emote at line1 col0, got ${JSON.stringify(hugWrapSecond)}`,
  );
}

const hugImagesOff = {
  removeSpacesBetweenEmotes: true,
  maskEmotes: false,
  enableZeroWidth: false,
} as const;
const hugOffLines = wrapBody(hugText, 80, hugEmotes, hugImagesOff);
const hugOffPos = indexToLineCol(hugText, hugOffLines, 6, hugEmotes, hugImagesOff);
if (!hugOffPos || hugOffPos.col !== 6) {
  throw new Error(
    `images off must not hug spaces, got ${JSON.stringify(hugOffPos)}`,
  );
}

import { isScrollbarMarkColor } from "../src/chat/scrollUi.ts";
if (!isScrollbarMarkColor("#7f3f4980") || !isScrollbarMarkColor("#aabbcc")) {
  throw new Error("scrollbar mark color must accept #RRGGBB(AA)");
}
if (isScrollbarMarkColor("red") || isScrollbarMarkColor("#fff")) {
  throw new Error("scrollbar mark color must reject non-hex CSS names / short hex");
}

console.log("wrap tests ok");

