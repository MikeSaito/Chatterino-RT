import assert from "node:assert/strict";
import {
  collapseWrapLines,
  indexToLineCol,
  lineColToIndex,
  renderWrapped,
  wrapBody,
  wrapLineHeights,
  wrapLineOffsetY,
} from "../src/chat/wrap.ts";

// Each overflowing cluster still occupies one line, with UTF-16 source offsets.
for (const cluster of ["и\u0301", "👨‍👩‍👧‍👦", "🇷🇺", "❤️", "👩🏽‍🚀", "и\u0306", "е\u0308"]) {
  const text = cluster + "Я";
  const lines = wrapBody(text, 1, []);
  assert.deepEqual(lines, [
    { start: 0, end: cluster.length },
    { start: cluster.length, end: text.length },
  ]);
  assert.equal(renderWrapped(text, lines, []), cluster + "\nЯ");
  for (let i = 0; i < cluster.length; i++) {
    assert.equal(lineColToIndex(text, lines, 0, i, []), 0);
    // Partial selection measures a truncated suffix, including a split surrogate.
    assert.deepEqual(indexToLineCol(text, lines, i, []), { line: 0, col: i });
  }
}

assert.deepEqual(wrapBody("A\r\nB\rC\nD", 10, []), [
  { start: 0, end: 1 }, { start: 3, end: 4 },
  { start: 5, end: 6 }, { start: 7, end: 8 },
]);

// The emote ends after the first RI in a flag pair. The remaining suffix pairs
// the second and third RIs, unlike segmentation from the start of the message.
const flags = "aX🇦🇧🇨🇩Z";
const emotes = [{ start: 1, end: 4 }];
const options = { emoteMinPx: 1 };
const flagLines = wrapBody(flags, 4, emotes, options);
assert.deepEqual(flagLines, [
  { start: 0, end: 4 }, { start: 4, end: 8 }, { start: 8, end: 11 },
]);
assert.equal(renderWrapped(flags, flagLines, emotes, options), "a \n🇧🇨\n🇩Z");
assert.equal(lineColToIndex(flags, [{ start: 0, end: flags.length }], 0, 5, emotes, options), 4);
assert.deepEqual(collapseWrapLines(flagLines, 1, flags, 4, emotes, options), {
  lines: [{ start: 0, end: 1 }], collapsed: true,
});

// Mentions can also resume inside an original ZWJ cluster.
const zwj = "aX👩‍👩Z";
const mentionOpts = { maskMentions: [{ start: 1, end: 4 }] };
const zwjLines = wrapBody(zwj, 4, [], mentionOpts);
assert.deepEqual(zwjLines, [
  { start: 0, end: 4 }, { start: 4, end: 8 },
]);
assert.equal(renderWrapped(zwj, zwjLines, [], mentionOpts), "a   \n‍👩Z");

// Arbitrary render ranges and truncated limits retain the old suffix contract.
assert.equal(renderWrapped("é👩‍👩❤️", [{ start: 1, end: 5 }], []), "́👩‍");
const heights = wrapLineHeights(flagLines, flags, emotes, options, 22);
assert.deepEqual(heights, [22, 22, 22]);
assert.equal(wrapLineOffsetY(heights, 2), 44);
console.log("wrapGrapheme tests ok");
