function assert(cond: boolean, msg: string): void {
  if (!cond) {
    throw new Error(msg);
  }
}

function cooldownActive(raw: string | null | undefined, nowMs: number): boolean {
  if (!raw) {
    return false;
  }
  const ms = Date.parse(raw);
  return Number.isFinite(ms) && ms > nowMs;
}

function formatPoints(value: number): string {
  return new Intl.NumberFormat("ru-RU").format(Math.max(0, Math.floor(value)));
}

const now = Date.parse("2026-08-30T12:00:00.000Z");

assert(!cooldownActive("2026-08-30T11:59:59.000Z", now), "past cooldown inactive");
assert(cooldownActive("2026-08-30T12:00:01.000Z", now), "future cooldown active");
assert(!cooldownActive(null, now), "empty cooldown inactive");
assert(!cooldownActive("not-a-date", now), "invalid cooldown inactive");
assert(formatPoints(12345).replace(/\s/g, "") === "12345", "balance grouping");
assert(formatPoints(-3) === "0", "negative balance clamped");

console.log("channel points tests ok");
