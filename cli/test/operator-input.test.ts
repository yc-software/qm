import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import { readEnvFile, which, writeEnvValue } from "../src/util.ts";
import { loadConfigAt, sandboxCoreEnv } from "../src/config.ts";
import { computedSecrets } from "../src/secrets.ts";

test("explicit missing env inputs fail before deployment commands; optional default remains absent", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "qm-operator-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const missing = join(dir, "missing.env");
  assert.equal(readEnvFile(missing).size, 0);
  assert.throws(() => readEnvFile(missing, true), /environment file not found/);
  const config = join(dir, "qm.config.jsonc");
  writeFileSync(
    config,
    JSON.stringify({
      contract: 1,
      orgId: "example",
      target: "docker",
      publicUrl: "http://localhost:8080",
      services: ["core"],
    }),
  );
  for (const args of [
    ["check", "--env-file"],
    ["plan", "--env-file"],
    ["secrets", "push", "--from"],
  ]) {
    const result = spawnSync(
      process.execPath,
      ["--", new URL("../bin/qm.ts", import.meta.url).pathname, ...args, missing, "--config", config],
      { encoding: "utf8" },
    );
    assert.notEqual(result.status, 0);
    assert.match(result.stdout + result.stderr, /environment file not found/);
  }
});

test("command help is usable without a deployment or backend credentials", () => {
  for (const args of [
    ["up", "--help"],
    ["check", "-h"],
    ["secrets", "push", "--help"],
  ]) {
    const result = spawnSync(process.execPath, ["--", new URL("../bin/qm.ts", import.meta.url).pathname, ...args], {
      encoding: "utf8",
    });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /USAGE/);
  }
});

test("dotenv replacement uses the same assignment grammar as reading", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "qm-env-edit-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, ".env");
  writeFileSync(file, "# secret\nexport KEY=old\nKEY=duplicate\nOTHER=1\n");
  writeEnvValue(file, "KEY", "new");
  assert.equal(readFileSync(file, "utf8"), "# secret\nKEY=new\nOTHER=1\n");
  assert.equal(readEnvFile(file).get("KEY"), "new");
});

test("binary lookup needs executable files on Unix and honors Windows PATHEXT", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "qm-path-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(join(dir, "windows-tool.exe"), "");
  writeFileSync(join(dir, "tool"), "");
  assert.equal(which("tool", { PATH: dir }, "linux"), false);
  chmodSync(join(dir, "tool"), 0o755);
  assert.equal(which("tool", { PATH: dir }, "linux"), true);
  assert.equal(which("windows-tool", { Path: dir, PATHEXT: ".EXE" }, "win32"), true);
  assert.equal(which("missing", { PATH: dir }, "linux"), false);
  assert.equal(which("tool; echo injected", { PATH: dir }, "linux"), false);
});

test("remote sandbox backends validate through the shared CLI registry and derive their required credentials", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "qm-backends-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, "qm.config.jsonc");
  for (const [backend, credential] of [
    ["e2b", "E2B_API_KEY"],
    ["modal", "MODAL_TOKEN_ID"],
    ["smolmachines", "SMOLMACHINES_TOKEN"],
  ]) {
    writeFileSync(
      path,
      JSON.stringify({
        contract: 1,
        orgId: "example",
        target: "docker",
        publicUrl: "http://localhost:8080",
        services: ["core"],
        sandbox: { backend },
      }),
    );
    const { config } = loadConfigAt(path);
    assert.equal(config.sandbox?.backend, backend);
    assert.equal(sandboxCoreEnv(config).env.SANDBOX_BACKEND, backend);
    assert.ok(computedSecrets(config).some((secret) => secret.name === credential && secret.required));
  }
});
