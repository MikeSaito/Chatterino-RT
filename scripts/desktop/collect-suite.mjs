import assert from "node:assert/strict";
import { readFileSync,writeFileSync,mkdirSync } from "node:fs";
import { resolve,join } from "node:path";
import { spawnSync } from "node:child_process";
const args=process.argv.slice(2),option=name=>{const i=args.indexOf(name);return i<0?undefined:args[i+1];};
const baseline=option("--baseline-exe"),candidate=option("--candidate-exe");
assert.ok(baseline && candidate,"Usage: --baseline-exe <release validation exe> --candidate-exe <release validation exe>");
const output=resolve(option("--output")??`artifacts/hardware-suite-${Date.now()}`);mkdirSync(output,{recursive:true});
const groups={calibration:[],baseline:[],candidate:[]};
for(const [group,count,exe]of [["calibration",5,baseline],["baseline",3,baseline],["candidate",3,candidate]]) {
 for(let i=0;i<count;i++) {
  const file=join(output,`${group}-${i+1}.json`);
  console.log(`Starting ${group} ${i+1}/${count}; each pass has three 32-minute scenarios`);
  const run=spawnSync(process.execPath,[resolve("scripts/desktop/run.mjs"),"--profile","soak","--exe",resolve(exe),"--output",file],{stdio:"inherit",windowsHide:true});
  assert.equal(run.status,0,`Hardware run failed: ${file}`);
  const report=JSON.parse(readFileSync(file,"utf8"));assert.equal(report.passed,true);groups[group].push(report);
 }
}
const scenarios=["50-emotes","200-emotes","200-scroll-emotes"];
const compared=scenarios.map(scenario=>Object.fromEntries(Object.entries(groups).map(([group,reports])=>[group,reports.map(report=>{const run=report.runs.find(run=>run.scenario===scenario);assert.ok(run);return run;})])));
const report=join(output,"comparison.json");writeFileSync(report,JSON.stringify(compared,null,2)+"\n");
const gate=spawnSync(process.execPath,["--experimental-strip-types",resolve("scripts/check-performance.ts"),report,"--release"],{stdio:"inherit",windowsHide:true});
process.exitCode=gate.status??1;console.log(`Comparison: ${report}`);
