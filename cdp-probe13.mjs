// CDP probe 13: trace pushMany / applySnapshot / reset via window.__crt hooks.
import { connectCdp, ensureCrtDebug, submitComposer } from "./scripts/cdp/lib.mjs";

let cdp = await connectCdp();
cdp = await ensureCrtDebug(cdp);
const { evalJs, sleep, close } = cdp;

const hooked = await evalJs(`(() => {
  const ring = window.__crt?.ring;
  if (!ring) return false;
  window.__flow = [];
  const ts = () => performance.now() | 0;
  const origPush = ring.pushMany.bind(ring);
  ring.pushMany = (evts) => {
    window.__flow.push([ts(), 'pushMany', evts.map((e) => e.kind + ':' + (e.text ?? e.systemText ?? e.id ?? '').slice(0, 40))]);
    return origPush(evts);
  };
  const origSnap = ring.applySnapshot.bind(ring);
  ring.applySnapshot = (evts) => {
    window.__flow.push([ts(), 'SNAPSHOT', evts.map((e) => e.kind + ':' + (e.text ?? e.systemText ?? e.id ?? '').slice(0, 40))]);
    return origSnap(evts);
  };
  const origReset = ring.reset.bind(ring);
  ring.reset = () => { window.__flow.push([ts(), 'RESET']); return origReset(); };
  return true;
})()`);
if (!hooked) {
  console.log("NO __crt.ring — abort");
  close();
  process.exit(1);
}

await submitComposer(evalJs, "trace one");

for (let i = 0; i < 6; i += 1) {
  await sleep(2000);
  const slots = await evalJs(`window.__crt.ring.slots.filter((s) => s.msgId).map((s) => s.bodySource)`);
  console.log(`T+${(i + 1) * 2}s slots=`, JSON.stringify(slots));
  if (i === 5) {
    const flow = await evalJs(`window.__flow`);
    console.log("FLOW:", JSON.stringify(flow, null, 1));
  }
}
close();
process.exit(0);
