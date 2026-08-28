#!/usr/bin/env node
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Boxd } from "@boxd-sh/sdk";
import { createBoxdSandbox } from "../src/sandbox/boxd-sandbox.ts";
import { spriteScopeName } from "../src/sandbox/sprites-sandbox.ts";
import { createLocalWorkspaceStore } from "../src/workspace/workspace-store.ts";
import { supportsProcessSessions } from "../src/sandbox/sandbox.ts";
import { pollProcess } from "../src/sandbox/process-poll.ts";
import { loadConfig } from "../src/config.ts";
import { scopeId } from "../src/types.ts";

const log = (...a: unknown[]) => console.log("[boxd-smoke]", ...a);

if (!process.env.BOXD_API_KEY && !process.env.BOXD_TOKEN) {
  console.error("set BOXD_API_KEY (mint one with `boxd auth keys create`)");
  process.exit(1);
}

async function main(): Promise<void> {
  const client = new Boxd();
  const boxdEnv = loadConfig().boxdSandbox;
  const prefix = boxdEnv.namePrefix ?? "qmsmoke";
  const ws = createLocalWorkspaceStore(mkdtempSync(join(tmpdir(), "boxd-smoke-ws-")));
  const sandbox = createBoxdSandbox(ws, { ...boxdEnv, namePrefix: prefix, client });
  const scope = scopeId("personal", `smoke-${Date.now()}`);
  const layers = [{ scopeId: scope, mountPath: "", mode: "rw" as const }];
  const scratchKey = `smoke-${Date.now()}`;
  const names = [spriteScopeName(prefix, scope), spriteScopeName(`${prefix}-scratch`, scratchKey)];
  const listed = async (name: string) =>
    (await client.machines.list(boxdEnv.org ? { org: boxdEnv.org } : {})).find((m) => m.name === name) ?? null;

  try {
    log("provision #1 (fresh machine)...");
    const h1 = await sandbox.provision(layers);
    log("machine", h1.id, "coldStart", h1.coldStart);
    assert.equal(h1.coldStart, true, "first ever provision should be cold");
    assert.equal((await listed(h1.id))?.status, "running");

    log("exec over gRPC...");
    const echo = await sandbox.run(h1, "echo hello-from-boxd");
    assert.equal(echo.code, 0);
    assert.equal(echo.stdout.trim(), "hello-from-boxd");
    const codes = await sandbox.run(h1, "echo out; echo err >&2; exit 3");
    assert.deepEqual([codes.code, codes.stdout.trim(), codes.stderr.trim()], [3, "out", "err"]);
    const timed = await sandbox.run(h1, "sleep 5", { timeoutMs: 1000 });
    assert.equal(timed.timedOut, true, "guest-side timeout reports timedOut");
    const uname = await sandbox.run(h1, "uname -m; node --version; whoami; pwd");
    log("guest:", uname.stdout.trim().replace(/\n/g, " | "));
    assert.match(uname.stdout, /\/home\/boxd\/workspace/);

    const marker = `persist-${Date.now()}`;
    await sandbox.writeFile(h1, "notes/marker.txt", marker);
    assert.equal(await sandbox.readFile(h1, "notes/marker.txt"), marker);
    assert.equal(await sandbox.readFile(h1, "notes/missing.txt"), null);
    const big = Buffer.alloc(5 * 1024 * 1024 + 3);
    for (let i = 0; i < big.length; i++) big[i] = (i * 7) % 256;
    await sandbox.writeFileBytes(h1, "big.bin", big);
    const back = await sandbox.readFileBytes(h1, "big.bin");
    assert.ok(back && Buffer.from(back).equals(big), "5 MiB roundtrip (chunked past the gRPC cap)");
    log("wrote marker", marker, "and a 5 MiB blob");

    assert.ok(supportsProcessSessions(sandbox));
    if (supportsProcessSessions(sandbox)) {
      const { processId } = await sandbox.startProcess(h1, "for i in 1 2 3; do echo tick $i; sleep 1; done");
      const polled = await pollProcess(sandbox, h1, processId, { deadlineMs: 30_000 });
      assert.equal(polled.status.state, "exited");
      assert.match(polled.output, /tick 3/);
      log("process session ran to completion");
    }

    const backup = await sandbox.backupComputer!(h1, { include: ["workspace"] });
    assert.ok(
      backup.some((e) => e.path === "notes/marker.txt"),
      "backup carries the marker",
    );
    log("backup packed", backup.length, "workspace files");

    assert.deepEqual(await sandbox.computerStatus!(scope), { machine: "running", guestResponsive: true });

    log("teardown #1 (park)...");
    await sandbox.teardown(h1);

    log("provision #2 (should reuse the same machine, warm)...");
    const h2 = await sandbox.provision(layers);
    assert.equal(h2.id, h1.id, "warm provision reuses the same machine");
    assert.equal(h2.coldStart, false, "reused machine is not cold");
    assert.equal(await sandbox.readFile(h2, "notes/marker.txt"), marker, "file present after reuse");
    log("warm reuse OK, marker intact");

    log("restartComputer (reboot)...");
    await sandbox.restartComputer!(scope);
    assert.equal((await sandbox.run(h2, "echo back")).stdout.trim(), "back");
    assert.equal(await sandbox.readFile(h2, "notes/marker.txt"), marker, "disk survives a reboot");
    log("reboot OK");

    log("scratch box...");
    const hs = await sandbox.provision(layers, { scratch: { key: scratchKey } });
    assert.equal(hs.scratch, true);
    assert.notEqual(hs.id, h2.id);
    assert.equal((await sandbox.run(hs, "echo scratch-ok")).stdout.trim(), "scratch-ok");
    await sandbox.teardown(hs);
    assert.equal(await listed(hs.id), null, "scratch machine deleted at release");
    log("scratch OK");

    log("teardown #2 (destroy)...");
    await sandbox.teardown(h2, { destroy: true });
    assert.equal(await listed(h2.id), null, "destroyed machine is gone");

    log("\n=== ALL LIVE ASSERTIONS PASSED ===");
  } finally {
    for (const name of names) {
      const m = await listed(name).catch(() => null);
      if (m) await client.machines.delete(m.id).catch(() => {});
    }
    await client.close();
    log("cleanup done");
  }
}

main().catch((e) => {
  console.error("[boxd-smoke] FAILED:", e instanceof Error ? (e.stack ?? e.message) : e);
  process.exit(1);
});
