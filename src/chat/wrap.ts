export type WrapLine = {
  start: number;
  end: number;
};

export type WrapEmote = {
  start: number;
  end: number;
  zeroWidth?: boolean;
};

const WRAP_MAX_LINES = 48;

type GraphemeSegmenter = {
  segment: (input: string) => Iterable<{ segment: string }>;
};

const graphemeSegmenter: GraphemeSegmenter | null = (() => {
  const intl = Intl as unknown as {
    Segmenter?: new (
      locale?: string,
      options?: { granularity: string },
    ) => GraphemeSegmenter;
  };
  if (typeof intl.Segmenter !== "function") {
    return null;
  }
  return new intl.Segmenter(undefined, { granularity: "grapheme" });
})();

export function wrapBody(
  text: string,
  maxChars: number,
  emotes: readonly WrapEmote[],
): WrapLine[] {
  const width = Math.max(1, Math.floor(maxChars));
  const n = text.length;
  if (n === 0) {
    return [{ start: 0, end: 0 }];
  }
  const lines: WrapLine[] = [];
  for (const para of hardParagraphs(text)) {
    wrapParagraph(text, para.start, para.end, width, emotes, lines);
    if (lines.length >= WRAP_MAX_LINES) {
      break;
    }
  }
  if (lines.length === 0) {
    return [{ start: 0, end: 0 }];
  }
  const last = lines[lines.length - 1];
  if (last.end < n && lines.length >= WRAP_MAX_LINES) {
    last.end = n;
  }
  return lines;
}

export function renderWrapped(
  text: string,
  lines: readonly WrapLine[],
  emotes: readonly WrapEmote[],
): string {
  return lines.map((line) => maskSlice(text, line.start, line.end, emotes)).join("\n");
}

export function indexToLineCol(
  text: string,
  lines: readonly WrapLine[],
  index: number,
  emotes: readonly WrapEmote[],
): { line: number; col: number } | null {
  for (let line = 0; line < lines.length; line += 1) {
    const row = lines[line];
    if (index >= row.start && index < row.end) {
      return { line, col: visualWidth(text, row.start, index, emotes) };
    }
  }
  return null;
}

export function lineColToIndex(
  text: string,
  lines: readonly WrapLine[],
  line: number,
  col: number,
  emotes: readonly WrapEmote[],
): number | null {
  if (line < 0 || line >= lines.length) {
    return null;
  }
  const row = lines[line];
  let visual = 0;
  let i = row.start;
  while (i < row.end) {
    const next = nextUnit(text, i, row.end);
    const width = unitWidth(i, emotes, next - i);
    if (width === 0) {
      i = next;
      continue;
    }
    if (col >= visual && col < visual + width) {
      return i;
    }
    visual += width;
    i = next;
  }
  return null;
}

export function clipNick(nick: string, maxChars: number): string {
  if (maxChars <= 0) {
    return "";
  }
  if (nick.length <= maxChars) {
    return nick;
  }
  if (maxChars === 1) {
    return nick.slice(0, nextUtf16(nick, 0));
  }
  const keep = utf16Fit(nick, maxChars - 2);
  return `${nick.slice(0, keep)}..`;
}

function wrapParagraph(
  text: string,
  from: number,
  to: number,
  width: number,
  emotes: readonly WrapEmote[],
  lines: WrapLine[],
): void {
  let i = from;
  if (from === to) {
    if (lines.length < WRAP_MAX_LINES) {
      lines.push({ start: from, end: to });
    }
    return;
  }
  while (i < to && lines.length < WRAP_MAX_LINES) {
    let end = takeWidth(text, i, to, width, emotes);
    if (end < to) {
      end = snapBeforeEmote(i, end, emotes);
      end = snapWord(text, i, end, emotes);
    }
    if (end <= i) {
      end = Math.min(to, nextUtf16(text, i));
    }
    lines.push({ start: i, end });
    i = end;
  }
}

