/** Shell chrome: Extended (TV + sidebar) or Classic (Chatterino-like tabs). */

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
    if (!opts.settingsBtn.getAttribute("aria-label")) {
      opts.settingsBtn.setAttribute("aria-label", "Settings");
    }
    if (!opts.settingsBtn.title) {
      opts.settingsBtn.title = "Settings";
    }
  }
  if (opts?.channelList) {
    opts.channelList.setAttribute("role", mode === "Classic" ? "tablist" : "list");
  }
}
