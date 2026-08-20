import { invoke } from "@tauri-apps/api/core";
import type { MessageRing } from "../chat/ring";
import type { DisplaySettings, Filters } from "../chat/types";

/** Как ZOOM_LEVELS в Chatterino GeneralPage (MIT logic; Qt not copied). */
const ZOOM_LEVELS: { label: string; value: number }[] = [
  { label: "0.5x", value: 0.5 },
  { label: "0.6x", value: 0.6 },
  { label: "0.7x", value: 0.7 },
  { label: "0.8x", value: 0.8 },
  { label: "0.9x", value: 0.9 },
  { label: "Default", value: 1 },
  { label: "1.2x", value: 1.2 },
  { label: "1.4x", value: 1.4 },
  { label: "1.6x", value: 1.6 },
  { label: "1.8x", value: 1.8 },
  { label: "2x", value: 2 },
  { label: "2.33x", value: 2.33 },
  { label: "2.66x", value: 2.66 },
  { label: "3x", value: 3 },
  { label: "3.5x", value: 3.5 },
  { label: "4x", value: 4 },
];

function splitLines(raw: string): string[] {
  return raw
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

function formatError(err: unknown): string {
  if (typeof err === "string") {
    return err;
  }
  if (err && typeof err === "object" && "message" in err) {
    const message = (err as { message: unknown }).message;
    if (typeof message === "string" && message.length > 0) {
      return message;
    }
  }
  return "ошибка";
}

function nearestZoom(scale: number): number {
  let best = ZOOM_LEVELS[0].value;
  let bestDist = Math.abs(scale - best);
  for (const item of ZOOM_LEVELS) {
    const dist = Math.abs(scale - item.value);
    if (dist < bestDist) {
      best = item.value;
      bestDist = dist;
    }
  }
  return best;
}

function focusables(root: HTMLElement): HTMLElement[] {
  const nodes = root.querySelectorAll<HTMLElement>(
    'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
  );
  return [...nodes].filter((el) => !el.hidden && el.getClientRects().length > 0);
}

export function bindSettingsDialog(opts: {
  ring: MessageRing;
  openBtn: HTMLButtonElement;
  modal: HTMLElement;
}): void {
  const { ring, openBtn, modal } = opts;
  const appRoot = document.querySelector<HTMLElement>("#app");
  const dialog = modal.querySelector<HTMLElement>("#settings-dialog");
  const backdrop = modal.querySelector<HTMLElement>("#settings-backdrop");
  const search = modal.querySelector<HTMLInputElement>("#settings-search");
  const tabs = modal.querySelectorAll<HTMLButtonElement>(".settings-tab");
  const pages = modal.querySelectorAll<HTMLElement>(".settings-page");
  const okBtn = modal.querySelector<HTMLButtonElement>("#settings-ok");
  const cancelBtn = modal.querySelector<HTMLButtonElement>("#settings-cancel");
  const statusEl = modal.querySelector<HTMLElement>("#settings-status");
  const zoomEl = modal.querySelector<HTMLSelectElement>("#settings-font-scale");
  const timestampsEl = modal.querySelector<HTMLSelectElement>("#settings-timestamps");
  const selfBox = modal.querySelector<HTMLInputElement>("#filters-self");
  const ignoreLoginsEl = modal.querySelector<HTMLTextAreaElement>("#filters-ignore-logins");
  const ignorePhrasesEl = modal.querySelector<HTMLTextAreaElement>("#filters-ignore-phrases");
  const highlightPhrasesEl = modal.querySelector<HTMLTextAreaElement>(
    "#filters-highlight-phrases",
  );
  const highlightLoginsEl = modal.querySelector<HTMLTextAreaElement>(
    "#filters-highlight-logins",
  );
  if (
    !dialog ||
    !backdrop ||
    !search ||
    !okBtn ||
    !cancelBtn ||
    !statusEl ||
    !zoomEl ||
    !timestampsEl ||
    !selfBox ||
    !ignoreLoginsEl ||
    !ignorePhrasesEl ||
    !highlightPhrasesEl ||
    !highlightLoginsEl
  ) {
    return;
  }

  for (const item of ZOOM_LEVELS) {
    const opt = document.createElement("option");
    opt.value = String(item.value);
    opt.textContent = item.label;
    zoomEl.append(opt);
  }

  let baselineDisplay: DisplaySettings = { fontScale: 1, showTimestamps: true };
  let baselineFilters: Filters = {
    enableSelfHighlight: true,
    ignoreLogins: [],
    ignorePhrases: [],
    highlightPhrases: [],
    highlightLogins: [],
  };
  let previewTimer = 0;
  let saving = false;

  const readDisplayDraft = (): DisplaySettings => ({
    fontScale: nearestZoom(Number(zoomEl.value)),
    showTimestamps: timestampsEl.value !== "off",
  });

  const readFiltersDraft = (): Filters => ({
    enableSelfHighlight: selfBox.checked,
    ignoreLogins: splitLines(ignoreLoginsEl.value),
    ignorePhrases: splitLines(ignorePhrasesEl.value),
    highlightPhrases: splitLines(highlightPhrasesEl.value),
    highlightLogins: splitLines(highlightLoginsEl.value),
  });

  const paintDisplay = (data: DisplaySettings): void => {
    zoomEl.value = String(nearestZoom(data.fontScale));
    timestampsEl.value = data.showTimestamps ? "hh:mm" : "off";
    ring.applyDisplay(data.fontScale, data.showTimestamps);
  };

  const paintFilters = (data: Filters): void => {
    selfBox.checked = data.enableSelfHighlight;
    ignoreLoginsEl.value = data.ignoreLogins.join("\n");
    ignorePhrasesEl.value = data.ignorePhrases.join("\n");
    highlightPhrasesEl.value = data.highlightPhrases.join("\n");
    highlightLoginsEl.value = data.highlightLogins.join("\n");
  };

  const schedulePreview = (): void => {
    window.clearTimeout(previewTimer);
    previewTimer = window.setTimeout(() => {
      const draft = readDisplayDraft();
      ring.applyDisplay(draft.fontScale, draft.showTimestamps);
    }, 80);
  };

  const selectPage = (id: string): void => {
    for (const tab of tabs) {
      const on = tab.dataset.page === id;
      tab.classList.toggle("is-active", on);
      if (on) {
        tab.setAttribute("aria-current", "page");
      } else {
        tab.removeAttribute("aria-current");
      }
    }
    for (const page of pages) {
      page.classList.toggle("is-active", page.dataset.page === id);
    }
  };

  const applySearch = (raw: string): void => {
    const q = raw.trim().toLowerCase();
    let firstVisible: string | undefined;
    for (const page of pages) {
      const id = page.dataset.page ?? "";
      const tab = [...tabs].find((item) => item.dataset.page === id);
      const nameHay =
        `${tab?.textContent ?? ""} ${tab?.dataset.search ?? ""} ${page.dataset.search ?? ""}`.toLowerCase();
      const nameHit = q.length === 0 || nameHay.includes(q);
      const blocks = page.querySelectorAll<HTMLElement>(".settings-block");
      let contentHit = false;
      if (blocks.length === 0) {
        contentHit = q.length === 0 || (page.textContent ?? "").toLowerCase().includes(q);
      } else {
        for (const block of blocks) {
          const hay = `${block.dataset.search ?? ""} ${block.textContent ?? ""}`.toLowerCase();
          const blockHit = q.length === 0 || hay.includes(q);
          if (blockHit) {
            contentHit = true;
          }
          // Имя вкладки держит страницу открытой; иначе прячем несовпавшие блоки.
          block.hidden = q.length > 0 && !nameHit && !blockHit;
        }
      }
      const show = nameHit || contentHit;
      page.hidden = !show;
      if (tab) {
        tab.hidden = !show;
      }
      if (show && !firstVisible) {
        firstVisible = id;
      }
    }
    const active = modal.querySelector<HTMLElement>(".settings-page.is-active");
    if ((!active || active.hidden) && firstVisible) {
      selectPage(firstVisible);
    }
  };

  const setAppInert = (inert: boolean): void => {
    if (!appRoot) {
      return;
    }
    if (inert) {
      appRoot.setAttribute("inert", "");
    } else {
      appRoot.removeAttribute("inert");
    }
  };

  const closeModal = (restore: boolean): void => {
    window.clearTimeout(previewTimer);
    if (restore) {
      paintDisplay(baselineDisplay);
      paintFilters(baselineFilters);
    }
    setAppInert(false);
    modal.hidden = true;
    statusEl.textContent = "";
    search.value = "";
    applySearch("");
    openBtn.focus();
  };

  const openModal = async (): Promise<void> => {
    statusEl.textContent = "";
    okBtn.disabled = true;
    const errors: string[] = [];
    let displayReady = false;
    let filtersReady = false;
    try {
      baselineDisplay = await invoke<DisplaySettings>("settings_get");
      displayReady = true;
    } catch (err) {
      errors.push(formatError(err));
    }
    try {
      baselineFilters = await invoke<Filters>("filters_get");
      filtersReady = true;
    } catch (err) {
      errors.push(formatError(err));
    }
    if (displayReady) {
      paintDisplay(baselineDisplay);
    }
    if (filtersReady) {
      paintFilters(baselineFilters);
    }
    if (errors.length > 0) {
      statusEl.textContent = errors.join("; ");
    }
    okBtn.disabled = !displayReady || !filtersReady;
    selectPage("general");
    applySearch("");
    modal.hidden = false;
    setAppInert(true);
    search.focus();
  };

  const commit = async (): Promise<void> => {
    if (saving) {
      return;
    }
    saving = true;
    okBtn.disabled = true;
    cancelBtn.disabled = true;
    statusEl.textContent = "";
    window.clearTimeout(previewTimer);
    const displayDraft = readDisplayDraft();
    const filtersDraft = readFiltersDraft();
    let savedDisplay: DisplaySettings | undefined;
    try {
      savedDisplay = await invoke<DisplaySettings>("settings_set", {
        settings: displayDraft,
      });
      const filters = await invoke<Filters>("filters_set", {
        filters: filtersDraft,
      });
      baselineDisplay = savedDisplay;
      baselineFilters = filters;
      paintDisplay(savedDisplay);
      paintFilters(filters);
      closeModal(false);
    } catch (err) {
      if (savedDisplay) {
        try {
          const rolled = await invoke<DisplaySettings>("settings_set", {
            settings: baselineDisplay,
          });
          baselineDisplay = rolled;
          paintDisplay(rolled);
        } catch (rollErr) {
          statusEl.textContent = `${formatError(err)}; откат: ${formatError(rollErr)}`;
          return;
        }
      }
      statusEl.textContent = formatError(err);
    } finally {
      saving = false;
      okBtn.disabled = false;
      cancelBtn.disabled = false;
    }
  };

  openBtn.addEventListener("click", () => {
    void openModal();
  });

  backdrop.addEventListener("click", () => {
    closeModal(true);
  });

  cancelBtn.addEventListener("click", () => {
    closeModal(true);
  });

  okBtn.addEventListener("click", () => {
    void commit();
  });

  for (const tab of tabs) {
    tab.addEventListener("click", () => {
      const id = tab.dataset.page;
      if (id) {
        selectPage(id);
      }
    });
  }

  zoomEl.addEventListener("change", () => {
    schedulePreview();
  });

  timestampsEl.addEventListener("change", () => {
    schedulePreview();
  });

  search.addEventListener("input", () => {
    applySearch(search.value);
  });

  window.addEventListener("keydown", (ev) => {
    if (modal.hidden) {
      return;
    }
    if (ev.key === "f" && ev.ctrlKey && !ev.altKey && !ev.metaKey && !ev.shiftKey) {
      ev.preventDefault();
      search.focus();
      search.select();
      return;
    }
    if (ev.key === "Escape") {
      ev.preventDefault();
      closeModal(true);
      return;
    }
    if (ev.key === "Tab") {
      const items = focusables(dialog);
      if (items.length === 0) {
        ev.preventDefault();
        return;
      }
      const first = items[0];
      const last = items[items.length - 1];
      const active = document.activeElement as HTMLElement | null;
      if (ev.shiftKey) {
        if (!active || active === first || !dialog.contains(active)) {
          ev.preventDefault();
          last.focus();
        }
      } else if (!active || active === last || !dialog.contains(active)) {
        ev.preventDefault();
        first.focus();
      }
    }
  });

  void (async () => {
    try {
      const display = await invoke<DisplaySettings>("settings_get");
      paintDisplay(display);
      baselineDisplay = display;
    } catch {
      /* first run / offline */
    }
  })();
}
