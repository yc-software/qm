import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { once } from "node:events";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pidAlive } from "../scripts/dev/lib/proc.ts";
import { sleep } from "../scripts/dev/lib/util.ts";

const ROOT = join(import.meta.dirname, "..");
const SUPERVISOR = `
import { createServer } from "node:http";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
const args = process.argv.slice(2);
const slot = args[args.indexOf("--slot") + 1];
const store = args[args.indexOf("--store") + 1];
const lock = join(store, "leases", slot + ".lock");
writeFileSync("supervisor.pid", String(process.pid));
writeFileSync(join(lock, "supervisor.pid"), String(process.pid));
for (const signal of ["SIGTERM", "SIGINT"]) {
  process.on(signal, () => {
    console.error("received " + signal);
    setTimeout(() => process.exit(0), 50);
  });
}
if (process.env.TEST_EARLY_EXIT) process.exit(7);
createServer((req, res) => {
  if (req.url === "/boot-events") {
    if (process.env.TEST_BOOT_PENDING) return;
    res.end(JSON.stringify({ event: "done", result: { ok: true, slot, slackEnabled: false, webEnabled: false } }) + "\\n");
  } else res.end("{}");
}).listen(join(lock, "supervisor.sock"), () => console.error("supervisor ready"));
`;

for (const delegated of [false, true]) {
  for (const scenario of ["SIGTERM", "SIGINT", "boot-stop", "crash", "early-exit", "existing"] as const) {
    test(`${delegated ? "qm dev" : "dev"} --foreground: ${scenario}`, { timeout: 15_000 }, async (t) => {
      const root = mkdtempSync(join(tmpdir(), "qm-fg-"));
      const store = join(root, "pool");
      execFileSync("git", ["init", "-q"], { cwd: root });
      mkdirSync(join(root, "scripts/dev/supervisor"), { recursive: true });
      writeFileSync(join(root, "scripts/dev/supervisor/main.ts"), SUPERVISOR);
      symlinkSync(join(ROOT, "scripts/dev/cli.ts"), join(root, "scripts/dev/cli.ts"));
      const entry = delegated ? [join(ROOT, "cli/bin/qm.ts"), "dev"] : [join(ROOT, "scripts/dev/cli.ts")];
      const args = [...entry, "up", "--foreground", "--surface", "web"];
      const env = {
        ...process.env,
        QM_POOL_STORE: store,
        DEV_INSTANCE_WAIT: "0",
        TEST_BOOT_PENDING: scenario === "boot-stop" ? "1" : "",
        TEST_EARLY_EXIT: scenario === "early-exit" ? "1" : "",
      };
      const child = spawn(process.execPath, args, { cwd: root, env, stdio: ["ignore", "pipe", "pipe"] });
      const exited = once(child, "exit");
      let output = "";
      child.stdout.on("data", (chunk) => (output += chunk));
      child.stderr.on("data", (chunk) => (output += chunk));
      let supervisorPid = 0;
      t.after(() => {
        child.kill("SIGKILL");
        if (pidAlive(supervisorPid)) process.kill(supervisorPid, "SIGKILL");
        rmSync(root, { recursive: true, force: true });
      });
      if (scenario === "early-exit") {
        assert.notEqual((await exited)[0], 0, output);
        return;
      }
      const ready = scenario === "boot-stop" ? "supervisor ready" : "[ok] dev instance up";
      const deadline = Date.now() + 8000;
      while (!output.includes(ready) && child.exitCode === null && Date.now() < deadline) await sleep(25);
      assert.ok(output.includes(ready), output);
      supervisorPid = Number(readFileSync(join(root, "supervisor.pid"), "utf8"));
      assert.equal(child.exitCode, null);
      if (scenario === "existing") {
        const second = spawn(process.execPath, args, { cwd: root, env, stdio: "ignore" });
        assert.equal((await once(second, "exit"))[0], 9);
        assert.equal(pidAlive(supervisorPid), true);
      }
      if (scenario === "crash") process.kill(supervisorPid, "SIGKILL");
      else child.kill(scenario === "SIGINT" ? "SIGINT" : "SIGTERM");
      const [code, signal] = await exited;
      assert.equal(signal, null, output);
      assert.equal(code, scenario === "crash" ? 1 : 0, output);
      assert.equal(pidAlive(supervisorPid), false);
      if (scenario !== "crash") assert.match(output, /received SIG(?:TERM|INT)/);
    });
  }
}
