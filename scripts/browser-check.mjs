// Isolated Chromium UI checks and repeatable message-stream benchmark.
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve, join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const browser = process.env.CRT_BROWSER_PATH ?? [
  "C:/Program Files/Google/Chrome/Application/chrome.exe",
  "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
  "/usr/bin/chromium", "/usr/bin/google-chrome",
].find(existsSync);
if (!browser) throw new Error("Chromium is required. Set CRT_BROWSER_PATH to its executable.");
const profile = mkdtempSync(join(tmpdir(), "crt-browser-check-"));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const server = spawn(process.execPath, [join(root, "node_modules/vite/bin/vite.js"), "--host", "localhost", "--port", "1420"], { cwd: root, windowsHide: true, stdio: "pipe" });
let serverLog = "";
server.stdout.on("data", (s) => { serverLog += s; }); server.stderr.on("data", (s) => { serverLog += s; });
let chrome;
let ws;
const failures = [];
try {
  for (let i = 0; ; i++) {
    try { if ((await fetch("http://localhost:1420/tests/browser.html")).ok) break; } catch {}
    if (i > 100 || server.exitCode !== null) throw new Error(`Vite did not start: ${serverLog}`);
    await sleep(100);
  }
  chrome = spawn(browser, ["--headless=new", "--no-first-run", "--no-default-browser-check", "--disable-background-timer-throttling", "--disable-renderer-backgrounding", "--disable-backgrounding-occluded-windows", "--disable-features=CalculateNativeWinOcclusion,IntensiveWakeUpThrottling", "--enable-precise-memory-info", "--enable-unsafe-swiftshader", "--use-angle=swiftshader", "--remote-debugging-port=9224", `--user-data-dir=${profile}`, "about:blank"], { windowsHide: true, stdio: "ignore" });
  let pages;
  for (let i = 0; ; i++) {
    try { pages = await (await fetch("http://127.0.0.1:9224/json/list")).json(); if (pages.some((p) => p.type === "page")) break; } catch {}
    if (i > 100 || chrome.exitCode !== null) throw new Error("Chromium did not start");
    await sleep(100);
  }
  ws = new WebSocket(pages.find((p) => p.type === "page").webSocketDebuggerUrl);
  await new Promise((r, reject) => { ws.onopen = r; ws.onerror = reject; });
  let id = 0;
  const requests = new Map();
  ws.onmessage = (event) => {
    const value = JSON.parse(event.data);
    if (value.id) {
      const req = requests.get(value.id);
      if (!req) return;
      requests.delete(value.id); clearTimeout(req.timer);
      value.error ? req.reject(new Error(JSON.stringify(value.error))) : req.resolve(value.result);
    } else if (value.method === "Runtime.exceptionThrown") failures.push(value.params.exceptionDetails.exception?.description ?? value.params.exceptionDetails.text);
  };
  const command = (method, params = {}) => new Promise((resolvePromise, reject) => {
    const next = ++id;
    const timer = setTimeout(() => { requests.delete(next); reject(new Error(`CDP timeout: ${method}`)); }, 45_000);
    requests.set(next, { resolve: resolvePromise, reject, timer }); ws.send(JSON.stringify({ id: next, method, params }));
  });
  const evaluate = async (expression) => {
    const result = await command("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text);
    return result.result.value;
  };
  const ready = async () => {
    for (let i = 0; i < 500; i++) { if (await evaluate("Boolean(window.__fixture?.ready())")) return; await sleep(40); }
    throw new Error(`UI not ready: ${await evaluate("document.querySelector('#status-text')?.textContent")} / ${failures.join("\n")}`);
  };
  await command("Runtime.enable"); await command("Page.enable");
  await command("Emulation.setFocusEmulationEnabled", { enabled: true });
  await command("Emulation.setDeviceMetricsOverride", { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });
  await command("Page.navigate", { url: "http://localhost:1420/tests/browser.html" });
  await ready();
  const smoke = await evaluate("window.__fixture.smoke()");
  console.log("UI checks:", smoke.join("; "));
  const saved = await evaluate("JSON.parse(localStorage.getItem('crt-workspace-v1'))");
  const savedAlpha = saved.channels.find((r) => r.channel === "alpha");
  assert.equal(savedAlpha.draft.text, "new draft after failure");
  assert.equal(savedAlpha.draft.reply.id, "alpha-4");
  await command("Page.reload"); await sleep(200); await ready();
  const restored = await evaluate(`({text: document.querySelector('#composer-input').value, reply: document.querySelector('#reply-label').textContent, scroll: window.__crt.ring.workspaceScroll(), active: document.querySelector('#channel-input').value})`);
  assert.equal(restored.text, "new draft after failure"); assert.equal(restored.active, "alpha");
  assert.ok(restored.reply.includes("viewer4"));
  assert.equal(restored.scroll.anchor?.msgId, savedAlpha.scroll.anchor?.msgId);
  assert.ok(Math.abs(restored.scroll.anchor.offsetFrac - savedAlpha.scroll.anchor.offsetFrac) < .02);
  console.log("UI restart: active tab, draft, reply, scroll anchor restored");
  const loads = [];
  for (const [rate, scrolling] of [[50, false], [200, false], [200, true]]) {
    const report = await evaluate(`window.__fixture.load(${rate}, 8, ${scrolling})`);
    assert.equal(report.messages, report.generated, "every generated event was processed by real IPC/ring");
    assert.ok(report.receiptToFrame.count > 0 && report.frames.count > 0, JSON.stringify({ report, failures }));
    loads.push(report);
    console.log(`Load ${rate}/s scroll=${scrolling}: processing p95=${report.processing.p95Ms.toFixed(2)}ms, receipt→frame p95=${report.receiptToFrame.p95Ms.toFixed(2)}ms, frame p95=${report.frames.p95Ms.toFixed(2)}ms`);
  }
  assert.deepEqual(failures, [], "no unhandled browser exceptions");
  const out = join(root, "artifacts"); mkdirSync(out, { recursive: true });
  writeFileSync(join(out, "browser-performance.json"), JSON.stringify({ environment: "Chromium headless, SwiftShader software GPU, 1280×800, DPR 1, synthetic text messages, mocked Tauri transport", smoke, restored, loads }, null, 2));
  const screenshot = await command("Page.captureScreenshot", { format: "png" });
  writeFileSync(join(out, "browser-check.png"), Buffer.from(screenshot.data, "base64"));
  console.log("Browser checks passed; report: artifacts/browser-performance.json");
} finally {
  ws?.close(); chrome?.kill(); server.kill();
  // Only remove the uniquely-created scratch profile, never the user's browser.
  if (resolve(profile).startsWith(resolve(tmpdir()) + "/") || resolve(profile).startsWith(resolve(tmpdir()) + "\\")) {
    await sleep(500);
    try { rmSync(profile, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 }); } catch {}
  }
}
