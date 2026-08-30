export type WrapLine = {
  start: number;
  end: number;
};

export type WrapEmote = {
  start: number;
  end: number;
  zeroWidth?: boolean;
  displayWidth?: number;
  displayHeight?: number;
  /** Stacked bits label width reserve (emotes.stackBits). */
  bitsAmount?: number;
};

export type WrapRange = {
  start: number;
  end: number;
};

/** Advance of a text slice in layout pixels (BitmapFont or test stub). */
export type MeasureAdvance = (slice: string) => number;

/** Author display box from provider (7TV WEBP width/height). */
export type EmoteAspect = {
  displayWidth?: number;
  displayHeight?: number;
};

/** Paint/wrap size: height = row emote box; width follows author aspect (Chatterino stretch). */
export function emoteDisplaySize(
  span: EmoteAspect,
  emoteMinPx: number,
): { w: number; h: number } {
  const min = Math.max(1, emoteMinPx);
  const dw = span.displayWidth;
  const dh = span.displayHeight;
  if (
    typeof dw === "number" &&
    typeof dh === "number" &&
    dw > 0 &&
    dh > 0
  ) {
    return {
      w: Math.max(1, Math.round((min * dw) / dh)),
      h: min,
    };
  }
  return { w: min, h: min };
}

/** Опции переноса: бюджет в px (Chatterino/Twitch proportional wrap). */
export type WrapOptions = {
  /**
   * Мин. ширина non-ZW эмодзи-спрайта в px (Enable images on).
   * С images off ширина = measureAdvance(code).
   */
  emoteMinPx?: number;
  /** Ширина глифов; default: UTF-16 length (unit tests). */
  measureAdvance?: MeasureAdvance;
  /** false: коды эмодзи видимы в тексте (Enable images off). */
  maskEmotes?: boolean;
  /** false: zeroWidth игнорируется. */
  enableZeroWidth?: boolean;
  /** Схлопнуть один ASCII space между соседними non-ZW эмодзи. */
  removeSpacesBetweenEmotes?: boolean;
  /** Диапазоны mention: в renderWrapped заменить пробелами (overlay BitmapText). */
  maskMentions?: readonly WrapRange[];
  /**
   * Ширина первой строки (после time/badges/nick).
   * Последующие — maxWidthPx (Twitch / Chatterino flow wrap).
   */
  firstLineMaxWidthPx?: number;
  /**
   * Optional leading spaces on the first rendered line (tests / single BitmapText).
   * MessageRing uses a split body instead.
   */
  firstLineIndentCols?: number;
  /** Leading spaces on lines 2+ when body.x is 0. */
  continuationIndentCols?: number;
};

type WrapCtx = {
  emoteMinPx: number;
  measureAdvance: MeasureAdvance;
  maskEmotes: boolean;
  enableZeroWidth: boolean;
  removeSpacesBetweenEmotes: boolean;
  maskMentions: readonly WrapRange[];
  /** Готовые строки: hug только если оба non-ZW на одной линии. */
  lines?: readonly WrapLine[];
};

