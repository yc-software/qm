import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const cliDir = join(dirname(fileURLToPath(import.meta.url)), "..");
const bin = join(cliDir, "bin", "qm.ts");

function runCli(args: string[]): { code: number; stderr: string; stdout: string } {
  const env = {
    ...process.env,
    SLACK_BOT_TOKEN: "",
    QM_DEV_WAIT: "0",
    QM_POOL_STORE: mkdtempSync(join(tmpdir(), "qm-pool-")),
  };
  try {
    const stdout = execFileSync(process.execPath, [bin, ...args], {
      encoding: "utf8",
      cwd: cliDir,
      env,
      timeout: 20000,
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { code: 0, stdout, stderr: "" };
  } catch (e) {
    const err = e as { status?: number; stdout?: string; stderr?: string };
    return { code: err.status ?? 1, stdout: err.stdout ?? "", stderr: err.stderr ?? "" };
  }
}

for (const args of [
  ["dev", "--ci", "up"],
  ["dev", "--ci=up"],
  ["dev", "up", "--ci"],
]) {
  test(`'${args.join(" ")}' routes to CI mode (not the pool-leasing dev path)`, () => {
    const r = runCli(args);
    assert.notEqual(r.code, 0);
    assert.match(r.stderr, /SLACK_BOT_TOKEN/, `expected CI requireEnv; got: ${r.stderr}`);
    assert.doesNotMatch(r.stderr, /no free pool app/);
  });
}

test("'dev --ci down' routes to CI teardown (no pool lease)", () => {
  const r = runCli(["dev", "--ci", "down"]);
  assert.equal(r.code, 0);
  assert.match(r.stdout, /ci instance down|nothing to tear down/);
});

test("'dev --ci=down' routes to CI teardown (no pool lease)", () => {
  const r = runCli(["dev", "--ci=down"]);
  assert.equal(r.code, 0);
  assert.match(r.stdout, /ci instance down|nothing to tear down/);
});
