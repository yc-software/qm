import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { runCli, tmp, rmDir, writeConfig } from "./harness.ts";

function scaffold(label: string): string {
  const dir = tmp(label);
  assert.equal(runCli(["init", dir, "--org", "acme"]).code, 0);
  return dir;
}

test("sandbox build --dry-run generates the COPY-tools Dockerfile + the fly push command", () => {
  const dir = scaffold("sb-default");
  try {
    const r = runCli(["sandbox", "build", "--dry-run"], { cwd: dir });
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, /DRY RUN — nothing built/);
    assert.match(r.out, /FROM registry\.invalid\/qm\/qm-sandbox-base@sha256:a{64}/);
    assert.match(r.out, /COPY tools\/example-tool\/example-tool \/usr\/local\/bin\/example-tool/);
    assert.match(r.out, /command -v "\$b"/);
    assert.match(r.out, /docker buildx build --platform linux\/amd64 --load -t acme-sandbox:local/);
  } finally {
    rmDir(dir);
  }
});

test("sandbox build --tag overrides the local image tag", () => {
  const dir = scaffold("sb-apptag");
  try {
    const r = runCli(["sandbox", "build", "--tag", "v2", "--dry-run"], { cwd: dir });
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, /docker buildx build --platform linux\/amd64 --load -t v2/);
  } finally {
    rmDir(dir);
  }
});

test("sandbox build --from overrides the base image", () => {
  const dir = scaffold("sb-from");
  try {
    const r = runCli(["sandbox", "build", "--from", "ubuntu:24.04", "--dry-run"], { cwd: dir });
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, /FROM ubuntu:24\.04/);
  } finally {
    rmDir(dir);
  }
});

test("a custom sandbox/Dockerfile owns the recipe; --from is then ignored", () => {
  const dir = scaffold("sb-custom");
  try {
    writeFileSync(join(dir, "sandbox", "Dockerfile"), "FROM mybase:1\nRUN echo hi\n");
    const r = runCli(["sandbox", "build", "--from", "ignored:1", "--dry-run"], { cwd: dir });
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, /\(custom\)/);
    assert.match(r.out, /FROM mybase:1/);
    assert.match(r.out, /--from is ignored/);
    assert.match(r.out, /command -v "\$b"/);
  } finally {
    rmDir(dir);
  }
});

test("sandbox build with an empty layer is a clear error", () => {
  const dir = tmp("sb-empty");
  try {
    writeConfig(dir, { orgId: "acme", target: "docker" });
    const r = runCli(["sandbox", "build", "--dry-run"], { cwd: dir, env: { FLY_SANDBOX_APP_NAME: "" } });
    assert.equal(r.code, 1);
    assert.match(r.out, /nothing to build/);
  } finally {
    rmDir(dir);
  }
});

test("sandbox build runs the layer checks first — a broken descriptor fails before the build plan", () => {
  const dir = scaffold("sb-checks");
  try {
    writeFileSync(join(dir, "sandbox", "tools", "example-tool", "tool.json"), "{ broken");
    const r = runCli(["sandbox", "build", "--dry-run"], { cwd: dir });
    assert.equal(r.code, 1);
    assert.doesNotMatch(r.out, /DRY RUN/);
  } finally {
    rmDir(dir);
  }
});

test("`sandbox` without the build subcommand prints usage and exits 1", () => {
  const dir = scaffold("sb-usage");
  try {
    const r = runCli(["sandbox"], { cwd: dir });
    assert.equal(r.code, 1);
    assert.match(r.out, /usage:.*sandbox build/);
  } finally {
    rmDir(dir);
  }
});
