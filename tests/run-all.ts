import { readdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(fileURLToPath(new URL(".", import.meta.url)));
const files = readdirSync(root)
  .filter((name) => name.endsWith(".test.ts"))
  .sort((a, b) => a.localeCompare(b));

if (files.length === 0) {
  console.error("No test files found in tests/");
  process.exit(1);
}

let failed = 0;
for (const file of files) {
  const path = join(root, file);
  const result = spawnSync(
    process.execPath,
    ["--experimental-strip-types", path],
    { stdio: "pipe", cwd: join(root, ".."), encoding: "utf8" },
  );
  if (result.status === 0) {
    const tail = (result.stdout ?? "").trim().split("\n").pop() ?? "";
    if (tail.endsWith(" ok")) {
      console.log(tail);
    } else {
      console.log(`${file} ok`);
    }
  } else {
    if (result.stdout) {
      process.stdout.write(result.stdout);
    }
    if (result.stderr) {
      process.stderr.write(result.stderr);
    }
    console.error(`${file} FAILED`);
    failed += 1;
  }
}

console.log(`\n${files.length - failed}/${files.length} passed`);
process.exit(failed === 0 ? 0 : 1);
