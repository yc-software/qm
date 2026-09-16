import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { test } from "node:test";

for (const outcome of ["clean", "blocked", "uncovered", "fallback", "coarse-gap", "failed"] as const) {
  test(`retirement gate ${outcome === "clean" ? "accepts" : "rejects"} ${outcome}`, () => {
    const program = `
      import { mock } from 'node:test';
      const outcome = ${JSON.stringify(outcome)};
      mock.module(${JSON.stringify(new URL("../scripts/lib/backfill-runner.ts", import.meta.url).href)}, {
        namedExports: {
          argValue: () => undefined,
          openSessionStore: () => ({
            getEntries: async (id) => { if (id === 'target' && outcome === 'failed') throw new Error('read failed'); return []; },
            getTape: async () => [],
          }),
          resolveSessions: async () => [{id: 'clean'}, {id: 'target'}],
        },
      });
      mock.module(${JSON.stringify(new URL("../scripts/lib/tape-retirement.ts", import.meta.url).href)}, {
        namedExports: {
          DIVERGENCE_CLASSES: ['coarse-gap'],
          emptyBenignCounts: () => ({'coarse-gap': 0}),
          sessionParity: (id) => id === 'target' && ['blocked', 'uncovered'].includes(outcome)
            ? {status: 'unservable', reason: outcome}
            : {status: 'compared', report: {real: [], benign: {'coarse-gap': Number(id === 'target' && outcome === 'coarse-gap')}}},
          limitedSessionParity: async (_store, id) => id === 'target' && outcome === 'fallback'
            ? {status: 'fallback'}
            : {status: 'projected', report: {real: []}},
        },
      });
      await import(${JSON.stringify(new URL("../scripts/tape-parity-check.ts", import.meta.url).href)});
    `;
    const result = spawnSync(
      process.execPath,
      ["--experimental-test-module-mocks", "--input-type=module", "-e", program],
      {
        encoding: "utf8",
        timeout: 10_000,
      },
    );
    assert.equal(result.status, outcome === "clean" ? 0 : 1, result.stdout + result.stderr);
    assert.match(result.stdout, /sessions 2: compared/);
  });
}
