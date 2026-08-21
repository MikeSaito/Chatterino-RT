import { invoke } from "@tauri-apps/api/core";
import type { MessageRing } from "../../chat/ring";
import type { Filters } from "../../chat/types";
import {
  SETTINGS_PAGES,
  ZOOM_LEVELS,
  defaultAppSettingsTables,
  defaultKnobs,
  type KnobDef,
  type PageDef,
  type TableDef,
} from "./catalog";
import { mountEditableTable } from "./editableTable";

export type AppSettings = {
  fontScale: number;
  showTimestamps: boolean;
  hideModerated: boolean;
  timestampFormat: string;
  knobs: Record<string, boolean | string | number | null>;
  nicknames: Record<string, string | boolean>[];
  commands: Record<string, string | boolean>[];
  highlightMessages: Record<string, string | boolean>[];
  highlightUsers: Record<string, string | boolean>[];
  highlightBadges: Record<string, string | boolean>[];
  highlightBlacklist: Record<string, string | boolean>[];
  ignoreMessages: Record<string, string | boolean>[];
  ignoreUsers: Record<string, string | boolean>[];
  filters: Record<string, string | boolean>[];
  enableSelfHighlight: boolean;
  hotkeys: Record<string, string | boolean>[];
  modActions: Record<string, string | boolean>[];
  logChannels: Record<string, string | boolean>[];
  notifyChannels: Record<string, string | boolean>[];
};

type TableApi = {
  getRows: () => Record<string, string | boolean>[];
  setRows: (rows: Record<string, string | boolean>[]) => void;
};

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
  return "error";
}