function hardParagraphs(text: string): WrapLine[] {
  const out: WrapLine[] = [];
  let start = 0;
  const n = text.length;
  for (let i = 0; i < n; i += 1) {
    const c = text.charCodeAt(i);
    if (c !== 10 && c !== 13) {
      continue;
    }
    out.push({ start, end: i });
    if (c === 13 && i + 1 < n && text.charCodeAt(i + 1) === 10) {
      i += 1;
    }
    start = i + 1;
  }
  out.push({ start, end: n });
  return out;
}

function takeWidth(
  text: string,
  start: number,
  limit: number,
  width: number,
  emotes: readonly WrapEmote[],
): number {
  let used = 0;
  let end = start;
  let i = start;
  while (i < limit) {
    const next = nextUnit(text, i, limit);
    const w = unitWidth(i, emotes, next - i);
    if (w > 0 && used + w > width && used > 0) {
      break;
    }
    used += w;
    end = next;
    i = next;
  }
  if (end === start) {
    return Math.min(limit, nextUtf16(text, start));
  }
  return end;
}

function visualWidth(
  text: string,
  start: number,
  end: number,
  emotes: readonly WrapEmote[],
): number {
  let used = 0;
  let i = start;
  while (i < end) {
    const next = nextUnit(text, i, end);
    used += unitWidth(i, emotes, next - i);
    i = next;
  }
  return used;
}

function maskSlice(
  text: string,
  start: number,
  end: number,
  emotes: readonly WrapEmote[],
): string {
  const chars = text.slice(start, end).split("");
  const kept: string[] = [];
  for (let i = 0; i < chars.length; i += 1) {
    const abs = start + i;
    if (collapsed(emotes, abs)) {
      continue;
    }
    const code = chars[i].charCodeAt(0);
    if (code === 10 || code === 13 || inEmote(emotes, abs)) {
      kept.push(" ");
      continue;
    }
    kept.push(chars[i]);
  }
  return kept.join("");
}

function snapBeforeEmote(
  lineStart: number,
  end: number,
  emotes: readonly WrapEmote[],
): number {
  let snapped = end;
  for (const span of emotes) {
    if (span.zeroWidth) {
      continue;
    }
    if (span.start > lineStart && span.start < snapped && span.end > snapped) {
      snapped = span.start;
    }
  }
  return snapped;
}

function snapWord(
  text: string,
  start: number,
  end: number,
  emotes: readonly WrapEmote[],
): number {
  for (let k = end - 1; k > start; k -= 1) {
    if (text.charCodeAt(k) === 32 && !collapsed(emotes, k)) {
      return k + 1;
    }
  }
  return end;
}

function nextUnit(text: string, i: number, limit: number): number {
  if (graphemeSegmenter) {
    const slice = text.slice(i, limit);
    for (const part of graphemeSegmenter.segment(slice)) {
      return i + part.segment.length;
    }
  }
  return Math.min(limit, nextUtf16(text, i));
}

function nextUtf16(text: string, i: number): number {
  if (i >= text.length) {
    return text.length;
  }
  const c = text.charCodeAt(i);
  if (c >= 0xd800 && c <= 0xdbff && i + 1 < text.length) {
    return i + 2;
  }
  return i + 1;
}

function utf16Fit(text: string, n: number): number {
  if (n <= 0) {
    return 0;
  }
  if (n >= text.length) {
    return text.length;
  }
  const c = text.charCodeAt(n - 1);
  if (c >= 0xd800 && c <= 0xdbff) {
    return n - 1;
  }
  return n;
}

function unitWidth(index: number, emotes: readonly WrapEmote[], raw: number): number {
  return collapsed(emotes, index) ? 0 : raw;
}

function collapsed(emotes: readonly WrapEmote[], index: number): boolean {
  for (let i = 0; i < emotes.length; i += 1) {
    const span = emotes[i];
    if (span.zeroWidth !== true) {
      continue;
    }
    const from = i > 0 ? emotes[i - 1].end : span.start;
    if (index >= from && index < span.end) {
      return true;
    }
  }
  return false;
}

function inEmote(emotes: readonly WrapEmote[], index: number): boolean {
  return emotes.some(
    (span) => span.zeroWidth !== true && index >= span.start && index < span.end,
  );
}
