import {
  configureHighlightSound,
  highlightSoundMayPlay,
  playHighlightSound,
} from "../src/shell/highlightSound.ts";

function assert(cond: boolean, msg: string): void {
  if (!cond) {
    throw new Error(msg);
  }
}

configureHighlightSound({
  alwaysPlay: true,
  path: "",
  muted: true,
});
assert(!highlightSoundMayPlay(false), "muted blocks unfocused");
assert(!highlightSoundMayPlay(true), "muted blocks focused");
assert((await playHighlightSound()) === false, "muted batch skips playback");

configureHighlightSound({
  alwaysPlay: true,
  path: "",
  muted: false,
});
assert(highlightSoundMayPlay(true), "alwaysPlay allows focused");
assert(highlightSoundMayPlay(false), "alwaysPlay allows unfocused");
assert(
  (await playHighlightSound()) === true,
  "unmuted batch passes gate (Audio may still fail in Node)",
);

configureHighlightSound({
  alwaysPlay: false,
  path: "",
  muted: false,
});
assert(!highlightSoundMayPlay(true), "focus suppresses without alwaysPlay");
assert(highlightSoundMayPlay(false), "unfocused plays without alwaysPlay");

console.log("highlightSoundMute.test.ts: ok");
