export type WrapLine = {
  start: number;
  end: number;
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
  emotes: readonly { start: number; end: number }[],
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
  emotes: readonly { start: number; end: number }[],
): string {
  return lines.map((line) => maskSlice(text, line.start, line.end, emotes)).join("\n");
}

export function indexToLineCol(
  lines: readonly WrapLine[],
  index: number,
): { line: number; col: number } | null {
  for (let line = 0; line < lines.length; line += 1) {
    const row = lines[line];
    if (index >= row.start && index < row.end) {
      return { line, col: index - row.start };
    }
  }
  return null;
}

export function lineColToIndex(
  lines: readonly WrapLine[],
  line: number,
  col: number,
): number | null {
  if (line < 0 || line >= lines.length) {
    return null;
  }
  const row = lines[line];
  const idx = row.start + col;
  if (idx < row.start || idx >= row.end) {
    return null;
  }
  return idx;
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
  emotes: readonly { start: number; end: number }[],
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
    let end = takeWidth(text, i, to, width);
    if (end < to) {
      end = snapBeforeEmote(i, end, emotes);
      end = snapWord(text, i, end);
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

function takeWidth(text: string, start: number, limit: number, width: number): number {
  if (graphemeSegmenter) {
    const slice = text.slice(start, limit);
    let used = 0;
    let end = start;
    for (const part of graphemeSegmenter.segment(slice)) {
      const len = part.segment.length;
      if (used + len > width && used > 0) {
        break;
      }
      used += len;
      end += len;
    }
    return end === start ? Math.min(limit, nextUtf16(text, start)) : end;
  }
  return Math.min(limit, utf16Fit(text, start + width));
}

function maskSlice(
  text: string,
  start: number,
  end: number,
  emotes: readonly { start: number; end: number }[],
): string {
  const chars = text.slice(start, end).split("");
  for (let i = 0; i < chars.length; i += 1) {
    const code = chars[i].charCodeAt(0);
    if (code === 10 || code === 13) {
      chars[i] = " ";
    }
  }
  for (const span of emotes) {
    const from = Math.max(0, span.start - start);
    const to = Math.min(chars.length, span.end - start);
    for (let i = from; i < to; i += 1) {
      chars[i] = " ";
    }
  }
  return chars.join("");
}

function snapBeforeEmote(
  lineStart: number,
  end: number,
  emotes: readonly { start: number; end: number }[],
): number {
  let snapped = end;
  for (const span of emotes) {
    if (span.start > lineStart && span.start < snapped && span.end > snapped) {
      snapped = span.start;
    }
  }
  return snapped;
}

function snapWord(text: string, start: number, end: number): number {
  for (let k = end - 1; k > start; k -= 1) {
    if (text.charCodeAt(k) === 32) {
      return k + 1;
    }
  }
  return end;
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
