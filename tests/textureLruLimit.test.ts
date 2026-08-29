import {
  TEXTURE_LRU_AREA_BASELINE,
  TEXTURE_LRU_LIMIT_MAX,
  textureLruLimitForDisplay,
} from "../src/chat/textureLruLimit.ts";
import { TEXTURE_LRU_LIMIT } from "../src/constants.ts";

function assert(cond: boolean, msg: string): void {
  if (!cond) {
    throw new Error(msg);
  }
}

assert(TEXTURE_LRU_LIMIT === 256, "base 256");
assert(TEXTURE_LRU_LIMIT_MAX === 512, "max 512");
assert(TEXTURE_LRU_AREA_BASELINE === 1920 * 1080, "FHD baseline");

assert(
  textureLruLimitForDisplay({ dpr: 1, width: 1920, height: 1080 }) === 256,
  "FHD dpr1 → base",
);
assert(
  textureLruLimitForDisplay({ dpr: 1, width: 1280, height: 720 }) === 256,
  "sub-FHD still base",
);
assert(
  textureLruLimitForDisplay({ dpr: 2, width: 1920, height: 1080 }) === 512,
  "FHD dpr2 → max",
);
assert(
  textureLruLimitForDisplay({ dpr: 1, width: 3840, height: 2160 }) === 512,
  "4K clamped to max",
);
assert(
  textureLruLimitForDisplay({ dpr: 0, width: 1920, height: 1080 }) === 256,
  "bad dpr → 1",
);
assert(
  textureLruLimitForDisplay({ dpr: 1, width: -1, height: 1080 }) === 256,
  "bad width",
);

console.log("textureLruLimit tests ok");
