/**
 * Username nick chrome (Chatterino appearance knobs).
 * Palette values from Chatterino TwitchCommon.cpp (MIT).
 */

export type UsernameDisplayMode =
  | "Username"
  | "LocalizedName"
  | "UsernameAndLocalizedName";

/** Stock TWITCH_USERNAME_COLORS as 0xRRGGBB. */
export const TWITCH_USERNAME_COLORS: readonly number[] = [
  0xff0000, // Red
  0x0000ff, // Blue
  0x00ff00, // Green
  0xb22222, // FireBrick
  0xff7f50, // Coral
  0x9acd32, // YellowGreen
  0xff4500, // OrangeRed
  0x2e8b57, // SeaGreen
  0xdaa520, // GoldenRod
  0xd2691e, // Chocolate
  0x5f9ea0, // CadetBlue
  0x1e90ff, // DodgerBlue
  0xff69b4, // HotPink
  0x8a2be2, // BlueViolet
  0x00ff7f, // SpringGreen
];

export function parseUsernameDisplayMode(raw: unknown): UsernameDisplayMode {
  const s = String(raw ?? "UsernameAndLocalizedName");
  if (
    s === "Username" ||
    s === "LocalizedName" ||
    s === "UsernameAndLocalizedName"
  ) {
    return s;
  }
  return "UsernameAndLocalizedName";
}

export function parseBoldScale(raw: unknown): number {
  const n = Number(raw ?? 63);
  if (n === 50 || n === 63 || n === 75 || n === 100) {
    return n;
  }
  if (Number.isFinite(n)) {
    return Math.min(100, Math.max(0, Math.round(n)));
  }
  return 63;
}

/** Chatterino getRandomColor(userId) — QString::toInt then digitValue sum. */
export function randomNickColor(userId: string): number {
  const id = userId.trim();
  let seed: number | undefined;
  if (/^-?\d+$/.test(id)) {
    const n = Number(id);
    // Qt int32 range for QString::toInt success
    if (Number.isSafeInteger(n) && n >= -2147483648 && n <= 2147483647) {
      seed = n;
    }
  }
  if (seed === undefined) {
    seed = 0;
    for (const ch of id) {
      if (ch >= "0" && ch <= "9") {
        seed += ch.charCodeAt(0) - 48;
      } else {
        seed -= 1;
      }
    }
  }
  const idx =
    ((seed % TWITCH_USERNAME_COLORS.length) + TWITCH_USERNAME_COLORS.length) %
    TWITCH_USERNAME_COLORS.length;
  return TWITCH_USERNAME_COLORS[idx] ?? 0xff0000;
}

export function resolveNickColor(opts: {
  color: string;
  userId: string;
  colorize: boolean;
  fallback: number;
}): number {
  const hex = opts.color.trim();
  if (hex) {
    const m = /^#?([0-9a-fA-F]{6})$/.exec(hex);
    if (m) {
      return Number.parseInt(m[1], 16);
    }
  }
  if (opts.colorize && opts.userId.trim()) {
    return randomNickColor(opts.userId);
  }
  return opts.fallback;
}

export function formatUsername(opts: {
  login: string;
  displayName: string;
  mode: UsernameDisplayMode;
}): string {
  const login = opts.login.trim();
  const display = opts.displayName.trim() || login;
  const sameCi =
    login.localeCompare(display, undefined, { sensitivity: "accent" }) === 0;
  // Chatterino: when login≈display, use display-name casing as username.
  const username = sameCi ? display || login : login;
  const localized = sameCi ? "" : display;
  switch (opts.mode) {
    case "Username":
      return username || display;
    case "LocalizedName":
      return localized || username || display;
    case "UsernameAndLocalizedName":
    default:
      if (localized && username) {
        return `${username}(${localized})`;
      }
      return username || display;
  }
}
