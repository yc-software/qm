import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runSandboxBuild, type SandboxBuildOpts } from "../src/commands/sandbox.ts";
import type { QmConfig } from "../src/config.ts";

const CONFIG: QmConfig = {
  contract: 1,
  orgId: "acme",
  publicUrl: "http://localhost:8080",
  target: "docker",
  services: ["core"],
  plugins: [],
  skills: [],
  env: {},
  imageOverrides: {},
};

function sandboxDir(setup: (sb: string) => void): string {
  const dir = mkdtempSync(join(tmpdir(), "qm-sbx-build-"));
  const sb = join(dir, "sandbox");
  mkdirSync(sb, { recursive: true });
  setup(sb);
  return sb;
}

function tool(sb: string, id: string, descriptor: object, withExe = true): void {
  const td = join(sb, "tools", id);
  mkdirSync(td, { recursive: true });
  writeFileSync(join(td, "tool.json"), JSON.stringify(descriptor));
  if (withExe) {
    writeFileSync(join(td, id), "#!/usr/bin/env bash\necho hi\n");
    chmodSync(join(td, id), 0o755);
  }
}

function dryRun(opts: Omit<SandboxBuildOpts, "dryRun" | "config"> & { config?: QmConfig }): string {
  const lines: string[] = [];
  const log = console.log,
    warn = console.warn;
  console.log = (...a: unknown[]): void => void lines.push(a.join(" "));
  console.warn = (...a: unknown[]): void => void lines.push(a.join(" "));
  try {
    runSandboxBuild({ ...opts, config: opts.config ?? CONFIG, dryRun: true });
  } finally {
    console.log = log;
    console.warn = warn;
  }
  return lines.join("\n").replace(/\x1b\[[0-9;]*m/g, "");
}

test("generates a Dockerfile that COPYs each tool executable onto PATH + bakes the presence check", () => {
  const sb = sandboxDir((s) => tool(s, "example-tool", { id: "example-tool", install: { binary: "example-tool" } }));
  try {
    const out = dryRun({ sandboxDir: sb });
    assert.match(out, /FROM registry\.invalid\/qm\/qm-sandbox-base@sha256:a{64}/);
    assert.match(out, /COPY tools\/example-tool\/example-tool \/usr\/local\/bin\/example-tool/);
    assert.match(out, /command -v "\$b"/);
    assert.match(out, /'example-tool'/);
    assert.match(out, /acme-sandbox:local/);
  } finally {
    rmSync(sb, { recursive: true, force: true });
  }
});

test("--from overrides the base image for the generated Dockerfile", () => {
  const sb = sandboxDir((s) => tool(s, "t", { id: "t" }));
  try {
    const out = dryRun({ sandboxDir: sb, app: "acme-sandboxes", from: "registry.fly.io/custom-base:v1" });
    assert.match(out, /FROM registry\.fly\.io\/custom-base:v1/);
  } finally {
    rmSync(sb, { recursive: true, force: true });
  }
});

test("a custom sandbox/Dockerfile owns the recipe; --from is warned-ignored; presence check appended", () => {
  const sb = sandboxDir((s) => {
    tool(s, "apt-tool", { id: "apt-tool", install: { binary: "apt-tool" } }, false);
    writeFileSync(join(s, "Dockerfile"), "FROM my/base:1\nRUN apt-get install -y apt-tool\n");
  });
  try {
    const out = dryRun({ sandboxDir: sb, app: "acme-sandboxes", from: "registry.fly.io/ignored:1" });
    assert.match(out, /FROM my\/base:1/);
    assert.match(out, /--from is ignored/);
    assert.match(out, /command -v "\$b"/);
    assert.match(out, /'apt-tool'/);
  } finally {
    rmSync(sb, { recursive: true, force: true });
  }
});

test("custom Dockerfile provenance recognizes platform flags, aliases, lowercase, and stage reuse", () => {
  const sb = sandboxDir((s) => {
    writeFileSync(
      join(s, "Dockerfile"),
      "from --platform=linux/arm64 my/base:1 AS build\nRUN true\nFROM build AS final\n",
    );
  });
  try {
    const out = dryRun({ sandboxDir: sb });
    assert.match(out, /base:\s+.*Dockerfile \(custom\)/);
    assert.match(out, /from --platform=linux\/arm64 my\/base:1 AS build/);
  } finally {
    rmSync(sb, { recursive: true, force: true });
  }
});

test("custom Dockerfiles must pin all but one distinct external base", () => {
  const sb = sandboxDir((s) => {
    writeFileSync(join(s, "Dockerfile"), "FROM first/base:1 AS build\nFROM second/base:2\n");
  });
  try {
    assert.throws(() => dryRun({ sandboxDir: sb }), /multiple mutable external base images/);
  } finally {
    rmSync(sb, { recursive: true, force: true });
  }
});

test("--tag sets the image tag", () => {
  const sb = sandboxDir((s) => tool(s, "t", { id: "t" }));
  try {
    const out = dryRun({ sandboxDir: sb, tag: "acme-sandbox:v2" });
    assert.match(out, /acme-sandbox:v2/);
  } finally {
    rmSync(sb, { recursive: true, force: true });
  }
});

test("sandbox build is local-only and ignores registry app selection", () => {
  const sb = sandboxDir((s) => tool(s, "t", { id: "t" }));
  const prev = process.env.FLY_SANDBOX_APP_NAME;
  try {
    process.env.FLY_SANDBOX_APP_NAME = "from-env";
    assert.match(dryRun({ sandboxDir: sb, app: "from-flag" }), /acme-sandbox:local/);
    assert.doesNotMatch(dryRun({ sandboxDir: sb, app: "from-flag" }), /from-flag|from-env/);
  } finally {
    if (prev === undefined) delete process.env.FLY_SANDBOX_APP_NAME;
    else process.env.FLY_SANDBOX_APP_NAME = prev;
    rmSync(sb, { recursive: true, force: true });
  }
});

test("a broken layer (tool with no executable and no Dockerfile) fails before building", () => {
  const sb = sandboxDir((s) => tool(s, "x", { id: "x", install: { binary: "x" } }, false));
  try {
    assert.throws(() => dryRun({ sandboxDir: sb }), /sandbox check failed/);
  } finally {
    rmSync(sb, { recursive: true, force: true });
  }
});
