import {
  formatPollCountdown,
  isFinished,
  parsePredictPoints,
  predictErrorText,
  pruneChannelLocks,
  sanitizePanels,
  summaryText,
  voteErrorText,
  type PollPanel,
} from "../src/shell/polls.ts";
import { setLocale } from "../src/i18n/index.ts";

function assert(cond: boolean, msg: string): void {
  if (!cond) {
    throw new Error(msg);
  }
}

setLocale("en");

assert(formatPollCountdown(0) === "0:00", "zero countdown");
assert(formatPollCountdown(1_000) === "0:01", "one second");
assert(formatPollCountdown(65_400) === "1:06", "minute+seconds");

assert(parsePredictPoints("10") === 10, "min stake");
assert(parsePredictPoints("250000") === 250_000, "max stake");
assert(parsePredictPoints("9") === null, "below min");
assert(parsePredictPoints("250001") === null, "above max");
assert(parsePredictPoints("10.5") === null, "fraction rejected");
assert(parsePredictPoints("-10") === null, "negative rejected");
assert(parsePredictPoints("01") === null, "leading zero rejected");
assert(parsePredictPoints("0") === null, "zero rejected");

{
  const voted = new Set(["poll-a", "poll-b"]);
  const predicted = new Set(["pred-a"]);
  const out = pruneChannelLocks({
    prev: [
      {
        kind: "poll",
        id: "poll-a",
        title: "A",
        status: "ACTIVE",
        totalVotes: 1,
        options: [{ id: "1", title: "1", votes: 1 }],
      },
      {
        kind: "prediction",
        id: "pred-a",
        title: "P",
        status: "ACTIVE",
        totalVotes: 1,
        options: [{ id: "1", title: "1", votes: 1 }],
      },
    ],
    next: [
      {
        kind: "poll",
        id: "poll-a",
        title: "A",
        status: "ACTIVE",
        totalVotes: 2,
        options: [{ id: "1", title: "1", votes: 2 }],
      },
    ],
    voted,
    predicted,
    betPanelId: "pred-a",
  });
  assert(voted.has("poll-a"), "kept poll lock for surviving panel");
  assert(voted.has("poll-b"), "locks from other channels untouched");
  assert(!predicted.has("pred-a"), "removed prediction lock for channel clear");
  assert(out.betPanelId === "", "cleared bet form for removed panel");
  assert(out.removed.includes("pred-a"), "reports removed id");
}

assert(voteErrorText("POLL_NOT_ACTIVE").includes("not accepting"), "vote error mapped");
assert(voteErrorText("NOPE") === "Could not submit vote", "vote error fallback");
assert(predictErrorText("NOT_ENOUGH_POINTS").includes("Not enough"), "predict error mapped");
assert(predictErrorText(undefined) === "Could not place prediction", "predict error fallback");

const active: PollPanel = {
  kind: "poll",
  id: "p1",
  title: "Next map?",
  status: "ACTIVE",
  totalVotes: 10,
  options: [
    { id: "a", title: "A", votes: 4 },
    { id: "b", title: "B", votes: 6, isWinner: false },
  ],
};
assert(!isFinished(active), "active not finished");
assert(summaryText(active) === "", "active has no summary");

const finished: PollPanel = {
  ...active,
  status: "COMPLETED",
  options: [
    { id: "a", title: "A", votes: 4 },
    { id: "b", title: "B", votes: 6, isWinner: true },
  ],
  winningOptionId: "b",
};
assert(isFinished(finished), "completed finished");
assert(
  summaryText(finished) === "Winner: B (60%)",
  `finished summary got ${summaryText(finished)}`,
);

const sanitized = sanitizePanels([
  {
    kind: "prediction",
    id: "pred-1",
    title: "Win?",
    status: "LOCKED",
    totalVotes: 3,
    options: [
      { id: "yes", title: "Yes", votes: 2, points: 500, color: "blue" },
      { id: "no", title: "No", votes: 1, points: 100, color: "pink" },
    ],
  },
  { kind: "poll", id: "", title: "bad", status: "ACTIVE", options: [] },
]);
assert(sanitized.length === 1, "invalid panel dropped");
assert(sanitized[0].status === "LOCKED", "locked status kept");

const replaced = sanitizePanels([
  {
    kind: "poll",
    id: "old",
    title: "Old",
    status: "COMPLETED",
    endedAt: new Date().toISOString(),
    totalVotes: 1,
    options: [{ id: "a", title: "A", votes: 1, isWinner: true }],
  },
  {
    kind: "poll",
    id: "new",
    title: "New",
    status: "ACTIVE",
    totalVotes: 2,
    options: [
      { id: "a", title: "A", votes: 1 },
      { id: "b", title: "B", votes: 1 },
    ],
  },
]);
assert(replaced.length === 1, "one poll kind kept");
assert(replaced[0].id === "new", "active poll preferred over finished");

console.log("polls panel tests ok");
