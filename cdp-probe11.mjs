// CDP probe 11: introspect ring slots via window.__crt (crt-debug=1).
import { connectCdp, ensureCrtDebug } from "./scripts/cdp/lib.mjs";

let cdp = await connectCdp();
cdp = await ensureCrtDebug(cdp);
const { evalJs, sleep, close } = cdp;

await sleep(4000);
const state = await evalJs(`(() => {
  const q = (s) => document.querySelector(s);
  return { status: q('#status')?.textContent, disabled: q('#composer-input')?.disabled, hasCrt: Boolean(window.__crt?.ring) };
})()`);
console.log("STATE:", JSON.stringify(state));

const slots = await evalJs(`(() => {
  const ring = window.__crt?.ring;
  if (!ring) return null;
  const out = [];
  for (const s of ring.slots) {
    if (!s.msgId) continue;
    out.push({
      msgId: s.msgId,
      body: s.bodySource,
      bodyRaw: s.bodyRaw,
      links: s.linkSpans,
      rootY: s.root.y,
      rootVisible: s.root.visible,
      hitW: s.root.hitArea?.width,
      hitH: s.root.hitArea?.height,
      eventMode: s.root.eventMode,
      stageChildren: ring.app.stage.children.length,
      stageEventMode: ring.app.stage.eventMode,
      screenW: ring.app.screen.width,
      screenH: ring.app.screen.height,
    });
  }
  return out;
})()`);
console.log("SLOTS:", JSON.stringify(slots, null, 1));
close();
process.exit(0);
