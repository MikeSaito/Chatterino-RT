// CDP probe 14: status + resubscribe; slot counts via snapshot and __crt.
import {
  activeChannelLogin,
  connectCdp,
  ensureCrtDebug,
  joinChannel,
  snapshotPrivmsgs,
} from "./scripts/cdp/lib.mjs";

let cdp = await connectCdp();
cdp = await ensureCrtDebug(cdp);
const { evalJs, sleep, close } = cdp;

const st = await evalJs(`(() => ({
  status: document.querySelector('#status')?.textContent,
  empty: document.querySelector('#chat-empty')?.hidden,
  title: document.querySelector('#channel-title')?.textContent,
}))()`);
console.log("STATUS:", JSON.stringify(st));

await joinChannel(evalJs, "forsen");
await sleep(6000);

const channel = await activeChannelLogin(evalJs);
const snap = await snapshotPrivmsgs(evalJs, channel || "forsen");
const ringAfter = await evalJs(`(() => {
  const ring = window.__crt?.ring;
  if (!ring) return null;
  return {
    slots: ring.slots.filter((s) => s.msgId).length,
    bodies: ring.slots.filter((s) => s.msgId).slice(0, 5).map((s) => s.bodySource.slice(0, 50)),
  };
})()`);
console.log(
  "AFTER JOIN forsen:",
  JSON.stringify({ channel, snapshot: snap.length, ring: ringAfter }, null, 1),
);

await sleep(8000);
const snapLater = await snapshotPrivmsgs(evalJs, channel || "forsen");
const ringLater = await evalJs(`(() => {
  const ring = window.__crt?.ring;
  if (!ring) return null;
  return {
    slots: ring.slots.filter((s) => s.msgId).length,
    lastBodies: ring.slots.filter((s) => s.msgId).slice(-3).map((s) => s.bodySource.slice(0, 50)),
  };
})()`);
console.log("8s LATER:", JSON.stringify({ snapshot: snapLater.length, ring: ringLater }, null, 1));
close();
process.exit(0);