function nearestZoom(scale: number): number {
  let best = ZOOM_LEVELS[0] ? Number(ZOOM_LEVELS[0].value) : 1;
  let bestDist = Math.abs(scale - best);
  for (const item of ZOOM_LEVELS) {
    const v = Number(item.value);
    const dist = Math.abs(scale - v);
    if (dist < bestDist) {
      best = v;
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

function emptySettings(): AppSettings {
  return {
    fontScale: 1,
    showTimestamps: true,
    hideModerated: false,
    timestampFormat: "hh:mm",
    knobs: { ...defaultKnobs() },
    enableSelfHighlight: true,
    ...defaultAppSettingsTables(),
  };
}

function tablePathGet(data: AppSettings, path: string): Record<string, string | boolean>[] {
  const key = path as keyof AppSettings;
  const value = data[key];
  return Array.isArray(value) ? (value as Record<string, string | boolean>[]) : [];
}

function filtersFromSettings(data: AppSettings): Filters {
  return {
    enableSelfHighlight: data.enableSelfHighlight,
    ignoreLogins: data.ignoreUsers
      .map((row) => String(row.username ?? "").trim())
      .filter(Boolean),
    ignorePhrases: data.ignoreMessages
      .filter((row) => row.block !== false)
      .map((row) => String(row.pattern ?? "").trim())
      .filter(Boolean),
    highlightPhrases: data.highlightMessages
      .map((row) => String(row.pattern ?? "").trim())
      .filter(Boolean),
    highlightLogins: data.highlightUsers
      .map((row) => String(row.username ?? "").trim())
      .filter(Boolean),
  };
}

function migrateFiltersIntoSettings(data: AppSettings, filters: Filters): AppSettings {
  const next = { ...data, enableSelfHighlight: filters.enableSelfHighlight };
  if (next.highlightMessages.length === 0 && filters.highlightPhrases.length > 0) {
    next.highlightMessages = filters.highlightPhrases.map((pattern) => ({
      pattern,
      showInMentions: true,
      flashTaskbar: false,
      regex: false,
      caseSensitive: false,
      playSound: false,
      customSound: "",
      color: "",
    }));
  }
  if (next.highlightUsers.length === 0 && filters.highlightLogins.length > 0) {
    next.highlightUsers = filters.highlightLogins.map((username) => ({
      username,
      showInMentions: true,
      flashTaskbar: false,
      playSound: false,
      customSound: "",
      color: "",
    }));
  }
  if (next.ignoreMessages.length === 0 && filters.ignorePhrases.length > 0) {
    next.ignoreMessages = filters.ignorePhrases.map((pattern) => ({
      pattern,
      regex: false,
      caseSensitive: false,
      block: true,
      replacement: "",
    }));
  }
  if (next.ignoreUsers.length === 0 && filters.ignoreLogins.length > 0) {
    next.ignoreUsers = filters.ignoreLogins.map((username) => ({
      username,
      regex: false,
    }));
  }
  return next;
}

function applyDisplay(
  ring: MessageRing,
  data: AppSettings,
  onDisplay?: (data: AppSettings) => void,
): void {
  ring.applyDisplay(
    data.fontScale,
    data.showTimestamps,
    data.hideModerated,
    data.timestampFormat,
    data.knobs["appearance.alternateMessages"] === true,
    data.knobs["appearance.separateMessages"] === true,
    data.knobs["appearance.hideModerationActions"] === true,
    data.knobs["appearance.showReplyButton"] === true,
  );
  const root = document.documentElement;
  root.style.setProperty("--chat-ui-scale", String(data.fontScale));
  onDisplay?.(data);
}

export function bindSettingsDialog(opts: {
  ring: MessageRing;
  openBtn: HTMLButtonElement;
  modal: HTMLElement;
  onDisplay?: (data: AppSettings) => void;
}): void {
  const { ring, openBtn, modal, onDisplay } = opts;
  const appRoot = document.querySelector<HTMLElement>("#app");
  const dialog = modal.querySelector<HTMLElement>("#settings-dialog");
  const backdrop = modal.querySelector<HTMLElement>("#settings-backdrop");
  const search = modal.querySelector<HTMLInputElement>("#settings-search");
  const tabsHost = modal.querySelector<HTMLElement>("#settings-tabs");
  const pagesHost = modal.querySelector<HTMLElement>("#settings-pages");
  const okBtn = modal.querySelector<HTMLButtonElement>("#settings-ok");
  const cancelBtn = modal.querySelector<HTMLButtonElement>("#settings-cancel");
  const statusEl = modal.querySelector<HTMLElement>("#settings-status");
  if (!dialog || !backdrop || !search || !tabsHost || !pagesHost || !okBtn || !cancelBtn || !statusEl) {
    return;
  }

  const knobInputs = new Map<string, HTMLInputElement | HTMLSelectElement>();
  const tableApis = new Map<string, TableApi>();
  let baseline: AppSettings = emptySettings();
  let baselineFilters: Filters = {
    enableSelfHighlight: true,
    ignoreLogins: [],
    ignorePhrases: [],
    highlightPhrases: [],
    highlightLogins: [],
  };
  let activePage = "general";
  let saving = false;
  let loadReady = false;

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

  const renderKnob = (knob: KnobDef, block: HTMLElement): void => {
    if (knob.type === "label") {
      const p = document.createElement("p");
      p.className = "settings-label-note";
      p.textContent = knob.label;
      p.dataset.search = `${knob.label} ${knob.search ?? ""}`;
      block.append(p);
      return;
    }
    if (knob.type === "button") {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "settings-action-btn";
      btn.textContent = knob.label;
      btn.dataset.search = `${knob.label} ${knob.search ?? ""}`;
      btn.addEventListener("click", () => {
        statusEl.textContent = "This action is not available in Chatterino RT yet.";
      });
      block.append(btn);
      return;
    }
    if (knob.type === "checkbox") {
      const label = document.createElement("label");
      label.className = "filters-check";
      label.dataset.search = `${knob.label} ${knob.search ?? ""}`;
      const input = document.createElement("input");
      input.type = "checkbox";
      input.id = `settings-knob-${knob.id}`;
      input.dataset.path = knob.path;
      if (knob.inverse) {
        input.dataset.inverse = "1";
      }
      label.append(input, document.createTextNode(` ${knob.label}`));
      block.append(label);
      knobInputs.set(knob.path, input);
      input.addEventListener("change", () => {
        schedulePreview();
      });
      return;
    }
    const row = document.createElement("div");
    row.className = "settings-row";
    row.dataset.search = `${knob.label} ${knob.search ?? ""}`;
    const lab = document.createElement("label");
    lab.htmlFor = `settings-knob-${knob.id}`;
    lab.textContent = knob.label;
    let input: HTMLInputElement | HTMLSelectElement;
    if (knob.type === "select") {
      const select = document.createElement("select");
      select.id = `settings-knob-${knob.id}`;
      for (const option of knob.options ?? []) {
        const opt = document.createElement("option");
        opt.value = option.value;
        opt.textContent = option.label;
        select.append(opt);
      }
      input = select;
    } else {
      const el = document.createElement("input");
      el.id = `settings-knob-${knob.id}`;
      if (knob.type === "number") {
        el.type = "number";
        if (knob.min != null) {
          el.min = String(knob.min);
        }
        if (knob.max != null) {
          el.max = String(knob.max);
        }
        if (knob.step != null) {
          el.step = String(knob.step);
        }
      } else if (knob.type === "color") {
        el.type = "color";
      } else {
        el.type = "text";
      }
      input = el;
    }
    input.dataset.path = knob.path;
    row.append(lab, input);
    block.append(row);
    knobInputs.set(knob.path, input);
    input.addEventListener("change", () => {
      schedulePreview();
    });
    input.addEventListener("input", () => {
      schedulePreview();
    });
  };

  const mountTable = (host: HTMLElement, def: TableDef): void => {
    const api = mountEditableTable(
      host,
      {
        columns: def.columns,
        blankRow: { ...def.blankRow },
        rows: [],
      },
      () => {
        statusEl.textContent = "";
      },
    );
    tableApis.set(def.path, api);
  };

  const buildPages = (): void => {
    tabsHost.replaceChildren();
    pagesHost.replaceChildren();
    knobInputs.clear();
    tableApis.clear();

    const groups = [
      ["general"],
      ["accounts", "nicknames"],
      ["commands", "highlights", "ignores", "filters"],
      ["hotkeys", "moderation", "notifications", "external"],
      ["about"],
    ];
    for (let gi = 0; gi < groups.length; gi += 1) {
      if (gi > 0) {
        const gap = document.createElement("div");
        gap.className = "settings-tab-gap";
        gap.setAttribute("aria-hidden", "true");
        tabsHost.append(gap);
      }
      if (gi === groups.length - 1) {
        const spacer = document.createElement("div");
        spacer.className = "settings-tab-spacer";
        spacer.setAttribute("aria-hidden", "true");
        tabsHost.append(spacer);
      }
      for (const id of groups[gi]) {
        const page = SETTINGS_PAGES.find((p) => p.id === id);
        if (!page) {
          continue;
        }
        const tab = document.createElement("button");
        tab.type = "button";
        tab.className = "settings-tab";
        tab.dataset.page = page.id;
        tab.dataset.search = `${page.navLabel} ${page.search}`;
        tab.textContent = page.navLabel;
        tab.addEventListener("click", () => {
          showPage(page.id);
        });
        tabsHost.append(tab);
        pagesHost.append(buildPage(page));
      }
    }
  };

  const buildPage = (page: PageDef): HTMLElement => {
    const section = document.createElement("section");
    section.className = "settings-page";
    section.dataset.page = page.id;
    section.dataset.search = `${page.title} ${page.search}`;
    const title = document.createElement("h3");
    title.className = "settings-page-title";
    title.textContent = page.title;
    section.append(title);

    if (page.kind === "about") {
      const name = document.createElement("p");
      name.className = "settings-about-name";
      name.textContent = "Chatterino RT";
      const about = document.createElement("p");
      about.className = "settings-empty";
      about.textContent =
        "Hybrid Tauri + Pixi. Chat behaviour follows Chatterino 2 logic (MIT) without Qt windows.";
      const oss = document.createElement("p");
      oss.className = "settings-empty";
      oss.textContent =
        "Open source: Tauri, PixiJS, and Twitch IRC. Settings UI layout mirrors stock Chatterino.";
      section.append(name, about, oss);
      return section;
    }

    if (page.kind === "accounts") {
      const note = document.createElement("p");
      note.className = "settings-empty";
      note.textContent =
        "Twitch login is in the chat sidebar. Add / Remove / reorder of multiple accounts will use the same auth commands.";
      const list = document.createElement("ul");
      list.className = "settings-accounts-list";
      list.id = "settings-accounts-list";
      section.append(note, list);
      return section;
    }

    if (page.kind === "table" && page.table) {
      const host = document.createElement("div");
      host.dataset.search = page.search;
      mountTable(host, page.table);
      section.append(host);
      for (const block of page.sections ?? []) {
        const wrap = document.createElement("div");
        wrap.className = "settings-block";
        wrap.dataset.search = block.title;
        const h = document.createElement("h4");
        h.className = "settings-section";
        h.textContent = block.title;
        wrap.append(h);
        for (const knob of block.knobs) {
          renderKnob(knob, wrap);
        }
        section.append(wrap);
      }
      return section;
    }

    if (page.kind === "hotkeys" && page.table) {
      const host = document.createElement("div");
      mountTable(host, page.table);
      section.append(host);
      return section;
    }

    if (page.kind === "nested-tabs" && page.tabs) {
      const tabBar = document.createElement("div");
      tabBar.className = "settings-inner-tabs";
      const panels = document.createElement("div");
      panels.className = "settings-inner-panels";
      page.tabs.forEach((tab, index) => {
        const btn = document.createElement("button");
        btn.type = "button";
        btn.className = index === 0 ? "settings-inner-tab is-active" : "settings-inner-tab";
        btn.textContent = tab.label;
        const panel = document.createElement("div");
        panel.className = index === 0 ? "settings-inner-panel is-active" : "settings-inner-panel";
        panel.hidden = index !== 0;
        if (tab.table) {
          const host = document.createElement("div");
          mountTable(host, tab.table);
          panel.append(host);
        }
        for (const block of tab.sections ?? []) {
          const wrap = document.createElement("div");
          wrap.className = "settings-block";
          wrap.dataset.search = block.title;
          const h = document.createElement("h4");
          h.className = "settings-section";
          h.textContent = block.title;
          wrap.append(h);
          for (const knob of block.knobs) {
            renderKnob(knob, wrap);
          }
          panel.append(wrap);
        }
        btn.addEventListener("click", () => {
          tabBar.querySelectorAll(".settings-inner-tab").forEach((el) => {
            el.classList.remove("is-active");
          });
          panels.querySelectorAll(".settings-inner-panel").forEach((el) => {
            el.classList.remove("is-active");
            (el as HTMLElement).hidden = true;
          });
          btn.classList.add("is-active");
          panel.classList.add("is-active");
          panel.hidden = false;
        });
        tabBar.append(btn);
        panels.append(panel);
      });
      section.append(tabBar, panels);
      for (const block of page.sections ?? []) {
        const wrap = document.createElement("div");
        wrap.className = "settings-block";
        wrap.dataset.search = block.title;
        const h = document.createElement("h4");
        h.className = "settings-section";
        h.textContent = block.title;
        wrap.append(h);
        for (const knob of block.knobs) {
          renderKnob(knob, wrap);
        }
        section.append(wrap);
      }
      return section;
    }

    for (const block of page.sections ?? []) {
      const wrap = document.createElement("div");
      wrap.className = "settings-block";
      wrap.dataset.search = block.title;
      const h = document.createElement("h4");
      h.className = "settings-section";
      h.textContent = block.title;
      wrap.append(h);
      for (const knob of block.knobs) {
        renderKnob(knob, wrap);
      }
      section.append(wrap);
    }
    return section;
  };

  const showPage = (id: string): void => {
    activePage = id;
    tabsHost.querySelectorAll<HTMLButtonElement>(".settings-tab").forEach((tab) => {
      tab.classList.toggle("is-active", tab.dataset.page === id);
    });
    pagesHost.querySelectorAll<HTMLElement>(".settings-page").forEach((page) => {
      page.classList.toggle("is-active", page.dataset.page === id);
    });
  };

  const readDraft = (): AppSettings => {
    const draft = emptySettings();
    draft.knobs = { ...baseline.knobs };
    for (const [path, input] of knobInputs) {
      if (path === "__wired.fontScale" && input instanceof HTMLSelectElement) {
        draft.fontScale = nearestZoom(Number(input.value));
        continue;
      }
      if (path === "__wired.timestampFormat" && input instanceof HTMLSelectElement) {
        draft.timestampFormat = input.value;
        draft.showTimestamps = input.value !== "Disable";
        continue;
      }
      if (path === "__wired.hideModerated" && input instanceof HTMLInputElement) {
        draft.hideModerated = input.checked;
        continue;
      }
      if (path === "__wired.enableSelfHighlight" && input instanceof HTMLInputElement) {
        draft.enableSelfHighlight = input.checked;
        continue;
      }
      if (path.startsWith("__")) {
        continue;
      }
      if (input instanceof HTMLInputElement && input.type === "checkbox") {
        const checked = input.checked;
        draft.knobs[path] = input.dataset.inverse === "1" ? !checked : checked;
      } else if (input instanceof HTMLInputElement && input.type === "number") {
        draft.knobs[path] = Number(input.value);
      } else {
        draft.knobs[path] = input.value;
      }
    }
    for (const [path, api] of tableApis) {
      const rows = api.getRows();
      (draft as unknown as Record<string, unknown>)[path] = rows;
    }
    return draft;
  };

  const paintDraft = (data: AppSettings): void => {
    for (const [path, input] of knobInputs) {
      if (path === "__wired.fontScale" && input instanceof HTMLSelectElement) {
        input.value = String(nearestZoom(data.fontScale));
        continue;
      }
      if (path === "__wired.timestampFormat" && input instanceof HTMLSelectElement) {
        input.value = data.timestampFormat || (data.showTimestamps ? "hh:mm" : "Disable");
        continue;
      }
      if (path === "__wired.hideModerated" && input instanceof HTMLInputElement) {
        input.checked = data.hideModerated;
        continue;
      }
      if (path === "__wired.enableSelfHighlight" && input instanceof HTMLInputElement) {
        input.checked = data.enableSelfHighlight;
        continue;
      }
      if (path.startsWith("__")) {
        continue;
      }
      const raw = data.knobs[path];
      if (input instanceof HTMLInputElement && input.type === "checkbox") {
        const stored = typeof raw === "boolean" ? raw : Boolean(raw);
        input.checked = input.dataset.inverse === "1" ? !stored : stored;
      } else if (input instanceof HTMLInputElement && input.type === "number") {
        input.value = String(typeof raw === "number" ? raw : Number(raw) || 0);
      } else if (raw != null) {
        input.value = String(raw);
      }
    }
    for (const [path, api] of tableApis) {
      api.setRows(tablePathGet(data, path));
    }
    applyDisplay(ring, data, onDisplay);
  };

  let previewTimer = 0;
  const schedulePreview = (): void => {
    window.clearTimeout(previewTimer);
    previewTimer = window.setTimeout(() => {
      applyDisplay(ring, readDraft(), onDisplay);
    }, 50);
  };

  const applySearch = (query: string): void => {
    const q = query.trim().toLowerCase();
    tabsHost.querySelectorAll<HTMLButtonElement>(".settings-tab").forEach((tab) => {
      const hay = (tab.dataset.search ?? tab.textContent ?? "").toLowerCase();
      tab.hidden = q.length > 0 && !hay.includes(q);
    });
    pagesHost.querySelectorAll<HTMLElement>(".settings-page").forEach((page) => {
      const pageHay = (page.dataset.search ?? "").toLowerCase();
      let pageMatch = q.length === 0 || pageHay.includes(q);
      page.querySelectorAll<HTMLElement>("[data-search]").forEach((el) => {
        if (el.classList.contains("settings-page")) {
          return;
        }
        const hay = (el.dataset.search ?? el.textContent ?? "").toLowerCase();
        const match = q.length === 0 || hay.includes(q) || pageHay.includes(q);
        el.hidden = !match;
        if (match) {
          pageMatch = true;
        }
      });
      if (q.length > 0) {
        const tab = tabsHost.querySelector<HTMLButtonElement>(
          `.settings-tab[data-page="${page.dataset.page}"]`,
        );
        if (tab && pageMatch) {
          tab.hidden = false;
        }
      }
    });
  };

  const closeModal = (restore: boolean): void => {
    window.clearTimeout(previewTimer);
    if (restore) {
      paintDraft(baseline);
    }
    modal.hidden = true;
    setAppInert(false);
    search.value = "";
    applySearch("");
    statusEl.textContent = "";
    openBtn.focus();
  };

  const openModal = async (): Promise<void> => {
    statusEl.textContent = "";
    loadReady = false;
    okBtn.disabled = true;
    try {
      const loaded = await invoke<AppSettings>("settings_get");
      const filters = await invoke<Filters>("filters_get");
      baselineFilters = filters;
      baseline = migrateFiltersIntoSettings(
        {
          ...emptySettings(),
          ...loaded,
          knobs: { ...defaultKnobs(), ...(loaded.knobs ?? {}) },
          enableSelfHighlight: filters.enableSelfHighlight,
        },
        filters,
      );
      loadReady = true;
      okBtn.disabled = false;
    } catch (err) {
      statusEl.textContent = formatError(err);
      baseline = emptySettings();
      loadReady = false;
      okBtn.disabled = true;
    }
    paintDraft(baseline);
    modal.hidden = false;
    setAppInert(true);
    showPage(activePage);
    search.focus();
  };

  const saveModal = async (): Promise<void> => {
    if (saving || !loadReady) {
      return;
    }
    saving = true;
    okBtn.disabled = true;
    cancelBtn.disabled = true;
    statusEl.textContent = "";
    const draft = readDraft();
    const filtersDraft = filtersFromSettings(draft);
    let saved: AppSettings | undefined;
    try {
      saved = await invoke<AppSettings>("settings_set", { settings: draft });
      const filters = await invoke<Filters>("filters_set", { filters: filtersDraft });
      baseline = {
        ...emptySettings(),
        ...saved,
        knobs: { ...defaultKnobs(), ...(saved.knobs ?? {}) },
        enableSelfHighlight: filters.enableSelfHighlight,
      };
      baselineFilters = filters;
      paintDraft(baseline);
      closeModal(false);
    } catch (err) {
      if (saved) {
        try {
          const rolled = await invoke<AppSettings>("settings_set", {
            settings: baseline,
          });
          baseline = {
            ...emptySettings(),
            ...rolled,
            knobs: { ...defaultKnobs(), ...(rolled.knobs ?? {}) },
            enableSelfHighlight: baselineFilters.enableSelfHighlight,
          };
          paintDraft(baseline);
        } catch (rollErr) {
          statusEl.textContent = `${formatError(err)}; rollback: ${formatError(rollErr)}`;
          return;
        }
      }
      statusEl.textContent = formatError(err);
    } finally {
      saving = false;
      okBtn.disabled = !loadReady;
      cancelBtn.disabled = false;
    }
  };

  buildPages();
  showPage("general");

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
    void saveModal();
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
      const display = await invoke<AppSettings>("settings_get");
      const merged = {
        ...emptySettings(),
        ...display,
        knobs: { ...defaultKnobs(), ...(display.knobs ?? {}) },
      };
      applyDisplay(ring, merged, onDisplay);
    } catch {
      applyDisplay(ring, emptySettings(), onDisplay);
    }
  })();
}
