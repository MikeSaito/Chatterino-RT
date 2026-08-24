/** Badge category visibility (stock Chatterino TwitchBadge.cpp). MIT reimpl. */

export type BadgeCategory =
  | "globalAuthority"
  | "predictions"
  | "channelAuthority"
  | "subscription"
  | "vanity";

export type BadgeVisibilityFlags = {
  globalAuthority: boolean;
  predictions: boolean;
  channelAuthority: boolean;
  subscription: boolean;
  vanity: boolean;
  ffz: boolean;
};

export const DEFAULT_BADGE_VISIBILITY: BadgeVisibilityFlags = {
  globalAuthority: true,
  predictions: true,
  channelAuthority: true,
  subscription: true,
  vanity: true,
  ffz: true,
};

export type BadgeLike = {
  set: string;
  source?: string;
};

const GLOBAL_AUTHORITY = new Set(["staff", "admin", "global_mod"]);
const PREDICTIONS = new Set(["predictions"]);
const CHANNEL_AUTHORITY = new Set([
  "lead_moderator",
  "moderator",
  "vip",
  "broadcaster",
]);
const SUBSCRIPTION = new Set(["subscriber", "founder"]);

export function badgeCategory(set: string): BadgeCategory {
  const key = set.toLowerCase();
  if (GLOBAL_AUTHORITY.has(key)) {
    return "globalAuthority";
  }
  if (PREDICTIONS.has(key)) {
    return "predictions";
  }
  if (CHANNEL_AUTHORITY.has(key)) {
    return "channelAuthority";
  }
  if (SUBSCRIPTION.has(key)) {
    return "subscription";
  }
  return "vanity";
}

export function isBadgeVisible(
  badge: BadgeLike,
  flags: BadgeVisibilityFlags,
): boolean {
  if (badge.source === "ffz" || badge.set === "ffz") {
    return flags.ffz;
  }
  switch (badgeCategory(badge.set)) {
    case "globalAuthority":
      return flags.globalAuthority;
    case "predictions":
      return flags.predictions;
    case "channelAuthority":
      return flags.channelAuthority;
    case "subscription":
      return flags.subscription;
    case "vanity":
      return flags.vanity;
  }
}

export function filterVisibleBadges<T extends BadgeLike>(
  badges: T[],
  flags: BadgeVisibilityFlags,
  max: number,
): T[] {
  const out: T[] = [];
  for (const badge of badges) {
    if (!isBadgeVisible(badge, flags)) {
      continue;
    }
    out.push(badge);
    if (out.length >= max) {
      break;
    }
  }
  return out;
}

export function badgeVisibilityEqual(
  a: BadgeVisibilityFlags,
  b: BadgeVisibilityFlags,
): boolean {
  return (
    a.globalAuthority === b.globalAuthority &&
    a.predictions === b.predictions &&
    a.channelAuthority === b.channelAuthority &&
    a.subscription === b.subscription &&
    a.vanity === b.vanity &&
    a.ffz === b.ffz
  );
}