type WrapBudget = {
  used: number;
  width: number;
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

function defaultAdvance(slice: string): number {
  return slice.length;
}

function ctxFrom(opts?: WrapOptions): WrapCtx {
  return {
    emoteMinPx: Math.max(0, Math.floor(opts?.emoteMinPx ?? 0)),
    measureAdvance: opts?.measureAdvance ?? defaultAdvance,
    maskEmotes: opts?.maskEmotes !== false,
    maskMentions: opts?.maskMentions ?? [],
    enableZeroWidth: opts?.enableZeroWidth !== false,
    removeSpacesBetweenEmotes: opts?.removeSpacesBetweenEmotes === true,
  };
}

export function wrapBody(
  text: string,
  maxWidthPx: number,
  emotes: readonly WrapEmote[],
  opts?: WrapOptions,
): WrapLine[] {
  const ctx = ctxFrom(opts);
  const restW = Math.max(1, Math.floor(maxWidthPx));
  const firstW = Math.max(
    1,
    Math.floor(opts?.firstLineMaxWidthPx ?? restW),
  );
  const n = text.length;
  if (n === 0) {
    return [{ start: 0, end: 0 }];
  }
  const lines: WrapLine[] = [];
  const widthForNext = (): number =>
    lines.length === 0 ? firstW : restW;
  for (const para of hardParagraphs(text)) {
    wrapParagraph(
      text,
      para.start,
      para.end,
      widthForNext,
      emotes,
      lines,
      ctx,
    );
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
  ctx.lines = lines;
  const firstPad = Math.max(0, Math.floor(opts?.firstLineIndentCols ?? 0));
  const contPad = Math.max(0, Math.floor(opts?.continuationIndentCols ?? 0));
  const firstSpaces = firstPad > 0 ? " ".repeat(firstPad) : "";
  const contSpaces = contPad > 0 ? " ".repeat(contPad) : "";
  return lines
    .map((line, i) => {
      const slice = maskSlice(text, line.start, line.end, emotes, ctx);
      if (i === 0) {
        return firstSpaces ? `${firstSpaces}${slice}` : slice;
      }
      return contSpaces ? `${contSpaces}${slice}` : slice;
    })
    .join("\n");
}

/** `col` = visual X in px from line start (not character columns). */
export function indexToLineCol(
  text: string,
  lines: readonly WrapLine[],
  index: number,
  emotes: readonly WrapEmote[],
  opts?: WrapOptions,
): { line: number; col: number } | null {
  const ctx = ctxFrom(opts);
  ctx.lines = lines;
  for (let line = 0; line < lines.length; line += 1) {
    const row = lines[line];
    if (index >= row.start && index < row.end) {
      return { line, col: visualWidth(text, row.start, index, emotes, ctx) };
    }
  }
  return null;
}

/** `col` = visual X in px from line start. */
export function lineColToIndex(
  text: string,
  lines: readonly WrapLine[],
  line: number,
  col: number,
  emotes: readonly WrapEmote[],
  opts?: WrapOptions,
): number | null {
  const ctx = ctxFrom(opts);
  ctx.lines = lines;
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

export type CollapsedWrap = {
  lines: WrapLine[];
  collapsed: boolean;
};

/** Stock collpseMessagesMinLines: keep first N wrap lines and trim last for "...". */
export function collapseWrapLines(
  lines: readonly WrapLine[],
  maxLines: number,
  text: string,
  lineWidthPx: number,
  emotes: readonly WrapEmote[],
  opts?: WrapOptions,
): CollapsedWrap {
  maxLines = Math.max(0, Math.floor(Number(maxLines) || 0));
  if (maxLines <= 0 || lines.length <= maxLines) {
    return { lines: [...lines], collapsed: false };
  }
  const ctx = ctxFrom(opts);
  const ellipsisPx = Math.max(1, ctx.measureAdvance("..."));
  const kept = lines.slice(0, maxLines);
  const last = kept[maxLines - 1];
  const budget = Math.max(1, lineWidthPx - ellipsisPx);
  const end = trimLineVisualEnd(text, last.start, last.end, budget, emotes, ctx);
  kept[maxLines - 1] = { start: last.start, end };
  return { lines: kept, collapsed: true };
}

export function withCollapsedEllipsis(rendered: string, collapsed: boolean): string {
  if (!collapsed) {
    return rendered;
  }
  const parts = rendered.split("\n");
  if (parts.length === 0) {
    return "...";
  }
  parts[parts.length - 1] = `${parts[parts.length - 1]}...`;
  return parts.join("\n");
}

function trimLineVisualEnd(
  text: string,
  start: number,
  end: number,
  maxVisual: number,
  emotes: readonly WrapEmote[],
  ctx: WrapCtx,
): number {
  if (end <= start) {
    return end;
  }
  const row: WrapLine = { start, end };
  const opts: WrapOptions = {
    emoteMinPx: ctx.emoteMinPx,
    measureAdvance: ctx.measureAdvance,
    maskEmotes: ctx.maskEmotes,
    enableZeroWidth: ctx.enableZeroWidth,
    removeSpacesBetweenEmotes: ctx.removeSpacesBetweenEmotes,
    maskMentions: ctx.maskMentions,
  };
  const total = visualWidth(text, start, end, emotes, ctx);
  if (total <= maxVisual) {
    return end;
  }
  const idx = lineColToIndex(text, [row], 0, maxVisual, emotes, opts);
  if (idx == null) {
    return Math.min(end, nextUtf16(text, start));
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

/**
 * Pixel X of wrap line content.
 * Line 0 after nick; later lines at continuation (timestamp / gutter).
 */
export function wrapLineOriginX(
  firstIndentPx: number,
  line: number,
  continuationPx = 0,
): number {
  return line <= 0
    ? Math.max(0, firstIndentPx)
    : Math.max(0, continuationPx);
}

function wrapParagraph(
  text: string,
  from: number,
  to: number,
  widthForNext: () => number,
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
    const width = Math.max(1, widthForNext());
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
    const step = advanceUnit(text, i, limit, emotes, ctx, { used, width });
    const w = step.width;
    if (w > 0 && used + w > width + 1e-3 && used > 1e-6) {
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

function spacesForPx(px: number, ctx: WrapCtx): string {
  const target = Math.max(1, px);
  const sw = ctx.measureAdvance(" ");
  if (!(sw > 0)) {
    return " ".repeat(Math.max(1, Math.round(target)));
  }
  const widthOf = (n: number): number =>
    ctx.measureAdvance(" ".repeat(Math.max(0, n)));
  let n = Math.max(1, Math.round(target / sw));
  while (n > 1 && Math.abs(widthOf(n - 1) - target) <= Math.abs(widthOf(n) - target)) {
    n -= 1;
  }
  while (Math.abs(widthOf(n + 1) - target) < Math.abs(widthOf(n) - target)) {
    n += 1;
  }
  return " ".repeat(Math.max(1, n));
}

/**
 * Ideal emote hole; layout width = measured mask spaces.
 * Images on: sprite display width only (Chatterino EmoteElement image size).
 * Using max(codeW) left a visible gap after short sprites with long names.
 * Images off: advance of the visible emote code.
 */
function emoteIdealPx(
  span: WrapEmote,
  text: string,
  ctx: WrapCtx,
): number {
  let w = ctx.maskEmotes
    ? Math.max(1, emoteDisplaySize(span, ctx.emoteMinPx).w)
    : Math.max(1, ctx.measureAdvance(text.slice(span.start, span.end)));
  if (span.bitsAmount != null && span.bitsAmount > 0) {
    w += Math.max(0, ctx.measureAdvance(` ${span.bitsAmount}`));
  }
  return w;
}

function emoteWidth(
  span: WrapEmote,
  text: string,
  ctx: WrapCtx,
): number {
  if (!ctx.maskEmotes) {
    return emoteIdealPx(span, text, ctx);
  }
  // Same advance as maskSlice spaces — no ceil drift vs sprites/hit-test.
  return ctx.measureAdvance(spacesForPx(emoteIdealPx(span, text, ctx), ctx));
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
          const px = visualWidth(text, i, to, emotes, {
            ...ctx,
            maskMentions: [],
          });
          kept.push(spacesForPx(px, ctx));
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
    if (collapsed(text, emotes, i, ctx)) {
      i = nextUtf16(text, i);
      continue;
    }
    const span = emoteAt(emotes, i, ctx);
    if (span && i === span.start) {
      kept.push(spacesForPx(emoteIdealPx(span, text, ctx), ctx));
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
    if (text.charCodeAt(k) === 32 && !collapsed(text, emotes, k, ctx)) {
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
  budget?: WrapBudget,
): { next: number; width: number } {
  if (ctx.maskMentions.length > 0) {
    const mention = mentionAt(ctx.maskMentions, i);
    if (mention && i >= mention.start && i < mention.end) {
      if (i !== mention.start) {
        return { next: Math.min(limit, mention.end), width: 0 };
      }
      const to = Math.min(mention.end, limit);
      const ideal = visualWidth(text, mention.start, to, emotes, {
        ...ctx,
        maskMentions: [],
      });
      return {
        next: to,
        width: ctx.measureAdvance(spacesForPx(ideal, ctx)),
      };
    }
  }
  if (collapsed(text, emotes, i, ctx, budget)) {
    return { next: Math.min(limit, nextUtf16(text, i)), width: 0 };
  }
  const span = emoteAt(emotes, i, ctx);
  if (span && i === span.start) {
    return {
      next: Math.min(limit, span.end),
      width: emoteWidth(span, text, ctx),
    };
  }
  if (span) {
    return { next: Math.min(limit, span.end), width: 0 };
  }
  const next = nextUnit(text, i, limit);
  return {
    next,
    width: Math.max(0, ctx.measureAdvance(text.slice(i, next))),
  };
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

function hugPrevNonZw(
  emotes: readonly WrapEmote[],
  spaceIndex: number,
  ctx: WrapCtx,
): WrapEmote | undefined {
  for (const span of emotes) {
    if (!isZeroWidth(span, ctx) && span.end === spaceIndex) {
      return span;
    }
  }
  if (!ctx.enableZeroWidth) {
    return undefined;
  }
  for (let i = 0; i < emotes.length; i += 1) {
    const span = emotes[i];
    if (span.zeroWidth !== true || span.end !== spaceIndex) {
      continue;
    }
    for (let j = i - 1; j >= 0; j -= 1) {
      if (!isZeroWidth(emotes[j], ctx)) {
        return emotes[j];
      }
    }
  }
  return undefined;
}

function hugNextNonZw(
  emotes: readonly WrapEmote[],
  spaceIndex: number,
  ctx: WrapCtx,
): WrapEmote | undefined {
  for (const span of emotes) {
    if (!isZeroWidth(span, ctx) && span.start === spaceIndex + 1) {
      return span;
    }
  }
  return undefined;
}

function emotesShareLine(
  prev: WrapEmote,
  next: WrapEmote,
  lines: readonly WrapLine[],
): boolean {
  for (const line of lines) {
    if (
      prev.start >= line.start &&
      prev.end <= line.end &&
      next.start >= line.start &&
      next.end <= line.end
    ) {
      return true;
    }
  }
  return false;
}

/** Один ASCII space между non-ZW (или после ZW-слоя на base). */
function hugSpace(
  text: string,
  emotes: readonly WrapEmote[],
  index: number,
  ctx: WrapCtx,
  budget?: WrapBudget,
): boolean {
  if (!ctx.removeSpacesBetweenEmotes || !ctx.maskEmotes) {
    return false;
  }
  if (index < 0 || index >= text.length || text.charCodeAt(index) !== 32) {
    return false;
  }
  const prev = hugPrevNonZw(emotes, index, ctx);
  const next = hugNextNonZw(emotes, index, ctx);
  if (!prev || !next) {
    return false;
  }
  if (ctx.lines && ctx.lines.length > 0) {
    if (!emotesShareLine(prev, next, ctx.lines)) {
      return false;
    }
  } else if (budget) {
    if (budget.used + emoteWidth(next, text, ctx) > budget.width) {
      return false;
    }
  }
  return true;
}

function collapsed(
  text: string,
  emotes: readonly WrapEmote[],
  index: number,
  ctx: WrapCtx,
  budget?: WrapBudget,
): boolean {
  if (hugSpace(text, emotes, index, ctx, budget)) {
    return true;
  }
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
