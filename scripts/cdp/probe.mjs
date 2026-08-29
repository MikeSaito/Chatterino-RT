/**
 * WebView2 CDP release smoke: join channel, echo own message, link spans,
 * context menu, quick actions.
 *
 * Requires a release/dev build with remote debugging on port 9223.
 * Usage: node scripts/cdp/probe.mjs <channel>
 */
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  connectCdp,
  ensureCrtDebug,
  joinChannel,
  privmsgsWithText,
  snapshotPrivmsgs,
  submitComposer,
} from "./lib.mjs";

const channel = (process.argv[2] ?? "").trim().toLowerCase();
if (!channel) {
  console.error("Usage: node scripts/cdp/probe.mjs <channel>");
  process.exit(1);
}

const outDir = dirname(fileURLToPath(import.meta.url));
const shotPath = join(outDir, "probe-shot.png");

let cdp = await connectCdp();
cdp = await ensureCrtDebug(cdp);
const { send, evalJs, sleep, close } = cdp;

await joinChannel(evalJs, channel);
await sleep(5000);

const marker = `echotest https://example.com/page ${Date.now() % 100000}`;
const needle = marker.slice(0, 12);
await submitComposer(evalJs, marker);

let echoed = false;
let linkSpans = null;
for (let i = 0; i < 10; i += 1) {
  await sleep(1500);
  const snap = await snapshotPrivmsgs(evalJs, channel);
  const mine = privmsgsWithText(snap, needle);
  const ringMine = await evalJs(`(() => {
    const ring = window.__crt?.ring;
    if (!ring) return null;
    return ring.slots.filter((s) => s.msgId && s.bodySource.includes(${JSON.stringify(needle)})).length;
  })()`);
  const status = await evalJs(`document.querySelector('#status')?.textContent`);
  console.log(
    `T+${((i + 1) * 1.5).toFixed(1)}s`,
    JSON.stringify({ snap: mine.length, ring: ringMine, status }),
  );
  if (mine.length > 0) {
    echoed = true;
    linkSpans = mine[0].linkSpans;
    break;
  }
}
console.log(echoed ? "ECHO OK" : "ECHO MISSING");
console.log("LINK SPANS:", JSON.stringify(linkSpans));

await sleep(1500);
const shot = await send("Page.captureScreenshot", { format: "png" });
writeFileSync(shotPath, Buffer.from(shot.data, "base64"));
console.log("shot saved:", shotPath);

const geo = await evalJs(`(() => {
  const ring = window.__crt?.ring;
  if (!ring) return { noRing: true };
  const slot = ring.slots.find((s) => s.msgId && s.linkSpans.length > 0);
  if (!slot) return { noSlot: true };
  const canvas = document.querySelector('canvas');
  const rect = canvas.getBoundingClientRect();
  return {
    body: slot.bodySource.slice(0, 60),
    span: slot.linkSpans[0],
    rootY: slot.root.y,
    canvasRect: { left: rect.left, top: rect.top },
    stageY: ring.app.stage.y,
    lineH: ring.lineHeight,
  };
})()`);
console.log("GEO:", JSON.stringify(geo, null, 1));

if (!geo.noSlot && !geo.noRing) {
  const yWin = geo.canvasRect.top + geo.stageY + geo.rootY + geo.lineH / 2;
  await send("Input.dispatchMouseEvent", {
    type: "mousePressed",
    x: 400,
    y: yWin,
    button: "right",
    clickCount: 1,
  });
  await send("Input.dispatchMouseEvent", {
    type: "mouseReleased",
    x: 400,
    y: yWin,
    button: "right",
    clickCount: 1,
  });
  await sleep(700);
  const menu = await evalJs(`(() => {
    const m = document.querySelector('#chat-context');
    return {
      hidden: m?.hidden,
      items: m ? [...m.querySelectorAll('button')].map((b) => b.textContent.trim()).slice(0, 12) : [],
    };
  })()`);
  console.log("CONTEXT MENU:", JSON.stringify(menu));
  await evalJs(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`);
  await sleep(300);

  await send("Input.dispatchMouseEvent", { type: "mouseMoved", x: 400, y: yWin });
  await sleep(800);
  const qa = await evalJs(`(() => {
    const bar = document.querySelector('#chat-quick-actions');
    return {
      hidden: bar?.hidden,
      isVisible: bar?.classList.contains('is-visible'),
      buttons: bar ? bar.querySelectorAll('button').length : 0,
    };
  })()`);
  console.log("QUICK ACTIONS:", JSON.stringify(qa));
}

close();
process.exit(0);
