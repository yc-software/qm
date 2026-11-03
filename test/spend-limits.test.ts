import "./support/auto-fake-sprites.ts";

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createSpendLimits,
  parseSpendLimit,
  spendLimitNote,
  spendLimitRefusal,
  type SpendLimit,
} from "../src/ratelimit/spend-limits.ts";
import type { SpendRow } from "../src/sessions/session-store.ts";
import type { ScopeId, TurnRequest } from "../src/types.ts";
import type { AgentTurnInput } from "../src/agent/agent.ts";
import { buildApp } from "./support/build-app.ts";
import { createMockAgent } from "./support/mock-agent.ts";
import { testConfig } from "./support/test-config.ts";

const DAY = 86_400_000;
const NOW = Date.UTC(2026, 10, 15, 12);
const TODAY = Math.floor(NOW / DAY);

const row = (scopeId: string, day: number, costUsd: number): SpendRow => ({
  day,
  model: "m",
  scopeId: scopeId as ScopeId,
  origin: "conversation",
  cronId: null,
  calls: 1,
  costUsd,
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
});

function limits(configured: Record<string, SpendLimit>, rows: SpendRow[], now = () => NOW) {
  const reads: { from: number; to: number }[] = [];
  const tracker = createSpendLimits({
    orgId: () => "acme",
    getSpendLimit: async (scope) => configured[scope] ?? null,
    spendReport: async (range) => {
      reads.push(range);
      return { rows };
    },
    now,
  });
  return { tracker, reads };
}

test("the org value is each person's default; a scope's own value overrides it, and {} lifts it", async () => {
  const rows = [row("personal:a@x", TODAY, 6), row("personal:a@x", TODAY - 3, 20), row("channel:C1", TODAY, 100)];
  const { tracker, reads } = limits(
    { "org:acme": { dailyUsd: 5 }, "personal:b@x": { dailyUsd: 50 }, "personal:c@x": {} },
    rows,
  );
  const a = await tracker.status("personal:a@x");
  assert.deepEqual(
    { over: a?.over, today: a?.todayUsd, month: a?.monthUsd, orgDefault: a?.orgDefault },
    { over: "daily", today: 6, month: 26, orgDefault: true },
  );
  assert.equal((await tracker.status("personal:b@x"))?.over, null, "a person's own limit wins");
  assert.equal(await tracker.status("personal:c@x"), null, "{} means no limit for that person");
  assert.equal(await tracker.status("channel:C1"), null, "the per-person default doesn't cap shared scopes");
  assert.deepEqual(reads, [{ from: Date.UTC(2026, 10, 1), to: (TODAY + 1) * DAY }], "one month-to-date read, cached");
});

test("monthly caps count the whole UTC month, and shared scopes cap only when set on them", async () => {
  const rows = [row("group:proj", TODAY - 10, 70), row("group:proj", TODAY, 31)];
  const { tracker } = limits({ "group:proj": { dailyUsd: 40, monthlyUsd: 100 } }, rows);
  const s = await tracker.status("group:proj");
  assert.equal(s?.over, "monthly");
  assert.match(spendLimitRefusal(s!), /\$101\.00 of \$100\.00 this month.*on the 1st/);
  assert.match(spendLimitNote(s!), /this scope's own limit\): \$31\.00 of \$40\.00 today, \$101\.00 of \$100\.00/);
});

test("totals are re-read after the cache window and when the day turns", async () => {
  let t = NOW;
  const { tracker, reads } = limits({ "org:acme": { monthlyUsd: 10 } }, [], () => t);
  await tracker.status("personal:a@x");
  t += 30_000;
  await tracker.status("personal:a@x");
  assert.equal(reads.length, 1);
  t += 60_000;
  await tracker.status("personal:a@x");
  assert.equal(reads.length, 2);
  t = (TODAY + 1) * DAY + 1;
  await tracker.status("personal:a@x");
  assert.equal(reads.length, 3);
});

test("spend-limit values parse dollars, treat blanks as unset, and reject nonsense", () => {
  assert.deepEqual(parseSpendLimit({ dailyUsd: 25, monthlyUsd: "300" }), { value: { dailyUsd: 25, monthlyUsd: 300 } });
  assert.deepEqual(parseSpendLimit({ dailyUsd: "" }), { value: {} });
  assert.deepEqual(parseSpendLimit({ inherit: true }), { value: null });
  assert.ok("error" in parseSpendLimit({ dailyUsd: -1 }));
  assert.ok("error" in parseSpendLimit({ monthlyUsd: "lots" }));
});

test("a person over their spend limit is refused; under it, the turn sees where they stand", async () => {
  const environments: string[] = [];
  const mock = createMockAgent();
  const built = buildApp(testConfig({ dataDir: mkdtempSync(join(tmpdir(), "spend-limit-")) }), {
    agent: {
      ...mock,
      runTurn: (input: AgentTurnInput) => {
        environments.push(input.environment ?? "");
        return mock.runTurn(input);
      },
    },
  });
  const dm = (text: string, n: number): TurnRequest => ({
    surface: "test",
    actor: { externalId: "U1" },
    conversation: { kind: "dm", threadRef: `dm:U1:t${n}` },
    text,
  });

  await built.config.setSpendLimit("org:default-org", { dailyUsd: 25 });
  const ok = await built.app.turn(dm("hello", 1));
  assert.equal(ok.status, "ok");
  assert.match(environments.at(-1) ?? "", /the org's per-person default\): \$0\.00 of \$25\.00 today/);

  await built.config.setSpendLimit("org:default-org", { dailyUsd: 0 });
  const refused = await built.app.turn(dm("again", 2));
  assert.equal(refused.status, "refused");
  assert.equal(refused.refusalKind, "model_budget");
  assert.match(refused.reason ?? "", /reached its QM spend limit .*midnight UTC\. An admin can raise the limit\./);
  assert.equal(environments.length, 1, "the refused turn never reached the model");
});
