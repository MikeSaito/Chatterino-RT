import { t } from "../i18n/index.ts";
import type { UpdaterCheckResult, UpdateProgress } from "./updater.ts";

export function createUpdateNotice(info: UpdaterCheckResult) {
  document.querySelector("#update-notice")?.remove();
  const root = document.createElement("section");
  root.id = "update-notice";
  root.className = "update-notice";
  root.setAttribute("aria-label", t("updater.title"));
  const title = document.createElement("h2");
  title.textContent = t("updater.available", { version: info.version });
  const message = document.createElement("p");
  message.setAttribute("role", "status");
  message.setAttribute("aria-live", "polite");
  message.textContent = t("updater.current", { version: info.currentVersion });
  const progress = document.createElement("progress");
  progress.max = 100;
  progress.hidden = true;
  progress.setAttribute("aria-label", t("updater.downloadProgress"));
  const actions = document.createElement("div");
  actions.className = "update-notice-actions";
  const later = document.createElement("button");
  later.type = "button";
  later.className = "btn";
  later.textContent = t("updater.later");
  later.dataset.action = "later";
  const install = document.createElement("button");
  install.type = "button";
  install.className = "btn btn-primary";
  install.textContent = t("updater.install");
  install.dataset.action = "install";
  actions.append(later, install);
  root.append(title, message);
  if (info.body?.trim()) {
    const details = document.createElement("details");
    const summary = document.createElement("summary");
    summary.textContent = t("updater.notes");
    const body = document.createElement("p");
    body.className = "update-notice-notes";
    body.textContent = info.body;
    details.append(summary, body);
    root.append(details);
  }
  root.append(progress, actions);
  document.body.append(root);

  return {
    confirm: () => new Promise<boolean>((resolve) => {
      later.onclick = () => { root.remove(); resolve(false); };
      install.onclick = () => {
        actions.hidden = true;
        resolve(true);
      };
    }),
    progress(event: UpdateProgress) {
      actions.hidden = true;
      progress.hidden = event.phase === "installing";
      progress.removeAttribute("value");
      let text: string;
      switch (event.phase) {
        case "connecting":
          text = t("updater.connecting");
          break;
        case "downloading": {
          const received = (event.downloaded / 1_048_576).toFixed(1);
          if (event.total != null && event.total > 0) {
            const percent = Math.min(100, Math.floor(event.downloaded * 100 / event.total));
            progress.value = percent;
            text = t("updater.downloadedOf", {
              received, total: (event.total / 1_048_576).toFixed(1), percent,
            });
          } else {
            text = t("updater.downloaded", { received });
          }
          break;
        }
        case "verifying":
          text = t("updater.verifying");
          break;
        case "installing":
          text = t("updater.installing");
          break;
      }
      message.textContent = text;
      root.dataset.phase = event.phase;
    },
    finish(text: string, failed = false) {
      root.dataset.phase = failed ? "error" : "finished";
      message.textContent = text;
      progress.hidden = true;
      actions.hidden = false;
      install.hidden = true;
      later.textContent = t("updater.close");
      later.onclick = () => root.remove();
    },
    remove: () => root.remove(),
  };
}
