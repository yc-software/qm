import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import type { Pool } from "pg";
import { createMemoryRunStore } from "../src/runs/memory-run-store.ts";
import { createPostgresRunStore } from "../src/runs/postgres-run-store.ts";
import type { OrchestratorInput } from "../src/core/orchestrator.ts";

for (const backend of ["memory", "postgres"] as const) {
  test(
    `${backend}: latest failure membership matches full latest reads without changing their private-message option`,
    {
      skip: backend === "postgres" && !process.env.DATABASE_URL,
    },
    async (t) => {
      const runtime = backend === "memory" ? createMemoryRunStore() : createPostgresRunStore(process.env.DATABASE_URL!);
      const { runs } = runtime;
      let raw: Pool | undefined;
      const prefix = randomUUID();
      const ref = (name: string) => `${prefix}:${name}`;
      let now = Date.now();
      t.mock.method(Date, "now", () => now);
      const put = async (
        name: string,
        state: "ok" | "result-failed" | "failed" | "pending",
        at: number,
        privateSessionMessage = false,
      ) => {
        now = at;
        const thread = ref(name);
        const request: OrchestratorInput = {
          actor: { id: "internal:test", type: "internal" },
          conversation: { kind: "dm", threadRef: thread, audience: [] },
          origin: { kind: "direct" },
          text: "not returned by projection",
          ...(privateSessionMessage ? { privateSessionMessage: true } : {}),
        };
        const { run } = await runs.enqueue({ sessionId: thread, request });
        if (state !== "pending") {
          const leased = await runs.claimById(run.id, "worker", 60_000);
          assert.ok(leased?.leaseToken);
          if (state === "failed") await runs.fail(run.id, leased.leaseToken, "failed", { retry: false });
          else
            await runs.complete(
              run.id,
              leased.leaseToken,
              state === "ok" ? { status: "ok", reply: "ok" } : { status: "failed", reason: "failure in result" },
            );
        }
        return run.id;
      };
      const at = now;
      try {
        await put("recovered", "failed", at);
        await put("recovered", "ok", at + 1);
        await put("clock-reversed", "failed", at + 20);
        await put("clock-reversed", "ok", at + 10);
        await put("tie-success", "failed", at + 30);
        const tieSuccess = await put("tie-success", "ok", at + 30);
        await put("tie-failure", "ok", at + 40);
        const tieFailure = await put("tie-failure", "result-failed", at + 40);
        await put("result", "result-failed", at);
        const statusOnly = await put("status", "failed", at);
        if (backend === "postgres") {
          const pg = (await import("pg")).default;
          raw = new pg.Pool({ connectionString: process.env.DATABASE_URL });
          await raw.query("UPDATE runs SET result=NULL WHERE id=$1", [statusOnly]);
        } else (await runs.get(statusOnly))!.result = null;
        const publicFailure = await put("private-success", "failed", at);
        const privateSuccess = await put("private-success", "ok", at + 1, true);
        await put("private-failure", "ok", at);
        await put("private-failure", "failed", at + 1, true);
        await put("pending", "failed", at);
        await put("pending", "pending", at + 1);
        await put("literal_'%_", "failed", at);
        await put("not-requested", "failed", at);
        const refs = [
          "recovered",
          "clock-reversed",
          "tie-success",
          "tie-failure",
          "result",
          "status",
          "private-success",
          "private-failure",
          "pending",
          "literal_'%_",
          "missing",
        ].map(ref);
        const expected = new Set<string>();
        for (const thread of refs) {
          const run = await runs.latestForThread(thread);
          if (run?.status === "failed" || run?.result?.status === "failed") expected.add(thread);
        }
        assert.deepEqual(
          expected,
          new Set(["clock-reversed", "tie-failure", "result", "status", "private-failure", "literal_'%_"].map(ref)),
        );
        assert.deepEqual(await runs.latestFailedThreads([...refs, refs[0]!], new AbortController().signal), expected);
        assert.deepEqual(await runs.latestFailedThreads([]), new Set());
        assert.equal((await runs.latestForThread(ref("tie-success")))?.id, tieSuccess);
        assert.equal((await runs.latestForThread(ref("tie-failure")))?.id, tieFailure);
        assert.equal((await runs.latestForThread(ref("private-success")))?.id, privateSuccess);
        assert.equal(
          (await runs.latestForThread(ref("private-success"), { excludePrivateMessages: true }))?.id,
          publicFailure,
        );
        const cancelled = new AbortController();
        cancelled.abort();
        await assert.rejects(runs.latestFailedThreads(refs, cancelled.signal), { name: "AbortError" });
        await assert.rejects(runs.latestFailedThreads([], cancelled.signal), { name: "AbortError" });
      } finally {
        await raw?.end();
        await runs.close?.();
      }
    },
  );
}
