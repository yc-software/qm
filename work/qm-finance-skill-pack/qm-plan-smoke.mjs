import { planIngest } from "../../src/skills/ingest.ts";
import fs from "node:fs";
import path from "node:path";

const root = path.dirname(new URL(import.meta.url).pathname);
const config = JSON.parse(fs.readFileSync(path.join(root, "pack.config.json"), "utf8"));
const files = [];

function walk(directory) {
  for (const name of fs.readdirSync(directory)) {
    const absolute = path.join(directory, name);
    const stat = fs.statSync(absolute);
    if (stat.isDirectory()) walk(absolute);
    else {
      const bytes = fs.readFileSync(absolute);
      files.push({
        path: path.relative(root, absolute).split(path.sep).join("/"),
        text: bytes.toString("utf8"),
        binary: bytes.includes(0),
      });
    }
  }
}

walk(path.join(root, "skills"));
const plan = planIngest({ commit: "staging-review", files }, { config, nativeNames: new Set() });
console.log(JSON.stringify(plan.counts));
for (const candidate of plan.candidates) {
  console.log(`${candidate.upstreamName}\t${candidate.eligible ? "eligible" : candidate.excludeReason}`);
}
if (plan.counts.total !== 4 || plan.counts.eligible !== 4 || plan.candidates.some((candidate) => !candidate.eligible)) {
  process.exitCode = 1;
}
