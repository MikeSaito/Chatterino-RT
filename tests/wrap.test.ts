import {
  clipNick,
  collapseWrapLines,
  indexToLineCol,
  lineColToIndex,
  renderWrapped,
  withCollapsedEllipsis,
  wrapBody,
  wrapLineOriginX,
} from "../src/chat/wrap.ts";
import { resolveEmojiUrl, resolveEmoteUrl } from "../src/chat/emoteUrl.ts";

/** Deterministic px grid: 1 code unit = 1 px (BitmapFont stub). */
const adv = (s: string) => s.length;

const text = "Kappa cvHazmat extra";
const emotes = [
  { start: 0, end: 5, zeroWidth: false },
  { start: 6, end: 14, zeroWidth: true },
];

const lines = wrapBody(text, 80, emotes, { measureAdvance: adv });
if (lines.length !== 1 || lines[0].start !== 0 || lines[0].end !== text.length) {
  throw new Error("expected a single wrap line");
}

const rendered = renderWrapped(text, lines, emotes, { measureAdvance: adv });
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

const extra = indexToLineCol(text, lines, 15, emotes, { measureAdvance: adv });
if (!extra || extra.line !== 0 || extra.col !== 6) {
  throw new Error(`extra should start at visual col 6, got ${JSON.stringify(extra)}`);
}

const hit = lineColToIndex(text, lines, 0, 6, emotes, { measureAdvance: adv });
if (hit !== 15) {
  throw new Error(`col 6 should map back to extra, got ${hit}`);
}

const emojiText = "ab😀c";
const emojiLines = wrapBody(emojiText, 80, [], { measureAdvance: adv });
const inner = lineColToIndex(emojiText, emojiLines, 0, 3, [], {
  measureAdvance: adv,
});
if (inner !== 2) {
  throw new Error(`wide grapheme inner col should map to start, got ${inner}`);
}

const narrow = wrapBody(text, 6, emotes, { measureAdvance: adv });
if (narrow.length < 2) {
  throw new Error("width 6 should wrap after stacked emote and its trailing space");
}

const wideOpts = { measureAdvance: adv, emoteMinPx: 8 } as const;
const wide = wrapBody(text, 80, emotes, wideOpts);
const widePos = indexToLineCol(text, wide, 15, emotes, wideOpts);
if (!widePos || widePos.col !== 9) {
  throw new Error(`emoteMinPx 8 should place extra at col 9, got ${JSON.stringify(widePos)}`);
}
const wideMask = renderWrapped(text, wide, emotes, wideOpts);
if (wideMask.length !== 14) {
  throw new Error(`masked line with emoteMinPx 8 should be 14, got ${wideMask.length}`);
}

const noMask = renderWrapped(text, lines, emotes, {
  measureAdvance: adv,
  maskEmotes: false,
});
if (!noMask.includes("Kappa") || !noMask.includes("cvHazmat")) {
  throw new Error("maskEmotes false must keep emote codes visible");
}

const imagesOff = {
  measureAdvance: adv,
  maskEmotes: false,
  enableZeroWidth: false,
} as const;
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

const noZw = wrapBody(text, 80, emotes, {
  measureAdvance: adv,
  enableZeroWidth: false,
});
const noZwRender = renderWrapped(text, noZw, emotes, {
  measureAdvance: adv,
  enableZeroWidth: false,
});
if (!noZwRender.includes(" ") || noZwRender.length <= 11) {
  throw new Error("ZW off should reserve columns for overlay code");
}
const noZwExtra = indexToLineCol(text, noZw, 15, emotes, {
  measureAdvance: adv,
  enableZeroWidth: false,
});
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
const mentionOpts = { measureAdvance: adv, maskMentions: [mentionSpan] };
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
const snapOpts = { measureAdvance: adv, maskMentions: [snapSpan] };
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
const hugOff = wrapBody(hugText, 80, hugEmotes, { measureAdvance: adv });
const hugOffMask = renderWrapped(hugText, hugOff, hugEmotes, {
  measureAdvance: adv,
});
const hugOffSecond = indexToLineCol(hugText, hugOff, 6, hugEmotes, {
  measureAdvance: adv,
});
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

const hugOnOpts = {
  measureAdvance: adv,
  removeSpacesBetweenEmotes: true,
} as const;
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
const doubleOpts = {
  measureAdvance: adv,
  removeSpacesBetweenEmotes: true,
} as const;
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
const hugZwOpts = {
  measureAdvance: adv,
  removeSpacesBetweenEmotes: true,
} as const;
const hugZwLines = wrapBody(hugZwText, 80, hugZwEmotes, hugZwOpts);
const hugZwPos = indexToLineCol(
  hugZwText,
  hugZwLines,
  15,
  hugZwEmotes,
  hugZwOpts,
);
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
  measureAdvance: adv,
  removeSpacesBetweenEmotes: true,
  emoteMinPx: 7,
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
const hugWrapMask = renderWrapped(
  hugWrapText,
  hugWrapLines,
  hugWrapEmotes,
  hugWrapOpts,
);
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
  measureAdvance: adv,
  removeSpacesBetweenEmotes: true,
  maskEmotes: false,
  enableZeroWidth: false,
} as const;
const hugOffLines = wrapBody(hugText, 80, hugEmotes, hugImagesOff);
const hugOffPos = indexToLineCol(
  hugText,
  hugOffLines,
  6,
  hugEmotes,
  hugImagesOff,
);
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

