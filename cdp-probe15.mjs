// CDP probe 15: join #mike_saito, send message, watch for local echo.
import {
  connectCdp,
  ensureCrtDebug,
  joinChannel,
  privmsgsWithText,
  snapshotPrivmsgs,
  submitComposer,
} from "./scripts/cdp/lib.mjs";

let cdp = await connectCdp();
cdp = await ensureCrtDebug(cdp);
const { evalJs, sleep, close } = cdp;

await joinChannel(evalJs, "mike_saito");
await sleep(5000);

const st0 = await evalJs(`(() => ({
  status: document.querySelector('#status')?.textContent,
  disabled: document.querySelector('#composer-input')?.disabled,
  title: document.querySelector('#header-channel-name')?.textContent ?? document.querySelector('#channel-title')?.textContent,
}))()`);
console.log("AFTER JOIN:", JSON.stringify(st0));

const marker = `trace two ${Date.now()}`;
await submitComposer(evalJs, marker);

for (let i = 0; i < 12; i += 1) {
  await sleep(5000);
  const snap = await snapshotPrivmsgs(evalJs, "mike_saito");
  const mineSnap = privmsgsWithText(snap, "trace two").length;
  const ringInfo = await evalJs(`(() => {
    const ring = window.__crt?.ring;
    if (!ring) return null;
    return {
      n: ring.slots.filter((x) => x.msgId).length,
      mine: ring.slots.filter((x) => x.msgId && x.bodySource.includes('trace two')).length,
    };
  })()`);
  const status = await evalJs(`document.querySelector('#status')?.textContent`);
  console.log(`T+${(i + 1) * 5}s`, JSON.stringify({ status, snap: mineSnap, ring: ringInfo }));
  if (mineSnap > 0 || (ringInfo && ringInfo.mine > 0)) {
    console.log("ECHO RECEIVED");
    break;
  }
}
close();
process.exit(0);
