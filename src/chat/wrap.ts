export type WrapLine = {
  start: number;
  end: number;
};

export type WrapEmote = {
  start: number;
  end: number;
  zeroWidth?: boolean;
};

export type WrapRange = {
  start: number;
  end: number;
};

/** Опции переноса под Size / Enable / Zero-width. */
export type WrapOptions = {
  /** Мин. колонок на non-ZW эмодзи: max(codeLen, emoteMinCols). */
  emoteMinCols?: number;
  /** false: коды эмодзи видимы в тексте (Enable images off). */
  maskEmotes?: boolean;
  /** false: zeroWidth игнорируется. */
  enableZeroWidth?: boolean;
  /** Диапазоны mention: в renderWrapped заменить пробелами (overlay BitmapText). */
  maskMentions?: readonly WrapRange[];
};

type WrapCtx = {
  emoteMinCols: number;
  maskEmotes: boolean;
  enableZeroWidth: boolean;
  maskMentions: readonly WrapRange[];
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

function ctxFrom(opts?: WrapOptions): WrapCtx {
  return {
    emoteMinCols: Math.max(0, Math.floor(opts?.emoteMinCols ?? 0)),
    maskEmotes: opts?.maskEmotes !== false,
    maskMentions: opts?.maskMentions ?? [],
    enableZeroWidth: opts?.enableZeroWidth !== false,
  };
}

export function wrapBody(
  text: string,
  maxChars: number,
  emotes: readonly WrapEmote[],
  opts?: WrapOptions,
): WrapLine[] {
  const ctx = ctxFrom(opts);
  const width = Math.max(1, Math.floor(maxChars));
  const n = text.length;
  if (n === 0) {
    return [{ start: 0, end: 0 }];
  }
  const lines: WrapLine[] = [];
  for (const para of hardParagraphs(text)) {
    wrapParagraph(text, para.start, para.end, width, emotes, lines, ctx);
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
  opts?: WrapOptions,
): string {
  const ctx = ctxFrom(opts);
  return lines.map((line) => maskSlice(text, line.start, line.end, emotes, ctx)).join("\n");
}

export function indexToLineCol(
  text: string,
  lines: readonly WrapLine[],
  index: number,
  emotes: readonly WrapEmote[],
  opts?: WrapOptions,
): { line: number; col: number } | null {
  const ctx = ctxFrom(opts);
  for (let line = 0; line < lines.length; line += 1) {
    const row = lines[line];
    if (index >= row.start && index < row.end) {
      return { line, col: visualWidth(text, row.start, index, emotes, ctx) };
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
  opts?: WrapOptions,
): number | null {
  const ctx = ctxFrom(opts);
  if (line < 0 || line >= lines.length) {
    return null;
  }
  const row = lines[line];
  let visual = 0;
  let i = row.start;
  while (i < row.end) {
    const step = advanceUnit(text, i, row.end, emotes, ctx);
    const width = step.width;
    if (width === 0) {
      i = step.next;
      continue;
    }
    if (col >= visual && col < visual + width) {
      return i;
    }
    visual += width;
    i = step.next;
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
  ctx: WrapCtx,
): void {
  let i = from;
  if (from === to) {
    if (lines.length < WRAP_MAX_LINES) {
      lines.push({ start: from, end: to });
    }
    return;
  }
  while (i < to && lines.length < WRAP_MAX_LINES) {
    let end = takeWidth(text, i, to, width, emotes, ctx);
    if (end < to) {
      end = snapBeforeEmote(i, end, emotes, ctx);
      end = snapBeforeMention(i, end, ctx.maskMentions);
      end = snapWord(text, i, end, emotes, ctx);
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
  ctx: WrapCtx,
): number {
  let used = 0;
  let end = start;
  let i = start;
  while (i < limit) {
    const step = advanceUnit(text, i, limit, emotes, ctx);
    const w = step.width;
    if (w > 0 && used + w > width && used > 0) {
      break;
    }
    used += w;
    end = step.next;
    i = step.next;
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
  ctx: WrapCtx,
): number {
  let used = 0;
  let i = start;
  while (i < end) {
    const step = advanceUnit(text, i, end, emotes, ctx);
    used += step.width;
    i = step.next;
  }
  return used;
}

function maskSlice(
  text: string,
  start: number,
  end: number,
  emotes: readonly WrapEmote[],
  ctx: WrapCtx,
): string {
  const mentionMask = ctx.maskMentions.length > 0;
  if (!ctx.maskEmotes && !mentionMask) {
    return text.slice(start, end).replace(/[\r\n]/g, " ");
  }
  const kept: string[] = [];
  let i = start;
  while (i < end) {
    if (mentionMask) {
      const mention = mentionAt(ctx.maskMentions, i);
      if (mention) {
        const to = Math.min(mention.end, end);
        if (i < to) {
          const cols = visualWidth(text, i, to, emotes, {
            ...ctx,
            maskMentions: [],
          });
          for (let c = 0; c < cols; c += 1) {
            kept.push(" ");
          }
        }
        i = to;
        continue;
      }
    }
    if (!ctx.maskEmotes) {
      const code = text.charCodeAt(i);
      if (code === 10 || code === 13) {
        kept.push(" ");
        i += 1;
        continue;
      }
      const next = nextUnit(text, i, end);
      kept.push(text.slice(i, next));
      i = next;
      continue;
    }
    if (collapsed(emotes, i, ctx)) {
      i = nextUtf16(text, i);
      continue;
    }
    const span = emoteAt(emotes, i, ctx);
    if (span && i === span.start) {
      const cols = emoteCols(span, ctx);
      for (let c = 0; c < cols; c += 1) {
        kept.push(" ");
      }
      i = span.end;
      continue;
    }
    if (span) {
      i = span.end;
      continue;
    }
    const code = text.charCodeAt(i);
    if (code === 10 || code === 13) {
      kept.push(" ");
      i += 1;
      continue;
    }
    const next = nextUnit(text, i, end);
    kept.push(text.slice(i, next));
    i = next;
  }
  return kept.join("");
}

function mentionAt(
  ranges: readonly WrapRange[],
  index: number,
): WrapRange | null {
  for (const r of ranges) {
    if (index >= r.start && index < r.end) {
      return r;
    }
  }
  return null;
}

function snapBeforeEmote(
  lineStart: number,
  end: number,
  emotes: readonly WrapEmote[],
  ctx: WrapCtx,
): number {
  let snapped = end;
  for (const span of emotes) {
    if (isZeroWidth(span, ctx)) {
      continue;
    }
    if (span.start > lineStart && span.start < snapped && span.end > snapped) {
      snapped = span.start;
    }
  }
  return snapped;
}

function snapBeforeMention(
  lineStart: number,
  end: number,
  mentions: readonly WrapRange[],
): number {
  let snapped = end;
  for (const span of mentions) {
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
  ctx: WrapCtx,
): number {
  for (let k = end - 1; k > start; k -= 1) {
    if (text.charCodeAt(k) === 32 && !collapsed(emotes, k, ctx)) {
      return k + 1;
    }
  }
  return end;
}

function advanceUnit(
  text: string,
  i: number,
  limit: number,
  emotes: readonly WrapEmote[],
  ctx: WrapCtx,
): { next: number; width: number } {
  if (collapsed(emotes, i, ctx)) {
    return { next: Math.min(limit, nextUtf16(text, i)), width: 0 };
  }
  const span = emoteAt(emotes, i, ctx);
  if (span && i === span.start) {
    return { next: Math.min(limit, span.end), width: emoteCols(span, ctx) };
  }
  if (span) {
    return { next: Math.min(limit, span.end), width: 0 };
  }
  const next = nextUnit(text, i, limit);
  return { next, width: next - i };
}

function emoteCols(span: WrapEmote, ctx: WrapCtx): number {
  const codeLen = Math.max(1, span.end - span.start);
  return Math.max(codeLen, ctx.emoteMinCols);
}

function emoteAt(
  emotes: readonly WrapEmote[],
  index: number,
  ctx: WrapCtx,
): WrapEmote | undefined {
  for (const span of emotes) {
    if (isZeroWidth(span, ctx)) {
      continue;
    }
    if (index >= span.start && index < span.end) {
      return span;
    }
  }
  return undefined;
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

function isZeroWidth(span: WrapEmote, ctx: WrapCtx): boolean {
  return ctx.enableZeroWidth && span.zeroWidth === true;
}

function collapsed(
  emotes: readonly WrapEmote[],
  index: number,
  ctx: WrapCtx,
): boolean {
  if (!ctx.enableZeroWidth) {
    return false;
  }
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
