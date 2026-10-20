import { readFileSync } from "node:fs";
import { compareRuns, type Run } from "./performance-gate.ts";
const filename = process.argv[2];
if (!filename) throw new Error("Usage: npm run test:performance-gate -- report.json");
const reports = JSON.parse(readFileSync(filename, "utf8")) as { calibration:Run[]; baseline:Run[]; candidate:Run[] }[];
if (!Array.isArray(reports) || reports.length === 0) throw new Error("No performance scenarios supplied");
const required = new Set(["50-emotes", "200-emotes", "200-scroll-emotes"]);
const failures: string[] = [];
for (const report of reports) {
 const scenario = report.candidate[0]?.scenario;
 if (!required.delete(scenario)) throw new Error(`Unexpected or duplicate scenario: ${scenario}`);
 failures.push(...compareRuns(report.calibration, report.baseline, report.candidate).map(f => `${scenario}: ${f}`));
}
if(required.size) throw new Error(`Missing scenarios: ${[...required].join(", ")}`);
if(failures.length) throw new Error(failures.join("\n"));
console.log("Hardware performance gate passed");
