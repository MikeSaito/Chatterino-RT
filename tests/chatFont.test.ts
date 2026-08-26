import {
  atlasFontSize,
  chatTextRowHeight,
  clampChatFontSize,
  clampChatFontWeight,
  cssFontFamily,
  defaultChatLineHeight,
  LINE_HEIGHT_MIN_RATIO,
  measureFontMetrics,
  qtWeightToCss,
  qtWeightToPixi,
  sanitizeFontFamily,
} from "../src/chat/chatFont.ts";

function assert(cond: boolean, msg: string): void {
  if (!cond) {
    throw new Error(msg);
  }
}

assert(qtWeightToCss(50) === 400, `Normal 50 → 400, got ${qtWeightToCss(50)}`);
assert(qtWeightToCss(75) === 600, `Bold 75 → 600, got ${qtWeightToCss(75)}`);
assert(qtWeightToCss(25) === 200, `Light 25 → 200, got ${qtWeightToCss(25)}`);
assert(qtWeightToCss(1) === 100, "min weight");
assert(qtWeightToCss(99) === 792, `99*8=792, got ${qtWeightToCss(99)}`);
assert(qtWeightToPixi(50) === "400", "pixi Normal");
assert(qtWeightToPixi(75) === "600", "pixi Bold bucket");

assert(clampChatFontSize(10) === 10, "size 10");
assert(clampChatFontSize(0) === 1, "size min");
assert(clampChatFontSize(200) === 96, "size max");
assert(clampChatFontWeight(50) === 50, "weight 50");
assert(clampChatFontWeight(0) === 1, "weight min");

assert(sanitizeFontFamily("  Arial  ") === "Arial", "trim family");
assert(sanitizeFontFamily("   ") === "Segoe UI", "empty → Segoe UI");
assert(cssFontFamily("Segoe UI") === '"Segoe UI"', "quote Segoe UI");
assert(cssFontFamily("monospace") === "monospace", "generic unquoted");

assert(atlasFontSize(10) === 40, `atlas 10*4=40, got ${atlasFontSize(10)}`);
assert(atlasFontSize(14) === 56, `atlas 14*4=56, got ${atlasFontSize(14)}`);

assert(chatTextRowHeight(15) === 22, "Chatterino 15→22");
assert(defaultChatLineHeight(15) === 22, `default 15px row is 22, got ${defaultChatLineHeight(15)}`);
assert(
  defaultChatLineHeight(10) === Math.ceil(10 * LINE_HEIGHT_MIN_RATIO),
  "size 10 fallback",
);

const m = measureFontMetrics("monospace", 400, 15);
assert(m.charWidth > 0, "charWidth positive");
assert(m.lineHeight >= defaultChatLineHeight(15), `lineHeight >= fallback, got ${m.lineHeight}`);
assert(m.lineHeight > 15, "row taller than font size");

const prevDocument = globalThis.document;
const fakeMetrics = {
  width: 9,
  fontBoundingBoxAscent: 18,
  fontBoundingBoxDescent: 5,
  actualBoundingBoxAscent: 11,
  actualBoundingBoxDescent: 3,
};
globalThis.document = {
  createElement: () => ({
    getContext: () => ({
      font: "",
      measureText: () => fakeMetrics,
    }),
  }),
} as unknown as Document;
try {
  const canvasM = measureFontMetrics("Segoe UI", 400, 15);
  assert(canvasM.charWidth === 9, `canvas width, got ${canvasM.charWidth}`);
  assert(
    canvasM.lineHeight === 23,
    `fontBoundingBox 23, got ${canvasM.lineHeight}`,
  );
} finally {
  if (prevDocument === undefined) {
    Reflect.deleteProperty(globalThis, "document");
  } else {
    globalThis.document = prevDocument;
  }
}

assert(10 * 2 === 20, "size × zoom");

console.log("chatFont tests ok");
