import { test } from "node:test";
import assert from "node:assert/strict";
import { runCli } from "./harness.ts";

test("help / --help / -h / no-args all print the full command surface at exit 0", () => {
  for (const args of [["help"], ["--help"], ["-h"], [] as string[]]) {
    const r = runCli(args);
    assert.equal(r.code, 0, `${args.join(" ") || "(none)"} should exit 0`);
    for (const cmd of ["init", "up", "plan", "check", "status", "logs", "down", "sandbox build"]) {
      assert.match(r.out, new RegExp(`\\b${cmd.replace(" ", "\\s")}`), `help should list ${cmd}`);
    }
    for (const dev of ["dev up", "dev status", "dev logs", "dev down", "dev --ci"]) {
      assert.match(r.out, new RegExp(dev.replace(/-/g, "\\-").replace(" ", "\\s")), `help should list ${dev}`);
    }
    for (const opt of ["--config", "--env-file", "--sandbox-dir", "--build-from", "--dry-run", "--purge", "--tail"]) {
      assert.match(r.out, new RegExp(opt.replace(/-/g, "\\-")), `help should mention ${opt}`);
    }
  }
});

test("version / --version / -v print a semver at exit 0", () => {
  for (const args of [["version"], ["--version"], ["-v"]]) {
    const r = runCli(args);
    assert.equal(r.code, 0);
    assert.match(r.out, /\d+\.\d+\.\d+/);
  }
});

test("an unknown command exits 1 with an error on stderr and re-prints help", () => {
  const r = runCli(["frobnicate"]);
  assert.equal(r.code, 1);
  assert.match(r.stderr, /unknown command: frobnicate/);
  assert.match(r.out, /USAGE/);
  assert.match(r.out, /sandbox build/);
});
