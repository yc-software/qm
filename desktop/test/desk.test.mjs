import assert from "node:assert/strict";
import { mkdtemp, writeFile, readFile, chmod, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { mock, test } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";

test("cancellation kills native work and discards queued actions for that run", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "qm-desk-"));
  const binary = path.join(directory, "helper.mjs");
  const started = path.join(directory, "started");
  const acted = path.join(directory, "acted");
  await writeFile(
    binary,
    `#!/usr/bin/env node
import { createInterface } from "node:readline";
import { writeFileSync } from "node:fs";
createInterface({input:process.stdin}).on("line", line => {
 const {id,cmd} = JSON.parse(line);
 if (cmd.type === "act") {
  writeFileSync(${JSON.stringify(started)}, "started");
  setTimeout(() => { writeFileSync(${JSON.stringify(acted)}, "acted"); process.stdout.write(JSON.stringify({id,reply:{type:"acted"}})+"\\n"); }, 800);
 } else process.stdout.write(JSON.stringify({id,reply:{type:"apps",apps:[]}})+"\\n");
});
`,
  );
  await chmod(binary, 0o700);
  process.env.QM_DESK_BIN = binary;
  process.env.QM_DESK_CURSOR = "0";
  mock.module("electron", { namedExports: { app: { isPackaged: false } } });
  mock.module("../cursor.mjs", { namedExports: { flyTo: async () => {} } });
  const { desk } = await import("../desk.mjs");
  try {
    const active = desk.act("Calculator", [{ type: "wait", ms: 800 }], false, "run-a");
    const queued = desk.act("Calculator", [{ type: "raise" }], false, "run-a");
    for (let n = 0; n < 100; n++) {
      if (await readFile(started, "utf8").catch(() => "")) break;
      await sleep(10);
    }
    assert.equal(await readFile(started, "utf8"), "started");
    desk.cancel("run-a");
    assert.equal((await active).type, "error");
    assert.equal((await queued).type, "error");
    await sleep(900);
    await assert.rejects(readFile(acted), { code: "ENOENT" });
    assert.deepEqual(await desk.apps("run-b"), { type: "apps", apps: [] });
    assert.equal((await desk.observe("Calculator", false, "run-c")).type, "error");
    desk.cancel("run-b");
    assert.equal((await desk.apps("run-c")).type, "apps");
    desk.cancel("run-c");
    const blocking = desk.act("Calculator", [], false, "run-d");
    const expired = desk.act("Calculator", [], false, "run-d", Date.now() + 20);
    assert.equal((await blocking).type, "acted");
    assert.equal((await expired).type, "error");
  } finally {
    desk.stop();
    await rm(directory, { recursive: true, force: true });
    delete process.env.QM_DESK_BIN;
    delete process.env.QM_DESK_CURSOR;
  }
});
