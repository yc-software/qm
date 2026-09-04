import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { runCli, tmp, rmDir, writeConfig } from "./harness.ts";

function scaffold(label: string): string {
  const dir = tmp(label);
  const r = runCli(["init", dir, "--org", "acme"]);
  assert.equal(r.code, 0, `init failed: ${r.out}`);
  return dir;
}

test("check passes on a scaffolded deployment and reports what it found", () => {
  const dir = scaffold("check-ok");
  try {
    const r = runCli(["check"], { cwd: dir });
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, /check passed/);
    assert.match(r.out, /example-tool/);
    assert.match(r.out, /greet/);
  } finally {
    rmDir(dir);
  }
});

test("check fails on a malformed tool descriptor (invalid JSON)", () => {
  const dir = scaffold("check-badjson");
  try {
    writeFileSync(join(dir, "sandbox", "tools", "example-tool", "tool.json"), "{ not json");
    const r = runCli(["check"], { cwd: dir });
    assert.equal(r.code, 1);
    assert.match(r.out, /check failed/);
  } finally {
    rmDir(dir);
  }
});

test("check fails on a tool descriptor missing its id", () => {
  const dir = scaffold("check-noid");
  try {
    writeFileSync(join(dir, "sandbox", "tools", "example-tool", "tool.json"), JSON.stringify({ advertise: "x" }));
    const r = runCli(["check"], { cwd: dir });
    assert.equal(r.code, 1);
    assert.match(r.out, /check failed/);
  } finally {
    rmDir(dir);
  }
});

test("check fails on a config plugin that resolves to neither a source folder nor an image", () => {
  const dir = tmp("check-badplugin");
  try {
    writeConfig(dir, { orgId: "acme", target: "docker", plugins: [{ name: "widget" }] });
    const r = runCli(["check"], { cwd: dir });
    assert.equal(r.code, 1);
    assert.match(r.out, /check failed/);
    assert.match(r.out, /widget/);
  } finally {
    rmDir(dir);
  }
});

test("--sandbox-dir validates a sandbox layer kept outside the deployment dir", () => {
  const layerSrc = scaffold("check-layer-src");
  const dep = tmp("check-layer-dep");
  try {
    writeConfig(dep, { orgId: "acme", target: "docker" });
    const r = runCli(["check", "--sandbox-dir", join(layerSrc, "sandbox")], { cwd: dep });
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, /example-tool/);
  } finally {
    rmDir(layerSrc);
    rmDir(dep);
  }
});

test("check with no config in the directory is a clear error", () => {
  const dir = tmp("check-noconfig");
  try {
    const r = runCli(["check"], { cwd: dir });
    assert.equal(r.code, 1);
    assert.match(r.out, /qm\.config\.json/);
  } finally {
    rmDir(dir);
  }
});
