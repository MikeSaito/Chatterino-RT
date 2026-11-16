import assert from "node:assert/strict";
import { mkdirSync, rmdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { connect, sleep } from "./cdp.mjs";

const scale = "Number(document.documentElement.style.getPropertyValue('--chat-ui-scale'))";
const zoom = "document.querySelector('#settings-knob-zoom')";
const save = "document.querySelector('#settings-ok')";
const cancel = "document.querySelector('#settings-cancel')";
const status = "document.querySelector('#settings-status').textContent";
const visible = "window.__TAURI_INTERNALS__.invoke('plugin:window|is_visible', { label: 'settings' })";
const zoomIn = "window.dispatchEvent(new KeyboardEvent('keydown', { key: '=', code: 'Equal', ctrlKey: true, bubbles: true }))";

async function waitFor(action, description) {
  const deadline = Date.now() + 12_000;
  do {
    if (await action()) return;
    await sleep(100);
  } while (Date.now() < deadline);
  throw new Error(description);
}

async function blockWrite(config, filename, action) {
  const temporaryFile = join(config, `${filename}.json.tmp`);
  mkdirSync(temporaryFile);
  try {
    await action();
  } finally {
    rmdirSync(temporaryFile);
  }
}

export async function checkSettings({ main, port, config, invoke, restart }) {
  const about = await invoke("about_info");
  assert.equal(resolve(about.settingsDirectory), config, "settings test must use its disposable profile");
  const original = await invoke("settings_get");
  assert.equal(original.fontScale, 1);
  const changedScale = 1.2;
  let settings;
  const readScale = () => main().evaluate(scale);
  const assertScale = (value) => waitFor(async () => await readScale() === value, `main zoom should be ${value}`);
  const ready = () => waitFor(() => settings.evaluate(`Boolean(${zoom} && !${save}.disabled && ${zoom}.value)`), "settings did not load");
  const hidden = () => waitFor(async () => !await settings.evaluate(visible), "settings window did not hide");
  const open = async () => {
    const reopening = Boolean(settings);
    if (settings) {
      await settings.evaluate(`(() => {
        const button = ${save};
        window.__validationSettingsReloaded = false;
        const observer = new MutationObserver((records) => {
          if (!button.disabled && records.some(record => record.oldValue !== null)) {
            window.__validationSettingsReloaded = true;
            observer.disconnect();
          }
        });
        observer.observe(button, { attributes: true, attributeFilter: ['disabled'], attributeOldValue: true });
      })()`);
    }
    await main().evaluate("document.querySelector('#settings-open').click()");
    if (!settings) {
      await waitFor(async () => {
        settings = await connect(port, "settings").catch(() => undefined);
        return Boolean(settings);
      }, "settings WebView not found");
    }
    if (reopening) {
      await waitFor(() => settings.evaluate("window.__validationSettingsReloaded"), "settings did not reload after reopening");
    }
    await ready();
  };
  const chooseZoom = () => settings.evaluate(`(() => {
    const select = ${zoom};
    select.value = ${JSON.stringify(String(changedScale))};
    select.dispatchEvent(new Event('change', { bubbles: true }));
  })()`);
  const assertFailedSave = async (filename) => blockWrite(config, filename, async () => {
    await settings.evaluate(`${save}.click()`);
    await waitFor(() => settings.evaluate(`Boolean(${status}) && !${save}.disabled`), `missing save error for ${filename}`);
    assert.equal(await settings.evaluate(`Number(${zoom}.value)`), changedScale, "save failure discarded the draft");
    assert.equal((await invoke("settings_get")).fontScale, original.fontScale, "partial save changed the profile");
  });

  try {
    await open();
    await chooseZoom();
    await assertScale(changedScale);
    await invoke("chat_toggle_favourite_emote", { code: "FixtureEmote", isEmoji: false, add: true });
    await settings.evaluate(zoomIn);
    await waitFor(async () => await readScale() > changedScale, "settings zoom shortcut did not preview");
    assert.equal((await invoke("settings_get")).fontScale, original.fontScale, "preview persisted without confirmation");
    await settings.evaluate(`${cancel}.click()`);
    await hidden();
    await assertScale(original.fontScale);

    await open();
    await chooseZoom();
    await assertScale(changedScale);
    await assertFailedSave("settings");
    await assertFailedSave("filters");
    await assertScale(original.fontScale);
    await settings.evaluate("document.querySelector('#settings-knob-emotes-animate').click()");
    await waitFor(() => main().evaluate("window.__crt.ring.animateEmotes === false"), "animation setting did not reach chat");
    await settings.evaluate(`(() => {
      const input = document.querySelector('#settings-knob-scrollback-split');
      input.value = '10000';
      input.dispatchEvent(new Event('change', { bubbles: true }));
    })()`);
    await settings.evaluate(`${save}.click()`);
    await waitFor(async () => (await invoke("settings_get")).fontScale === changedScale, "confirmed zoom was not saved");
    await hidden();
    await assertScale(changedScale);
    assert.deepEqual(settings.errors, []);
  } finally {
    settings?.close();
  }

  await restart();
  const saved = await invoke("settings_get");
  assert.equal(saved.fontScale, changedScale);
  assert.deepEqual(saved.favouriteEmotes, ["FixtureEmote"], "saving settings lost an emote favourite");
  assert.equal(saved.knobs["emotes.animateEmotes"], false, "animation setting did not survive restart");
  assert.equal(await main().evaluate("window.__crt.ring.poolSize"), 10_000, "history limit did not take effect after restart");
  await assertScale(changedScale);
  await blockWrite(config, "settings", async () => {
    await main().evaluate(zoomIn);
    await waitFor(() => main().evaluate("Boolean(document.querySelector('#toast-host')?.textContent?.trim())"), "main window did not report save failure");
    await assertScale(changedScale);
    assert.equal((await invoke("settings_get")).fontScale, changedScale);
  });
  assert.deepEqual(main().errors, []);
  return ["preview", "cancel", "settings write failure", "filters write failure", "restart", "favourites", "emote animation", "history limit", "quick zoom write failure"];
}
