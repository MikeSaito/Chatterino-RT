export async function runStartup(load: () => Promise<void>): Promise<void> {
  const root = document.documentElement;
  const screen = document.querySelector<HTMLElement>("#startup-screen")!;
  const message = document.querySelector<HTMLElement>("#startup-message")!;
  const retry = document.querySelector<HTMLButtonElement>("#startup-retry")!;
  const app = document.querySelector<HTMLElement>("#app")!;
  root.dataset.startup = "loading";
  app.inert = true;
  app.setAttribute("aria-busy", "true");
  screen.hidden = false;
  retry.hidden = true;
  const detail = document.querySelector<HTMLElement>("#startup-error");
  if (detail) {
    detail.hidden = true;
    detail.textContent = "";
  }
  const russian = (navigator.language || "en").toLowerCase().startsWith("ru");
  message.textContent = russian ? "Загрузка чата..." : "Loading chat...";
  retry.textContent = russian ? "Повторить" : "Retry";
  retry.onclick = () => location.reload();
  try {
    const cached = JSON.parse(localStorage.getItem("crt-startup-colors") ?? "null");
    if (cached && /^#[0-9a-f]{6}$/i.test(cached.background) && /^#[0-9a-f]{6}$/i.test(cached.foreground)) {
      root.style.setProperty("--c-window-bg", cached.background);
      root.style.setProperty("--c-window-text", cached.foreground);
      root.style.colorScheme = cached.scheme === "light" ? "light" : "dark";
    }
  } catch {
    // A missing or damaged appearance cache falls back to the stylesheet.
  }
  const slowTimer = setTimeout(() => {
    message.textContent = russian ? "Загрузка занимает больше времени. Можно попробовать снова." : "Loading is taking longer. You can try again.";
    retry.hidden = false;
  }, 15_000);
  try {
    await load();
    await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
    root.dataset.startup = "ready";
    app.inert = false;
    app.removeAttribute("aria-busy");
    screen.hidden = true;
  } catch (error) {
    root.dataset.startup = "error";
    message.textContent = russian ? "Не удалось открыть чат. Попробуйте снова." : "Could not open chat. Try again.";
    if (detail) {
      detail.textContent = error instanceof Error ? error.message : String(error);
      detail.hidden = false;
    }
    retry.hidden = false;
  } finally {
    clearTimeout(slowTimer);
  }
}
