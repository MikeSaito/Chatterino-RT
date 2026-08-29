/** Trailing debounce with cancel/flush (injectable timers for tests). */

export type DebounceTimers = {
  setTimeout: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>;
  clearTimeout: (id: ReturnType<typeof setTimeout>) => void;
};

export type TrailingDebounce = {
  /** Schedule a trailing call; coalesces while waiting. */
  schedule: () => void;
  cancel: () => void;
  /** Run immediately if a call was pending. */
  flush: () => void;
  /** Whether a trailing call is armed. */
  pending: () => boolean;
};

const defaultTimers: DebounceTimers = {
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (id) => clearTimeout(id),
};

export function trailingDebounce(
  fn: () => void,
  waitMs: number,
  timers: DebounceTimers = defaultTimers,
): TrailingDebounce {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let armed = false;

  const clear = (): void => {
    if (timer !== null) {
      timers.clearTimeout(timer);
      timer = null;
    }
  };

  const run = (): void => {
    timer = null;
    armed = false;
    fn();
  };

  return {
    schedule: () => {
      armed = true;
      clear();
      timer = timers.setTimeout(run, waitMs);
    },
    cancel: () => {
      clear();
      armed = false;
    },
    flush: () => {
      if (!armed) {
        return;
      }
      clear();
      run();
    },
    pending: () => armed,
  };
}
