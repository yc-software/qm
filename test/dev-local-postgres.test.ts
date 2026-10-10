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

test("ensureLocalPostgres honors the assembled dev env over process.env", async () => {
  delete process.env.DEV_INSTANCE_POSTGRES_PORT;
  delete process.env.DEV_INSTANCE_POSTGRES_CONTAINER;
  const pg = await ensureLocalPostgres(
    "/tmp/wt",
    { DEV_INSTANCE_POSTGRES_PORT: "6543", DEV_INSTANCE_POSTGRES_CONTAINER: "custom-pg" },
    () => {},
  );
  assert.match(pg.url, /@127\.0\.0\.1:6543\//);
  const runArgs = calls.find((args) => args[0] === "run");
  assert.ok(runArgs?.includes("127.0.0.1:6543:5432"));
  assert.ok(runArgs?.includes("custom-pg"));
});
