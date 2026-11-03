import { randomUUID } from "node:crypto";
import pg from "pg";
import { configurePgPooling, createPgPool } from "./src/persistence/pg-pool.ts";
import { withTenant } from "./src/tenants/context.ts";

configurePgPooling({ queryMax: 1 });
const url = process.env.BENCH_URL!;
const n = Number(process.env.BENCH_N ?? 2000);
const owner = new pg.Client({ connectionString: url });
await owner.connect();
const tenant = randomUUID();
const store = createPgPool(url);
const pct = (xs: number[], p: number) => xs.sort((x, y) => x - y)[Math.min(xs.length - 1, Math.floor((p / 100) * xs.length))]!;
async function measure(run: () => Promise<unknown>) {
  for (let i = 0; i < 200; i++) await run();
  const xs: number[] = [];
  for (let i = 0; i < n; i++) {
    const t = performance.now();
    await run();
    xs.push(performance.now() - t);
  }
  return [50, 95, 99].map((p) => pct(xs, p).toFixed(3)).join(" / ");
}
const text = "SELECT $1::int AS n";
console.log("plain", await measure(() => store.q(text, [1])));
console.log("bound", await measure(() => withTenant(tenant, () => store.q(text, [1]))));
console.log("bound+timeout", await measure(() => withTenant(tenant, () => store.q(text, [1], { timeoutMs: 5000 }))));
await store.close();
await owner.end();
