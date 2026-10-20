export type Metric = { processingP95Ms: number; frameP95Ms: number; longFrameRatio: number; privateBytes: number; memoryGrowthBytes: number };
export type Run = { environment: string; build: string; scenario: string; generated: number; processed: number; crashed: boolean; metrics: Metric };
export const median = (values: number[]): number => {
 const sorted = [...values].sort((a,b) => a-b), n = sorted.length;
 if (!n || sorted.some(n => !Number.isFinite(n))) throw new Error("Missing or non-finite measurements");
 return n % 2 ? sorted[n >> 1] : (sorted[n/2-1] + sorted[n/2])/2;
};
export function compareRuns(calibration: Run[], baseline: Run[], candidate: Run[]): string[] {
 if (calibration.length !== 5 || baseline.length !== 3 || candidate.length !== 3) throw new Error("Require five calibration, three baseline and three candidate runs per scenario");
 const all = [...calibration, ...baseline, ...candidate];
 if (new Set(all.map(r => r.environment)).size !== 1 || !all[0].environment) throw new Error("Environment changed: recalibrate baseline");
 if (new Set(all.map(r => r.scenario)).size !== 1) throw new Error("Compare one scenario at a time");
 if (new Set([...calibration, ...baseline].map(r => r.build)).size !== 1 || new Set(candidate.map(r => r.build)).size !== 1) throw new Error("Mixed build identities");
 for (const run of all) {
  if (typeof run.environment !== "string" || !run.environment.trim() ||
      typeof run.build !== "string" || !run.build.trim() ||
      typeof run.scenario !== "string" || !run.scenario.trim() ||
      typeof run.crashed !== "boolean") throw new Error("Incomplete run identity or crash status");
  for (const key of ["processingP95Ms", "frameP95Ms", "longFrameRatio", "privateBytes", "memoryGrowthBytes"] as (keyof Metric)[]) {
   const value = run.metrics?.[key];
   if (typeof value !== "number" || !Number.isFinite(value) ||
       (key !== "memoryGrowthBytes" && value < 0) ||
       (key === "longFrameRatio" && value > 1)) throw new Error(`Invalid measurement: ${key}`);
  }
 }
 const failures: string[] = [];
 for (const r of all) if (r.crashed || !Number.isSafeInteger(r.generated) || r.generated <= 0 || r.processed !== r.generated) failures.push(`${r.build}: crash or lost messages`);
 for (const key of ["processingP95Ms", "frameP95Ms", "longFrameRatio", "privateBytes", "memoryGrowthBytes"] as (keyof Metric)[]) {
  const value = (run: Run): number => key === "memoryGrowthBytes" ? Math.max(0, run.metrics[key]) : run.metrics[key];
  const values = calibration.map(value);
  const center = median(values);
  const deviation = median(values.map(v => Math.abs(v-center)));
  const base = median(baseline.map(value));
  const next = median(candidate.map(value));
  const allowance = center === 0
    ? Math.max(Math.abs(base) * .15, deviation * 3)
    : Math.abs(base) * Math.max(.15, 3 * deviation / Math.abs(center));
  if (next > base + allowance) failures.push(`${key}: ${next} exceeds baseline ${base} + ${allowance}`);
 }
 return failures;
}
