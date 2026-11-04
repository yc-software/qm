import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { testEnv } from "./helpers.ts";

test("`node src/index.ts` exits cleanly within seconds of SIGTERM", async () => {
  const PORT = "18298";
  const child = spawn(process.execPath, ["src/index.ts"], {
    cwd: process.cwd(),
    env: { ...process.env, ...testEnv({ CORE_SIGNING_SECRET: "a".repeat(48) }), NODE_ENV: "production", PORT },
    stdio: "ignore",
  });
  try {
    const deadline = Date.now() + 8000;
    let up = false;
    while (!up && Date.now() < deadline) {
      up = await fetch(`http://127.0.0.1:${PORT}/healthz`).then(
        (r) => r.ok,
        () => false,
      );
      if (!up) await new Promise((r) => setTimeout(r, 150));
    }
    assert.ok(up, "auth should serve /healthz");
    const exited = once(child, "exit");
    const signalled = Date.now();
    child.kill("SIGTERM");
    assert.deepEqual(await exited, [0, null]);
    assert.ok(Date.now() - signalled < 6_000, "auth should exit within seconds of SIGTERM");
  } finally {
    child.kill("SIGKILL");
  }
});
