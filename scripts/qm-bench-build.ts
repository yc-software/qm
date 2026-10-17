import { buildCases, parseVariants, writeCases } from "../src/bench/dataset.ts";
import { allTasks } from "../src/bench/registry.ts";

const outDir = process.env.QM_BENCH_DATASET ?? "bench/cases";
const variants = parseVariants(process.env.QM_BENCH_CASES ?? "1,2");

const cases = buildCases(allTasks(), variants);
writeCases(outDir, cases);
const bytes = cases.reduce((sum, c) => sum + Object.values(c.files).reduce((s, body) => s + body.length, 0), 0);
console.log(`wrote ${cases.length} cases (${Math.round(bytes / 1024 / 1024)} MB of files) to ${outDir}`);
