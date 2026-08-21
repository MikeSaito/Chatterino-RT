import {
  configureHighlightSound,
  playHighlightSound,
} from "../src/shell/highlightSound.ts";

configureHighlightSound({
  alwaysPlay: true,
  path: "",
  muted: true,
});

const started = Date.now();
await playHighlightSound();
const elapsed = Date.now() - started;
if (elapsed > 50) {
  throw new Error(`muted play should return immediately, took ${elapsed}ms`);
}

configureHighlightSound({
  alwaysPlay: true,
  path: "",
  muted: false,
});
