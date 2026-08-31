import { invoke } from "@tauri-apps/api/core";
import { relaunch } from "@tauri-apps/plugin-process";
import { t } from "../i18n/index.ts";
import { formatInvokeError } from "../i18n/formatError.ts";

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

/**
 * Check for updates; optionally download, install, and relaunch.
 * If updater is not ready (missing pubkey/endpoint), returns without applying an update.
 * Startup (`quiet`) still prompts via confirm when an update is found.
 */
export async function checkForUpdates(
  opts: {
    beta: boolean;
    /** Suppress status text for “not configured” / “up to date”; confirm still shown if update found. */
    quiet?: boolean;
    confirmInstall?: (info: UpdaterCheckResult) => boolean;
    onStatus?: (message: string) => void;
  },
): Promise<"ready" | "none" | "installed" | "skipped" | "error"> {
  const report = (msg: string): void => {
    opts.onStatus?.(msg);
  };
  try {
    const status = await invoke<UpdaterStatus>("updater_status", {
      beta: opts.beta,
    });
    if (!status.ready) {
      if (!opts.quiet) {
        report(t("updater.notConfigured"));
      }
      return "skipped";
    }
    if (!opts.quiet) {
      report(t("updater.checking"));
    }
    const found = await invoke<UpdaterCheckResult | null>("updater_check", {
      beta: opts.beta,
    });
    if (!found) {
      if (!opts.quiet) {
        report(t("updater.upToDate", { version: status.currentVersion }));
      }
      return "none";
    }
    const ok =
      opts.confirmInstall?.(found) ??
      window.confirm(
        t("updater.availableConfirm", {
          version: found.version,
          current: found.currentVersion,
        }),
      );
    if (!ok) {
      await invoke("updater_clear_pending").catch(() => undefined);
      report(t("updater.declined"));
      return "skipped";
    }
    report(t("updater.downloading", { version: found.version }));
    await invoke("updater_install", { expectedVersion: found.version });
    report(t("updater.installed"));
    try {
      await relaunch();
    } catch {
      report(t("updater.relaunchFailed"));
    }
    return "installed";
  } catch (e: unknown) {
    await invoke("updater_clear_pending").catch(() => undefined);
    const msg = formatInvokeError(e);
    if (!opts.quiet) {
      report(msg || t("updater.failed"));
    }
    return "error";
  }
}
