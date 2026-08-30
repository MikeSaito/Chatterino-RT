/** Shell chrome: Extended (TV + sidebar) or Classic (Chatterino-like tabs). */

import { t } from "../i18n/index.ts";

export type UiLayout = "Extended" | "Classic";

export function parseUiLayout(raw: unknown): UiLayout {
  return String(raw ?? "") === "Classic" ? "Classic" : "Extended";
}

export function applyUiLayout(
  app: HTMLElement,
  mode: UiLayout,
  opts?: {
    settingsBtn?: HTMLButtonElement | null;
    channelList?: HTMLUListElement | null;
  },
): void {
  app.dataset.uiLayout = mode === "Classic" ? "classic" : "extended";
  if (opts?.settingsBtn) {
    opts.settingsBtn.dataset.uiLayout = mode === "Classic" ? "classic" : "extended";
    const label = t("settings.open");
    if (!opts.settingsBtn.getAttribute("aria-label")) {
      opts.settingsBtn.setAttribute("aria-label", label);
    }
    if (!opts.settingsBtn.title) {
      opts.settingsBtn.title = label;
    }
  }
  if (opts?.channelList) {
    opts.channelList.setAttribute("role", "tablist");
  }
}
