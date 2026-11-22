import { runStartup } from "./shell/startupScreen";

void runStartup(async () => {
  const { startApp } = await import("./main");
  await startApp();
});
