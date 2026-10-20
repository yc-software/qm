import "./support/auto-fake-sprites.ts";

import { test, mock } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { createInsecureTestServer } from "../src/api/server.ts";
import { configurePgPooling, createPgPool } from "../src/persistence/pg-pool.ts";
import { buildApp } from "../src/wiring.ts";
import { requestTiming, withRequestTiming, type RequestTiming } from "../plugins/chassis/src/server-timing.ts";
import { testConfig } from "./support/test-config.ts";

const direct = process.env.DATABASE_URL;

function metrics(header: string | null): Map<string, number> {
  return new Map(
    (header ?? "").split(", ").map((part) => {
      const [name, dur] = part.split(";dur=");
      return [name!, Number(dur)];
    }),
  );
}

test("core transcript responses carry Server-Timing phases and log one request-timing line", async () => {
  const built = buildApp(testConfig({ dataDir: mkdtempSync(join(tmpdir(), "server-timing-")) }));
  const server = createInsecureTestServer(built.app);
  server.listen(0);
  const info = mock.method(console, "info", () => {});
  try {
    const response = await fetch(
      `http://localhost:${(server.address() as AddressInfo).port}/v1/sessions/nope?viewer=someone`,
    );
    assert.equal(response.status, 404);
    await response.text();
    const timing = metrics(response.headers.get("server-timing"));
    for (const name of ["core-pre", "core-auth", "core-lookup", "core-json", "core-loop", "core-total"])
      assert.ok(Number.isFinite(timing.get(name)), `${name} in ${response.headers.get("server-timing")}`);
    assert.ok(timing.get("core-total")! >= timing.get("core-lookup")!);
    await new Promise((resolve) => setImmediate(resolve));
    const lines = info.mock.calls
      .map((call) => String(call.arguments[0]))
      .filter((line) => line.startsWith("[request-timing] "));
    assert.equal(lines.length, 1);
    const logged = JSON.parse(lines[0]!.slice("[request-timing] ".length)) as Record<string, unknown>;
    assert.equal(logged.hop, "core");
    assert.equal(logged.route, "transcript");
    assert.equal(logged.status, 404);
    assert.equal(typeof logged.total, "number");
    assert.equal(typeof logged.lookup, "number");
  } finally {
    info.mock.restore();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test(
  "Postgres pool wait and queries are charged to the request that issued them",
  { skip: direct ? false : "set DATABASE_URL to run" },
  async () => {
    configurePgPooling({ databaseUrl: direct!, queryMax: 1 });
    const pg = createPgPool(direct!);
    try {
      await pg.q("SELECT 1");
      const run = (sleep: number) =>
        withRequestTiming("t", async () => {
          await pg.q("SELECT pg_sleep($1)", [sleep]);
          return requestTiming()!;
        });
      const [slow, waiting] = (await Promise.all([run(0.1), run(0)])) as [RequestTiming, RequestTiming];
      assert.equal(slow.db.queries, 1);
      assert.equal(waiting.db.queries, 1);
      assert.ok(slow.db.queryMs >= 90, `slow query ${slow.db.queryMs}`);
      assert.ok(waiting.db.waitMs >= 80, `pool wait ${waiting.db.waitMs}`);
      assert.ok(waiting.db.queryMs < slow.db.queryMs);
    } finally {
      await pg.close();
      configurePgPooling({});
    }
  },
);

test(
  "a background query that waits behind a request's connection is not charged to that request",
  { skip: direct ? false : "set DATABASE_URL to run" },
  async () => {
    configurePgPooling({ databaseUrl: direct!, queryMax: 1 });
    const pg = createPgPool(direct!);
    try {
      let started!: () => void;
      const holding = new Promise<void>((resolve) => (started = resolve));
      const pending = withRequestTiming("t", async () => {
        const own = pg.q("SELECT pg_sleep(0.05)");
        started();
        await own;
        return requestTiming()!;
      });
      await holding;
      const background = pg.q("SELECT 1");
      const request = await pending;
      await background;
      assert.equal(request.db.queries, 1);
    } finally {
      await pg.close();
      configurePgPooling({});
    }
  },
);
