// CDP probe for the release build (WebView2 remote debugging).
// Usage: node cdp-probe.mjs
import {
  connectCdp,
  ensureCrtDebug,
  submitComposer,
} from "./scripts/cdp/lib.mjs";

let cdp = await connectCdp();
cdp = await ensureCrtDebug(cdp);
const { evalJs, sleep, close, consoleLines } = cdp;

const initial = await evalJs(`(() => {
  const q = (s) => document.querySelector(s);
  return {
    href: location.href,
    status: q('#status')?.textContent,
    composerHidden: q('#composer')?.hidden,
    inputDisabled: q('#composer-input')?.disabled,
    sendDisabled: q('#composer-send')?.disabled,
    sendTitle: q('#composer-send')?.title,
    authChipHidden: q('#auth-chip')?.hidden,
    authChipLogin: q('#auth-chip-login')?.textContent,
    signinHidden: q('#auth-signin')?.hidden,
    channelTitle: q('#channel-title')?.textContent,
    chatEmptyHidden: q('#chat-empty')?.hidden,
    canvas: !!q('#chat-canvas'),
    channelListCount: document.querySelectorAll('#channel-list li').length,
    hasCrt: Boolean(window.__crt?.ring),
  };
})()`);
console.log("INITIAL:", JSON.stringify(initial, null, 1));

await sleep(5000);
const afterWait = await evalJs(`(() => {
  const q = (s) => document.querySelector(s);
  return {
    status: q('#status')?.textContent,
    chatEmptyHidden: q('#chat-empty')?.hidden,
    inputDisabled: q('#composer-input')?.disabled,
    inputValue: q('#composer-input')?.value,
  };
})()`);
console.log("AFTER 5s:", JSON.stringify(afterWait));

const marker = `probe message ${Math.floor(Math.random() * 1000)}`;
const sendResult = await submitComposer(evalJs, marker);
console.log("SEND:", JSON.stringify(sendResult));

await sleep(3000);
const finalState = await evalJs(`(() => {
  const q = (s) => document.querySelector(s);
  return {
    status: q('#status')?.textContent,
    chatEmptyHidden: q('#chat-empty')?.hidden,
    inputValue: q('#composer-input')?.value,
    inputCleared: q('#composer-input')?.value === '',
  };
})()`);
console.log("FINAL:", JSON.stringify(finalState));

console.log("--- CONSOLE/LOG ---");
for (const l of consoleLines.slice(0, 60)) console.log(l);
if (consoleLines.length > 60) console.log(`... +${consoleLines.length - 60} more`);

close();
process.exit(0);
