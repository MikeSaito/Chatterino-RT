import { Channel, invoke } from "@tauri-apps/api/core";
import { relaunch } from "@tauri-apps/plugin-process";
import { t } from "../i18n/index.ts";
import { formatInvokeError } from "../i18n/formatError.ts";
import { createUpdateNotice } from "./updateNotice.ts";

export type UpdaterStatus = {
  ready: boolean;
  currentVersion: string;
  reason: string;
};

export type UpdaterCheckResult = {
  version: string;
  currentVersion: string;
  body: string | null;
  date: string | null;
};

export type UpdateProgress =
  | { phase: "connecting" }
  | { phase: "downloading"; downloaded: number; total: number | null }
  | { phase: "verifying" }
  | { phase: "installing" };

type UpdateResult = "ready" | "none" | "installed" | "skipped" | "error";
type UpdateOptions = {
  beta: boolean;
  quiet?: boolean;
  confirmInstall?: (info: UpdaterCheckResult) => boolean | Promise<boolean>;
  onStatus?: (message: string) => void;
  onProgress?: (progress: UpdateProgress) => void;
};

let running: Promise<UpdateResult> | undefined;

export function checkForUpdates(opts: UpdateOptions): Promise<UpdateResult> {
  if (running) return running;
  running = runUpdate(opts).finally(() => { running = undefined; });
  return running;
}

async function runUpdate(opts: UpdateOptions): Promise<UpdateResult> {
  const report = (message: string) => opts.onStatus?.(message);
  let notice: ReturnType<typeof createUpdateNotice> | undefined;
  let active = true;
  try {
    const status = await invoke<UpdaterStatus>("updater_status", { beta: opts.beta });
    if (!status.ready) {
      if (!opts.quiet) report(t("updater.notConfigured"));
      return "skipped";
    }
    if (!opts.quiet) report(t("updater.checking"));
    const found = await invoke<UpdaterCheckResult | null>("updater_check", { beta: opts.beta });
    if (!found) {
      if (!opts.quiet) report(t("updater.upToDate", { version: status.currentVersion }));
      return "none";
    }
    if (typeof document !== "undefined") notice = createUpdateNotice(found);
    const accepted = opts.confirmInstall
      ? await opts.confirmInstall(found)
      : await notice?.confirm();
    if (!accepted) {
      notice?.remove();
      await invoke("updater_clear_pending").catch(() => undefined);
      report(t("updater.declined"));
      return "skipped";
    }
    const onEvent = new Channel<UpdateProgress>();
    onEvent.onmessage = (event) => {
      if (!active) return;
      notice?.progress(event);
      opts.onProgress?.(event);
    };
    notice?.progress({ phase: "connecting" });
    report(t("updater.downloading", { version: found.version }));
    await invoke("updater_install", { expectedVersion: found.version, onEvent });
    notice?.finish(t("updater.installed"));
    report(t("updater.installed"));
    try {
      await relaunch();
    } catch {
      notice?.finish(t("updater.relaunchFailed"));
      report(t("updater.relaunchFailed"));
    }
    return "installed";
  } catch (error: unknown) {
    const message = formatInvokeError(error) || t("updater.failed");
    notice?.finish(message, true);
    if (!opts.quiet || notice) report(message);
    return "error";
  } finally {
    active = false;
  }
}
