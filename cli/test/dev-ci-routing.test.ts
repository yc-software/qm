import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const cliDir = join(dirname(fileURLToPath(import.meta.url)), "..");
const bin = join(cliDir, "bin", "qm.ts");

function runCli(args: string[]): { code: number; stderr: string; stdout: string } {
  const root = mkdtempSync(join(tmpdir(), "qm-ci-routing-"));
  execFileSync("git", ["init", "--quiet", root]);
  const env = {
    ...process.env,
    SLACK_BOT_TOKEN: "",
    QM_DEV_WAIT: "0",
    QM_POOL_STORE: join(root, "pool"),
  };
  try {
    const stdout = execFileSync(process.execPath, [bin, ...args], {
      encoding: "utf8",
      cwd: root,
      env,
      timeout: 20000,
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { code: 0, stdout, stderr: "" };
  } catch (e) {
    const err = e as { status?: number; stdout?: string; stderr?: string };
    return { code: err.status ?? 1, stdout: err.stdout ?? "", stderr: err.stderr ?? "" };
  } finally {
    rmSync(root, { recursive: true, force: true });
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

test("CI startup builds the connector SDK and stops before spawning services if the build fails", (t) => {
  const root = mkdtempSync(join(tmpdir(), "qm-ci-build-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  execFileSync("git", ["init", "--quiet", root]);
  mkdirSync(join(root, "node_modules"));
  mkdirSync(join(root, "bin"));
  writeFileSync(
    join(root, "bin", "npm"),
    '#!/bin/sh\n[ "$1" = run ] && [ "$2" = build:connector-sdk ] || exit 1\necho "SDK build failed" >&2\nexit 7\n',
    { mode: 0o755 },
  );
  assert.throws(
    () =>
      execFileSync(process.execPath, [bin, "dev", "--ci", "up"], {
        cwd: root,
        encoding: "utf8",
        stdio: "pipe",
        timeout: 10_000,
        env: {
          PATH: `${join(root, "bin")}:${process.env.PATH}`,
          SLACK_BOT_TOKEN: "xoxb-test",
          SLACK_APP_TOKEN: "xapp-test",
          ANTHROPIC_API_KEY: "test",
          CORE_SIGNING_SECRET: "test",
          CI_INSTANCE_READY_TIMEOUT: "1",
        },
      }),
    (error: unknown) => /SDK build failed/.test(String((error as { stderr?: string }).stderr)),
  );
  assert.equal(existsSync(join(root, ".ci-instance")), false);
});
