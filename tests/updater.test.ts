import { checkForUpdates, type UpdaterCheckResult } from "../src/shell/updater.ts";

let confirmCalls = 0;
const originalConfirm = globalThis.confirm;
globalThis.confirm = () => {
  confirmCalls += 1;
  return false;
};

async function run(): Promise<void> {
  // Without Tauri runtime invoke fails; quiet path must not throw.
  const quiet = await checkForUpdates({ beta: false, quiet: true });
  if (quiet !== "error" && quiet !== "skipped") {
    throw new Error(`expected error|skipped without backend, got ${quiet}`);
  }

  const loud = await checkForUpdates({
    beta: false,
    quiet: false,
    onStatus: () => undefined,
    confirmInstall: (_info: UpdaterCheckResult) => false,
  });
  if (loud !== "error" && loud !== "skipped") {
    throw new Error(`expected error|skipped without backend, got ${loud}`);
  }

  globalThis.confirm = originalConfirm;
  console.log("updater tests ok");
}

void run().catch((err: unknown) => {
  globalThis.confirm = originalConfirm;
  console.error(err);
  process.exit(1);
});
