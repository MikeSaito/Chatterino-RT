import assert from "node:assert/strict";
import { bindScrollChrome } from "../src/chat/scrollUi.ts";
import type { MessageRing } from "../src/chat/ring.ts";
import type { ScrollSnapshot } from "../src/chat/scroll.ts";
class Element extends EventTarget {
  clientHeight = 100; clientWidth = 16; hidden = false; title = ""; textContent = "";
  style = {}; classes = new Set<string>(); captured: number | undefined;
  classList = { add: (s: string) => { this.classes.add(s); }, remove: (s: string) => { this.classes.delete(s); }, contains: (s: string) => this.classes.has(s), toggle: (s: string, on: boolean) => { if(on) this.classes.add(s); else this.classes.delete(s); } };
  querySelector() { return null; } setAttribute() {} focus() {}
  getBoundingClientRect() { return { top: 0, height: 100 }; }
  setPointerCapture(id: number) { this.captured = id; }
  hasPointerCapture(id: number) { return this.captured === id; }
  releasePointerCapture() { this.captured = undefined; }
}
const frames = new Map<number, FrameRequestCallback>(); let frameId = 0;
let observer: (() => void) | undefined; let disconnects = 0;
const win = new EventTarget();
Object.assign(globalThis, { window: Object.assign(win, { clearTimeout, setTimeout }),
  FocusEvent: class extends Event {},
  requestAnimationFrame: (cb: FrameRequestCallback) => { frames.set(++frameId, cb); return frameId; },
  cancelAnimationFrame: (id: number) => frames.delete(id),
  ResizeObserver: class { constructor(cb: () => void) { observer = cb; } observe() {} disconnect() { disconnects++; } },
});
const state = { atBottom: false, overflow: true, contentRows: 100, viewRows: 10, bottom: 90, current: 20, desired: 20 } as ScrollSnapshot;
let calls = 0; let callback: ((s: ScrollSnapshot) => void) | undefined;
const ring = { setOnScroll(cb: (s: ScrollSnapshot) => void) { callback = cb; return () => { if(callback === cb) callback = undefined; }; },
 scrollSnapshot: () => state, pendingBelowCount: () => 0, handleWheel: () => calls++, noteChatHover: () => calls++, leaveChatHover: () => calls++, setKeyPause: () => calls++, pauseModifierName: () => "None", goToBottom: () => calls++, setDesired: () => calls++, isSmoothScrolling: () => false } as unknown as MessageRing;
const host = new Element(), track = new Element(), thumb = new Element(), jump = new Element();
const bind = () => bindScrollChrome({ ring, host: host as unknown as HTMLElement, track: track as unknown as HTMLElement, thumb: thumb as unknown as HTMLElement, jump: jump as unknown as HTMLButtonElement });
for (let i = 0; i < 3; i++) {
 const binding = bind(); assert.equal(frames.size, 1);
 const down = Object.assign(new Event("pointerdown", { cancelable: true }), { button: 0, pointerId: 7, clientY: 50 });
 track.dispatchEvent(down); assert.equal(track.captured, 7);
 track.dispatchEvent(Object.assign(new Event("pointerdown", { cancelable: true }), { button: 0, pointerId: 8, clientY: 60 }));
 assert.equal(track.captured, 7, "a second pointer cannot replace an active drag");
 const staleFrame = [...frames.values()][0];
 binding.dispose(); binding.dispose(); assert.equal(track.captured, undefined); assert.equal(frames.size, 0); assert.equal(callback, undefined);
 const before = calls;
 for (const target of [win, host, track, jump]) for (const name of ["wheel", "pointerenter", "pointermove", "pointerleave", "pointerdown", "pointerup", "pointercancel", "keydown", "keyup", "blur", "click"]) target.dispatchEvent(new Event(name));
 observer?.(); staleFrame(0); binding.refreshLocale(); binding.setHideHighlights(true);
 assert.equal(calls, before, "disposed binding must be inert"); assert.equal(jump.classes.has("is-visible"), false);
}
assert.equal(disconnects, 3);
const oldBinding = bind();
const replacement = bind();
const replacementCallback = callback;
const beforeOldDispose = calls;
oldBinding.dispose();
assert.equal(callback, replacementCallback, "old disposal preserves the replacement subscription");
assert.equal(calls, beforeOldDispose, "old disposal preserves replacement pause state");
replacement.dispose();
console.log("scrollUi lifecycle tests ok");
