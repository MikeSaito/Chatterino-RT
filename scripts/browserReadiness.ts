/** Navigation may leave the old, already-ready document active after Page.reload. */
export async function waitForBrowserReady(
  evaluate: (expression: string) => Promise<unknown>,
  options: {
    previousTimeOrigin?: number;
    attempts?: number;
    delayMs?: number;
    sleep?: (ms: number) => Promise<void>;
  } = {},
): Promise<void> {
  const { previousTimeOrigin, attempts = 500, delayMs = 40 } = options;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const newDocument = previousTimeOrigin === undefined
    ? "true"
    : `performance.timeOrigin !== ${JSON.stringify(previousTimeOrigin)}`;
  const expression = `(${newDocument}) && document.readyState !== 'loading' && Boolean(window.__fixture?.ready())`;
  let navigationError = "";
  for (let i = 0; i < attempts; i++) {
    try {
      if (await evaluate(expression)) return;
    } catch (error) {
      const message = String(error);
      // CDP can briefly lose its execution context while the main frame changes.
      if (!/Execution context was destroyed|Cannot find (?:default execution context|context with specified id)|Inspected target navigated or closed/i.test(message)) throw error;
      navigationError = message;
    }
    await sleep(delayMs);
  }
  throw new Error(`UI not ready in ${previousTimeOrigin === undefined ? "initial" : "new"} document${navigationError ? `: ${navigationError}` : ""}`);
}
