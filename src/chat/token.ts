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

function isBreak(ch: string): boolean {
  return ch === " ";
}
