import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { compareRuns, type Run } from "./performance-gate.ts";
const filename = process.argv[2];
if (!filename) throw new Error("Usage: npm run test:performance-gate -- report.json");
const reports = JSON.parse(readFileSync(filename, "utf8")) as { calibration:Run[]; baseline:Run[]; candidate:Run[] }[];
if (!Array.isArray(reports) || reports.length === 0) throw new Error("No performance scenarios supplied");
const required = new Set(["50-emotes", "200-emotes", "200-scroll-emotes"]);
const failures: string[] = [];
for (const report of reports) {
 if(process.argv.includes("--release")) {
  for(const run of [...report.calibration,...report.baseline,...report.candidate]) {
   const measured=run as Run & {warmupSeconds?:number;measurementSeconds?:number};
   if((run as Run & {dirty?:boolean}).dirty!==false)throw new Error("Release measurements require clean committed source");
   if(measured.warmupSeconds!==120 || measured.measurementSeconds!==1800)throw new Error("Release gate requires 120-second warmup and 1800-second measurement");
  }
 }
 const expectedRevision=process.env.GITHUB_SHA ?? process.env.CRT_RELEASE_REVISION;
 if(process.argv.includes("--release") && expectedRevision) {
  for(const run of report.candidate) {
   const revision=(run as Run & {revision?:string}).revision;
   if(!revision || !/^[a-f0-9]{40}$/.test(revision) || !/^[a-f0-9]{40}$/.test(expectedRevision))throw new Error("Missing source revision");
   if(revision!==expectedRevision) {
    const diff=spawnSync("git",["diff","--quiet",revision,expectedRevision,"--","src","src-tauri","scripts","package.json","package-lock.json","vite.config.ts","index.html","settings.html"],{stdio:"ignore"});
    if(diff.status!==0)throw new Error("Candidate report belongs to different application source");
   }
  }
 }
 const scenario = report.candidate[0]?.scenario;
 if (!required.delete(scenario)) throw new Error(`Unexpected or duplicate scenario: ${scenario}`);
 failures.push(...compareRuns(report.calibration, report.baseline, report.candidate).map(f => `${scenario}: ${f}`));
}
if(required.size) throw new Error(`Missing scenarios: ${[...required].join(", ")}`);
if(failures.length) throw new Error(failures.join("\n"));
console.log("Hardware performance gate passed");
