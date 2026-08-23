import {
  badgeCategory,
  DEFAULT_BADGE_VISIBILITY,
  filterVisibleBadges,
  isBadgeVisible,
} from "../src/chat/badgeVisibility.ts";

function assert(cond: boolean, msg: string): void {
  if (!cond) {
    throw new Error(msg);
  }
}

assert(badgeCategory("staff") === "globalAuthority", "staff");
assert(badgeCategory("admin") === "globalAuthority", "admin");
assert(badgeCategory("global_mod") === "globalAuthority", "global_mod");
assert(badgeCategory("predictions") === "predictions", "predictions");
assert(badgeCategory("broadcaster") === "channelAuthority", "bc");
assert(badgeCategory("moderator") === "channelAuthority", "mod");
assert(badgeCategory("vip") === "channelAuthority", "vip");
assert(badgeCategory("lead_moderator") === "channelAuthority", "lead");
assert(badgeCategory("subscriber") === "subscription", "sub");
assert(badgeCategory("founder") === "subscription", "founder");
assert(badgeCategory("bits") === "vanity", "bits vanity");
assert(badgeCategory("premium") === "vanity", "premium vanity");
assert(badgeCategory("partner") === "vanity", "partner vanity");
assert(badgeCategory("STAFF") === "globalAuthority", "case");

const allOn = { ...DEFAULT_BADGE_VISIBILITY };
assert(isBadgeVisible("moderator", allOn), "mod on");
assert(isBadgeVisible("bits", allOn), "vanity on");

const noAuth = { ...DEFAULT_BADGE_VISIBILITY, globalAuthority: false };
assert(!isBadgeVisible("staff", noAuth), "staff off");
assert(isBadgeVisible("moderator", noAuth), "mod still on");

const noVanity = { ...DEFAULT_BADGE_VISIBILITY, vanity: false };
assert(!isBadgeVisible("bits", noVanity), "vanity off");
assert(isBadgeVisible("subscriber", noVanity), "sub still on");

const badges = [
  { set: "staff", version: "1" },
  { set: "moderator", version: "1" },
  { set: "subscriber", version: "12" },
  { set: "bits", version: "100" },
];
const filtered = filterVisibleBadges(
  badges,
  { ...DEFAULT_BADGE_VISIBILITY, vanity: false, globalAuthority: false },
  10,
);
assert(filtered.length === 2, `filtered len ${filtered.length}`);
assert(filtered[0].set === "moderator", "first mod");
assert(filtered[1].set === "subscriber", "second sub");

const capped = filterVisibleBadges(badges, DEFAULT_BADGE_VISIBILITY, 2);
assert(capped.length === 2, "cap");
assert(capped[0].set === "staff" && capped[1].set === "moderator", "cap order");

console.log("badgeVisibility.test.ts: ok");
