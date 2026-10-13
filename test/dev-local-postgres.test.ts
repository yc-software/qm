import assert from "node:assert/strict";
import { mock, test } from "node:test";

const calls: string[][] = [];
mock.module("../scripts/dev/lib/proc.ts", {
  namedExports: {
    run: async (_cmd: string, args: string[]) => {
      calls.push(args);
      return { code: 0, stdout: args.includes("psql") ? "1" : "", stderr: "" };
    },
  },
});
const { ensureLocalPostgres } = await import("../scripts/dev/lib/postgres.ts");

test("local Postgres uses the assembled deployment environment", async () => {
  const pg = await ensureLocalPostgres(
    "/tmp/example-worktree",
    {
      DEV_INSTANCE_POSTGRES_PORT: "6543",
      DEV_INSTANCE_POSTGRES_CONTAINER: "custom-pg",
      DEV_INSTANCE_POSTGRES_VOLUME: "custom-volume",
    },
    () => {},
  );
  assert.match(pg.url, /@127\.0\.0\.1:6543\//);
  assert.ok(calls.some((args) => args.includes("127.0.0.1:6543:5432") && args.includes("custom-pg")));
  assert.ok(calls.some((args) => args.includes("custom-volume")));
});
