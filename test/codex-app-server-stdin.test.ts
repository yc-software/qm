import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CodexAppServer } from "../src/harness/codex-app-server.ts";

test("an app-server that closes its stdin fails requests instead of crashing the process", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "qm-codex-stdin-"));
  const binary = join(dir, "codex");
  writeFileSync(binary, "#!/bin/sh\nexec 0<&-\nsleep 5\n");
  chmodSync(binary, 0o755);
  const uncaught: unknown[] = [];
  const onUncaught = (error: unknown) => uncaught.push(error);
  process.on("uncaughtException", onUncaught);
  const server = new CodexAppServer({
    binaryPath: binary,
    cwd: dir,
    onNotification: () => {},
    onRequest: async () => ({}),
  });
  t.after(async () => {
    process.off("uncaughtException", onUncaught);
    await server.close();
    rmSync(dir, { recursive: true, force: true });
  });
  await new Promise((resolve) => setTimeout(resolve, 300));
  const big = "x".repeat(1_000_000);
  for (let i = 0; i < 3; i++) await assert.rejects(server.request("ping", { big }));
  await new Promise((resolve) => setTimeout(resolve, 200));
  assert.deepEqual(uncaught, []);
});
