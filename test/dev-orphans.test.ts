import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { sweepSlackTokenOrphans } from "../scripts/dev/lib/orphans.ts";

test(
  "the orphan sweep finds a Linux Slack process whose token was loaded from its working directory",
  { skip: process.platform !== "linux", timeout: 15_000 },
  async () => {
    const root = await mkdtemp(join(tmpdir(), "qm-orphan-"));
    const cwd = join(root, "plugins", "slack");
    const token = `test-${randomUUID()}`;
    await mkdir(join(cwd, "src"), { recursive: true });
    await writeFile(join(cwd, ".env"), `SLACK_APP_TOKEN=${token}\n`);
    await writeFile(join(cwd, "src", "index.ts"), 'process.stdout.write("ready"); setInterval(() => {}, 1000);');
    const child = spawn(process.execPath, ["src/index.ts"], { cwd, env: {}, stdio: ["ignore", "pipe", "pipe"] });
    const closed = once(child, "close");
    try {
      await once(child.stdout, "data");
      assert.ok(child.pid);
      assert.deepEqual((await sweepSlackTokenOrphans(token, new Set([child.pid]), () => {})).swept, []);
      const result = await sweepSlackTokenOrphans(token, new Set(), () => {});
      assert.deepEqual(
        result.swept.map(({ pid }) => pid),
        [child.pid],
      );
      await closed;
    } finally {
      child.kill("SIGKILL");
      await closed;
      await rm(root, { recursive: true, force: true });
    }
  },
);
