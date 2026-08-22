export type InputToken = {
  start: number;
  end: number;
  token: string;
  firstWord: boolean;
};

export function tokenAtCursor(text: string, cursor: number): InputToken {
  const c = Math.max(0, Math.min(cursor, text.length));
  let start = c;
  while (start > 0 && !isBreak(text.charAt(start - 1))) {
    start -= 1;
  }
  return {
    start,
    end: c,
    token: text.slice(start, c),
    firstWord: !text.slice(0, c).includes(" "),
  };
}

/** Stock SplitInput colon emote: token starts with `:` at word boundary (tokenAtCursor). */
export function isColonEmoteToken(token: string): boolean {
  return token.startsWith(":");
}

/** Stock SplitInput user mention popup: token starts with `@` at word boundary. */
export function isAtUserToken(token: string): boolean {
  return token.startsWith("@");
}

function isBreak(ch: string): boolean {
  return ch === " ";
}