const longText = "alpha beta gamma delta epsilon zeta eta theta iota";
const longLines = wrapBody(longText, 10, [], { measureAdvance: adv });
if (longLines.length < 3) {
  throw new Error("expected multi-line wrap for collapse test");
}
const collapsed = collapseWrapLines(longLines, 2, longText, 10, [], {
  measureAdvance: adv,
});
if (!collapsed.collapsed || collapsed.lines.length !== 2) {
  throw new Error(`expected 2 collapsed lines, got ${JSON.stringify(collapsed)}`);
}
const collapsedRender = withCollapsedEllipsis(
  renderWrapped(longText, collapsed.lines, [], { measureAdvance: adv }),
  collapsed.collapsed,
);
if (!collapsedRender.endsWith("...")) {
  throw new Error(`collapsed render must end with ellipsis, got ${JSON.stringify(collapsedRender)}`);
}
const passthrough = collapseWrapLines(longLines, 0, longText, 10, [], {
  measureAdvance: adv,
});
if (passthrough.collapsed || passthrough.lines.length !== longLines.length) {
  throw new Error("maxLines 0 must not collapse");
}

const unbroken = "ХАХАХАХАХАХАХАХАХАХАХАХАХАХАХАХА";
const unbrokenLines = wrapBody(unbroken, 8, [], { measureAdvance: adv });
if (unbrokenLines.length < 3) {
  throw new Error(
    `unbroken Cyrillic must wrap by grapheme, got ${unbrokenLines.length} lines`,
  );
}

const indented = wrapBody("abcdefghijklmnop", 10, [], {
  measureAdvance: adv,
  firstLineMaxWidthPx: 4,
});
if (indented.length < 2) {
  throw new Error("firstLineMaxWidthPx must force early wrap");
}
if (indented[0].end - indented[0].start > 4) {
  throw new Error(
    `first line too long: ${indented[0].end - indented[0].start}`,
  );
}
if (wrapLineOriginX(120, 0) !== 120 || wrapLineOriginX(120, 1) !== 0) {
  throw new Error("wrapLineOriginX must indent only first line by default");
}
if (wrapLineOriginX(120, 1, 24) !== 24) {
  throw new Error("wrapLineOriginX continuation must use cont origin");
}

const padded = renderWrapped("hi", [{ start: 0, end: 2 }], [], {
  firstLineIndentCols: 3,
});
if (padded !== "   hi") {
  throw new Error(`first line pad expected "   hi", got ${JSON.stringify(padded)}`);
}

const multiPad = renderWrapped(
  "abcdef",
  [
    { start: 0, end: 3 },
    { start: 3, end: 6 },
  ],
  [],
  { firstLineIndentCols: 4, continuationIndentCols: 2 },
);
if (multiPad !== "    abc\n  def") {
  throw new Error(`multi-line pad mismatch: ${JSON.stringify(multiPad)}`);
}
const firstOrigin = 4 * 10;
const contOrigin = 2 * 10;
if (wrapLineOriginX(firstOrigin, 0, contOrigin) !== firstOrigin) {
  throw new Error("first origin must match pad cols * cw");
}
if (wrapLineOriginX(firstOrigin, 1, contOrigin) !== contOrigin) {
  throw new Error("cont origin must match continuation pad");
}

const clippedTiny = clipNick("nickname", 2);
if (clippedTiny !== "..") {
  throw new Error(`clipNick(2) expected "..", got ${JSON.stringify(clippedTiny)}`);
}
const clippedOk = clipNick("ab", 10);
if (clippedOk !== "ab") {
  throw new Error("short nick must not clip");
}

// Pixel budget: narrow glyphs fit more chars than max(M) grid would allow.
const narrowGlyph = (s: string) => s.length * 4;
const longNarrow = "aaaaaaaaaaaaaaaaaaaaaaaa"; // 24*4=96px
const roomy = wrapBody(longNarrow, 100, [], { measureAdvance: narrowGlyph });
if (roomy.length !== 1) {
  throw new Error(
    `wide px budget must keep narrow text on one line, got ${roomy.length}`,
  );
}
const tight = wrapBody(longNarrow, 20, [], { measureAdvance: narrowGlyph });
if (tight.length < 4) {
  throw new Error(
    `tight px budget must wrap narrow text, got ${tight.length}`,
  );
}

const firstNarrow = wrapBody("abcdefghij", 100, [], {
  measureAdvance: adv,
  firstLineMaxWidthPx: 3,
});
if (firstNarrow.length < 2 || firstNarrow[0].end !== 3) {
  throw new Error(
    `firstLineMaxWidthPx 3 expected end=3, got ${JSON.stringify(firstNarrow[0])}`,
  );
}

console.log("wrap tests ok");
