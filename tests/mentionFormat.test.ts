import { formatUserMention, mentionInsertText } from "../src/shell/mentionFormat.ts";
import { NickColorCache } from "../src/shell/nickColorCache.ts";

function assert(cond: boolean, msg: string): void {
  if (!cond) {
    throw new Error(msg);
  }
}

assert(formatUserMention("bob", true, true) === "bob,", "comma first");
assert(formatUserMention("bob", false, true) === "bob", "no comma mid");
assert(formatUserMention("bob", true, false) === "bob", "comma off");
assert(mentionInsertText("bob", true, true) === "@bob, ", "insert first");
assert(mentionInsertText("bob", false, true) === "@bob ", "insert mid");

const cache = new NickColorCache(2);
cache.set("Alice", 0xff0000);
cache.set("bob", 0x00ff00);
assert(cache.get("alice") === 0xff0000, "case");
cache.set("carol", 0x0000ff);
assert(cache.get("alice") === undefined, "evict");
assert(cache.get("bob") === 0x00ff00, "kept");
assert(cache.size === 2, "size");

const lru = new NickColorCache(2);
lru.set("a", 1);
lru.set("b", 2);
lru.set("a", 3);
lru.set("c", 4);
assert(lru.get("a") === 3, "lru refresh");
assert(lru.get("b") === undefined, "lru evict cold");

console.log("mentionFormat tests ok");
