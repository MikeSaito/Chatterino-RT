/** Pure toast queue / timer helpers (no DOM). */

export type ToastKind = "success" | "danger" | "info";

export const TOAST_MAX_VISIBLE = 3;
export const TOAST_QUEUE_CAP = 20;
export const TOAST_DURATION_OK_MS = 4000;
export const TOAST_DURATION_DANGER_MS = 6000;

export function defaultToastDuration(kind: ToastKind): number {
  return kind === "danger" ? TOAST_DURATION_DANGER_MS : TOAST_DURATION_OK_MS;
}

/** Whether a new toast shows immediately or waits in queue. */
export function toastAdmission(
  visibleCount: number,
  maxVisible = TOAST_MAX_VISIBLE,
): "show" | "queue" {
  return visibleCount < maxVisible ? "show" : "queue";
}

/**
 * After a toast is queued: if over cap, drop the oldest queued entry.
 * Returns the next queue length.
 */
export function clampToastQueueLength(
  queueLengthAfterPush: number,
  maxQueue = TOAST_QUEUE_CAP,
): { length: number; dropped: number } {
  if (queueLengthAfterPush <= maxQueue) {
    return { length: queueLengthAfterPush, dropped: 0 };
  }
  const dropped = queueLengthAfterPush - maxQueue;
  return { length: maxQueue, dropped };
}

/** Remaining ms after hover-pause (deadline − now, floored at 0). */
export function remainingAfterPause(deadline: number, now: number): number {
  return Math.max(0, deadline - now);
}
