// CDP probe 12: send messages with link, introspect slots, test context menu copy-link.
import { writeFileSync } from "node:fs";
import { connectCdp, ensureCrtDebug, submitComposer } from "./scripts/cdp/lib.mjs";

let cdp = await connectCdp();
cdp = await ensureCrtDebug(cdp);
const { send, evalJs, sleep, close } = cdp;

console.log("send1:", await submitComposer(evalJs, "probe alpha"));
await sleep(2500);
console.log("send2:", await submitComposer(evalJs, "linktest https://example.com/page end"));
await sleep(3500);

const slots = await evalJs(`(() => {
  const ring = window.__crt?.ring;
  if (!ring) return null;
  const out = [];
  for (const s of ring.slots) {
    if (!s.msgId) continue;
    out.push({
      body: s.bodySource,
      links: s.linkSpans,
      rootY: s.root.y,
      hitH: s.root.hitArea?.height,
      visible: s.root.visible,
      lineH: ring.lineHeight,
    });
  }
  return out;
})()`);
console.log("SLOTS:", JSON.stringify(slots, null, 1));

if (Array.isArray(slots)) {
  const linkSlot = slots.find((s) => s.links && s.links.length > 0);
  if (linkSlot) {
    const info = await evalJs(`(() => {
      const ring = window.__crt.ring;
      const s = ring.slots.find((x) => x.msgId && x.linkSpans.length > 0);
      const span = s.linkSpans[0];
      const w = ring.measureBitmapTextWidth('ChatFont', s.bodyRaw.slice(span.start, span.end));
      const pre = ring.measureBitmapTextWidth('ChatFont', s.bodyRaw.slice(0, span.start));
      const canvas = document.querySelector('#chat-canvas').getBoundingClientRect();
      return { span, w, pre, rootY: s.root.y, indent: s.bodyIndent, canvasLeft: canvas.left, canvasTop: canvas.top, lineH: ring.lineHeight };
    })()`);
    console.log("LINK GEOMETRY:", JSON.stringify(info));
    const cx = Math.round(info.canvasLeft + info.indent + info.pre + info.w / 2);
    const cy = Math.round(info.canvasTop + info.rootY + info.lineH / 2);
    console.log("CLICK AT:", cx, cy);
    await send("Input.dispatchMouseEvent", { type: "mousePressed", x: cx, y: cy, button: "right", buttons: 2, clickCount: 1 });
    await send("Input.dispatchMouseEvent", { type: "mouseReleased", x: cx, y: cy, button: "right", buttons: 0, clickCount: 1 });
    await sleep(300);
    const menu = await evalJs(`(() => {
      const menu = document.querySelector('#chat-context');
      return { hidden: menu.hidden, copyLink: document.querySelector('[data-action="copy-link"]')?.hidden };
    })()`);
    console.log("MENU:", JSON.stringify(menu));
    if (menu.hidden === false && menu.copyLink === false) {
      await evalJs(`document.querySelector('[data-action="copy-link"]').click(); true`);
      await sleep(400);
      const clip = await evalJs(`navigator.clipboard.readText().catch((e) => 'CLIP_ERR ' + e.message)`);
      console.log("CLIPBOARD:", JSON.stringify(clip));
    }
  } else {
    console.log("NO SLOT WITH LINK SPANS");
  }
}

const shot = await send("Page.captureScreenshot", { format: "png" });
writeFileSync("cdp-shot5.png", Buffer.from(shot.data, "base64"));
close();
process.exit(0);
