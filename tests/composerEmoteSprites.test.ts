import {
  collectUnresolvedCodes,
  isSafeEmoteCdnUrl,
  normalizeCompleteItems,
  splitComposerParts,
} from "../src/shell/composerEmoteSprites.ts";

function assert(cond: boolean, msg: string): void {
  if (!cond) {
    throw new Error(msg);
  }
}

assert(isSafeEmoteCdnUrl("https://cdn.betterttv.net/emote/abc/1x"), "https ok");
assert(!isSafeEmoteCdnUrl("http://cdn.betterttv.net/emote/abc/1x"), "http blocked");
assert(!isSafeEmoteCdnUrl("https://user:pass@cdn.betterttv.net/emote/abc/1x"), "userinfo blocked");
assert(!isSafeEmoteCdnUrl("javascript:alert(1)"), "js blocked");
assert(!isSafeEmoteCdnUrl("https://cdn.example/emote/1x"), "foreign host blocked");

assert(
  JSON.stringify(splitComposerParts("Kappa Hello")) ===
    JSON.stringify(["Kappa", " ", "Hello"]),
  "split words",
);
assert(
  JSON.stringify(splitComposerParts("  a\tb")) ===
    JSON.stringify(["  ", "a", "\t", "b"]),
  "split keep ws",
);
assert(splitComposerParts("").length === 0, "empty split");

const known = new Map<string, string>([["Kappa", "https://cdn.example/k"]]);
const misses = new Map<string, number>();
const need = collectUnresolvedCodes("Kappa PogChamp ", known, misses, 1_000);
assert(need.length === 1 && need[0] === "PogChamp", "unresolved PogChamp");
assert(
  collectUnresolvedCodes("Kappa", known, misses, 1_000).length === 0,
  "known skipped",
);
misses.set("Nope", 900);
assert(
  collectUnresolvedCodes("Nope", known, misses, 1_000).length === 0,
  "fresh miss skipped",
);
assert(
  collectUnresolvedCodes("Nope", known, misses, 100_000).length === 1,
  "stale miss retried",
);

assert(
  JSON.stringify(
    normalizeCompleteItems([
      "Kappa ",
      { insert: "PogChamp ", url: "https://cdn.example/p", kind: "emote" },
      { insert: "@user ", kind: "user" },
      null,
    ]),
  ) ===
    JSON.stringify([
      { insert: "Kappa ", url: null, kind: "emote" },
      { insert: "PogChamp ", url: "https://cdn.example/p", kind: "emote" },
      { insert: "@user ", url: null, kind: "user" },
    ]),
  "normalize complete",
);

console.log("composerEmoteSprites tests ok");
