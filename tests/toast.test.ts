import {
  TOAST_DURATION_DANGER_MS,
  TOAST_DURATION_OK_MS,
  TOAST_MAX_VISIBLE,
  TOAST_QUEUE_CAP,
  clampToastQueueLength,
  defaultToastDuration,
  remainingAfterPause,
  toastAdmission,
} from "../src/shell/toastLogic.ts";

function assert(cond: boolean, msg: string): void {
  if (!cond) {
    throw new Error(msg);
  }
}

assert(TOAST_MAX_VISIBLE === 3, "max visible 3");
assert(TOAST_QUEUE_CAP === 20, "queue cap 20");
assert(defaultToastDuration("success") === TOAST_DURATION_OK_MS, "success dur");
assert(defaultToastDuration("info") === TOAST_DURATION_OK_MS, "info dur");
assert(defaultToastDuration("danger") === TOAST_DURATION_DANGER_MS, "danger dur");
assert(TOAST_DURATION_OK_MS === 4000, "ok 4s");
assert(TOAST_DURATION_DANGER_MS === 6000, "danger 6s");

assert(toastAdmission(0) === "show", "0 show");
assert(toastAdmission(1) === "show", "1 show");
assert(toastAdmission(2) === "show", "2 show");
assert(toastAdmission(3) === "queue", "3 queue");
assert(toastAdmission(5) === "queue", "5 queue");
assert(toastAdmission(2, 2) === "queue", "custom max queue");
assert(toastAdmission(1, 2) === "show", "custom max show");

assert(clampToastQueueLength(5).length === 5 && clampToastQueueLength(5).dropped === 0, "under cap");
assert(clampToastQueueLength(20).dropped === 0, "at cap");
assert(clampToastQueueLength(25).length === 20 && clampToastQueueLength(25).dropped === 5, "over cap");
assert(clampToastQueueLength(10, 8).length === 8 && clampToastQueueLength(10, 8).dropped === 2, "custom cap");

assert(remainingAfterPause(1000, 400) === 600, "pause mid");
assert(remainingAfterPause(1000, 1000) === 0, "pause exact");
assert(remainingAfterPause(1000, 1500) === 0, "pause overdue");
assert(remainingAfterPause(5000, 1000) === 4000, "pause early");

console.log("toast tests ok");
