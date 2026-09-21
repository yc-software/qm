import assert from "node:assert/strict";
import { test } from "node:test";
import { createAppHelpers } from "../src/api/app-helpers.ts";
import type { App, AppDeps } from "../src/api/app-types.ts";
import type { Orchestrator } from "../src/core/orchestrator.ts";
import { createMemoryRunStore } from "../src/runs/memory-run-store.ts";
import { createWorkCapacity } from "../src/runs/work-capacity.ts";
import { createMemorySessionStore } from "../src/sessions/memory-session-store.ts";
import type { TurnResult } from "../src/types.ts";

test("foreground execution does not perform an unbounded run lookup while holding shared capacity", async (t) => {
  const host = createWorkCapacity(1);
  let permitHeld = false;
  const capacity = {
    async acquire(signal?: AbortSignal) {
      const release = await host.acquire(signal);
      if (!release) return null;
      permitHeld = true;
      return () => {
        permitHeld = false;
        release();
      };
    },
  };
  const { runs } = createMemoryRunStore();
  const queued = (
    await runs.enqueue({
      sessionId: "foreground",
      request: {
        actor: { id: "internal:person", type: "internal" },
        conversation: { kind: "dm", threadRef: "foreground", audience: [] },
        origin: { kind: "direct" },
        text: "test",
      },
    })
  ).run;
  const get = runs.get.bind(runs);
  t.mock.method(runs, "get", (...args: Parameters<typeof get>) => {
    assert.equal(permitHeld, false, "an unbounded lookup can strand every other tenant behind a locked database");
    return get(...args);
  });
  const result: TurnResult = { status: "ok", reply: "done" };
  const helpers = createAppHelpers(
    {
      runs,
      sessions: createMemorySessionStore(),
      capacity,
      leaseTtlMs: 10_000,
      runWaitMs: 1_000,
      orchestrator: { handleTurn: async () => result } as unknown as Orchestrator,
    } as AppDeps,
    {} as App,
  );
  assert.deepEqual(await helpers.drive(queued.id), result);
  assert.equal(permitHeld, false);
  const release = await host.acquire();
  release!();
});
