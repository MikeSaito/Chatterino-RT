/** Shared helpers for WebView2 CDP release probes (node cdp-probe*.mjs). */

export const CDP_PORT = 9223;
export const MAIN_URL = "https://tauri.localhost/";

export async function connectCdp(pageUrl = MAIN_URL) {
  const list = await (await fetch(`http://localhost:${CDP_PORT}/json/list`)).json();
  const page = list.find((t) => t.type === "page" && t.url === pageUrl);
  if (!page) {
    throw new Error(
      `Main page not found (${pageUrl}). Targets: ${JSON.stringify(list.map((t) => [t.type, t.url]))}`,
    );
  }

  const ws = new WebSocket(page.webSocketDebuggerUrl);
  let id = 0;
  const pending = new Map();
  const consoleLines = [];

  function send(method, params = {}) {
    return new Promise((resolve, reject) => {
      const mid = ++id;
      pending.set(mid, { resolve, reject });
      ws.send(JSON.stringify({ id: mid, method, params }));
    });
  }

  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      if (msg.error) reject(new Error(JSON.stringify(msg.error)));
      else resolve(msg.result);
      return;
    }
    if (msg.method === "Runtime.consoleAPICalled") {
      const text = msg.params.args.map((a) => a.value ?? a.description ?? "").join(" ");
      consoleLines.push(`console.${msg.params.type}: ${text}`);
    }
    if (msg.method === "Runtime.exceptionThrown") {
      const d = msg.params.exceptionDetails;
      consoleLines.push(`EXCEPTION: ${d.text} ${d.exception?.description ?? ""}`);
    }
  };

  await new Promise((res, rej) => {
    ws.onopen = res;
    ws.onerror = rej;
  });

  await send("Runtime.enable");
  await send("Log.enable");
  await send("Page.enable");

  async function evalJs(expression) {
    const r = await send("Runtime.evaluate", {
      expression,
      returnByValue: true,
      awaitPromise: true,
    });
    if (r.exceptionDetails) {
      return {
        __error:
          r.exceptionDetails.text +
          " " +
          (r.exceptionDetails.exception?.description ?? ""),
      };
    }
    return r.result.value;
  }

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  function close() {
    ws.close();
  }

  return { ws, send, evalJs, sleep, close, consoleLines, pageUrl };
}

/** Enable window.__crt in release via localStorage crt-debug=1 (see main.ts). */
export async function ensureCrtDebug(cdp) {
  const has = await cdp.evalJs(`Boolean(window.__crt?.ring)`);
  if (has) {
    return cdp;
  }
  console.log("crt-debug: enabling localStorage hook and reloading…");
  await cdp.evalJs(`localStorage.setItem('crt-debug','1'); location.reload(); true`);
  cdp.close();
  await cdp.sleep(7000);
  return connectCdp(cdp.pageUrl);
}

export async function submitComposer(evalJs, text) {
  return evalJs(`(() => {
    const input = document.querySelector('#composer-input');
    const form = document.querySelector('#composer');
    if (!input) return { skipped: 'no input' };
    if (input.disabled) return { skipped: 'input disabled' };
    input.value = ${JSON.stringify(text)};
    input.dispatchEvent(new Event('input', { bubbles: true }));
    form?.requestSubmit();
    return { ok: true, value: input.value };
  })()`);
}

export async function joinChannel(evalJs, login) {
  return evalJs(`(() => {
    const input = document.querySelector('#channel-input');
    const form = document.querySelector('#join-form');
    if (!input || !form) return { skipped: 'no join form' };
    input.value = ${JSON.stringify(login)};
    form.requestSubmit();
    return { ok: true };
  })()`);
}

export async function activeChannelLogin(evalJs) {
  return evalJs(`(() => {
    const title = document.querySelector('#channel-title')?.textContent ?? '';
    return title.replace(/^#\\s*/, '').trim().toLowerCase();
  })()`);
}

/** Privmsg list via chat_snapshot (works without window.__crt). */
export async function snapshotPrivmsgs(evalJs, channel) {
  const ch = channel.trim().toLowerCase();
  if (!ch) {
    return [];
  }
  const r = await evalJs(`(async () => {
    const { invoke } = await import('@tauri-apps/api/core');
    const snap = await invoke('chat_snapshot', { channel: ${JSON.stringify(ch)} });
    return (snap.events || [])
      .filter((e) => e.kind === 'privmsg')
      .map((e) => ({
        id: e.id,
        text: e.text,
        login: e.login,
        linkSpans: e.linkSpans || [],
      }));
  })()`);
  if (r && r.__error) {
    throw new Error(r.__error);
  }
  return r ?? [];
}

export function privmsgsWithText(messages, needle) {
  const n = needle.toLowerCase();
  return messages.filter((m) => m.text.toLowerCase().includes(n));
}
