/** Stock Chatterino nicknames table → painted nick chrome. */

export type NicknameRule = {
  username: string;
  nickname: string;
  regex: boolean;
  caseSensitive: boolean;
  /**
   * Precompiled regex (with global flag).
   * undefined = literal rule; null = invalid pattern (skip).
   */
  re?: RegExp | null;
};

export function normalizeNicknameRules(
  rows: ReadonlyArray<Record<string, unknown>> | null | undefined,
): NicknameRule[] {
  if (!Array.isArray(rows)) {
    return [];
  }
  const out: NicknameRule[] = [];
  for (const row of rows) {
    if (!row || typeof row !== "object") {
      continue;
    }
    const username = String(row.username ?? "");
    const nickname = String(row.nickname ?? "");
    const regex = row.regex === true;
    const caseSensitive = row.caseSensitive === true;
    const rule: NicknameRule = {
      username,
      nickname,
      regex,
      caseSensitive,
    };
    if (regex) {
      if (!username) {
        rule.re = null;
      } else {
        try {
          const flags = caseSensitive ? "gu" : "giu";
          rule.re = new RegExp(username, flags);
        } catch {
          rule.re = null;
        }
      }
    }
    out.push(rule);
  }
  return out;
}

export function nicknameRulesEqual(
  a: NicknameRule[],
  b: NicknameRule[],
): boolean {
  if (a.length !== b.length) {
    return false;
  }
  for (let i = 0; i < a.length; i += 1) {
    const x = a[i];
    const y = b[i];
    if (
      x.username !== y.username ||
      x.nickname !== y.nickname ||
      x.regex !== y.regex ||
      x.caseSensitive !== y.caseSensitive
    ) {
      return false;
    }
  }
  return true;
}

function literalEqual(
  pattern: string,
  text: string,
  caseSensitive: boolean,
): boolean {
  if (caseSensitive) {
    return pattern === text;
  }
  // Stock QString::CaseInsensitive — fixed fold, not UI locale (tr İ/i).
  return pattern.toLocaleLowerCase("en") === text.toLocaleLowerCase("en");
}

/**
 * First matching nickname rule (stock Settings::matchNickname / Nickname::match).
 * Matches against already-formatted usernameText (after usernameDisplayMode).
 */
export function matchNickname(
  usernameText: string,
  rules: readonly NicknameRule[],
): string | null {
  if (!usernameText || rules.length === 0) {
    return null;
  }
  for (const rule of rules) {
    if (rule.regex) {
      if (!rule.re) {
        continue;
      }
      // Reset sticky lastIndex for global regex reuse.
      rule.re.lastIndex = 0;
      const replaced = usernameText.replace(rule.re, rule.nickname);
      if (replaced !== usernameText) {
        return replaced;
      }
      continue;
    }
    if (literalEqual(rule.username, usernameText, rule.caseSensitive)) {
      return rule.nickname;
    }
  }
  return null;
}

export function applyNickname(
  formatted: string,
  rules: readonly NicknameRule[],
): string {
  return matchNickname(formatted, rules) ?? formatted;
}
