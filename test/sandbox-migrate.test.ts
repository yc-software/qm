import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { copyHome } from "../src/sandbox/sandbox-migrate.ts";
import type { Sandbox, SandboxHandle, ExecResult } from "../src/sandbox/sandbox.ts";

function hostSandbox(homeDir: string): { sandbox: Sandbox; handle: SandboxHandle } {
  mkdirSync(homeDir, { recursive: true });
  const rootDir = join(homeDir, "workspace");
  mkdirSync(rootDir, { recursive: true });
  const resolve = (rel: string) => join(rootDir, rel);
  const sandbox: Partial<Sandbox> = {
    async run(_h, command): Promise<ExecResult> {
      const r = spawnSync("sh", ["-c", command], {
        encoding: "utf8",
        maxBuffer: 64 * 1024 * 1024,
        env: { PATH: process.env.PATH ?? "" },
      });
      return {
        stdout: r.stdout ?? "",
        stderr: r.stderr ?? "",
        code: r.status ?? (r.signal ? 137 : -1),
        timedOut: false,
      };
    },
    async readFileBytes(_h, rel): Promise<Uint8Array | null> {
      const p = resolve(rel);
      return existsSync(p) ? readFileSync(p) : null;
    },
    async writeFileBytes(_h, rel, data): Promise<void> {
      const p = resolve(rel);
      mkdirSync(dirname(p), { recursive: true });
      writeFileSync(p, data);
    },
  };
  return { sandbox: sandbox as Sandbox, handle: { id: homeDir, rootDir } };
}

test("copyHome moves $HOME, sha-verifies, rewrites paths, and nukes venvs", async () => {
  const root = mkdtempSync(join(tmpdir(), "copyhome-"));
  const fromHome = join(root, "src");
  const toHome = join(root, "dst");
  const src = hostSandbox(fromHome);
  const dst = hostSandbox(toHome);
  try {
    writeFileSync(join(fromHome, "notes.txt"), "hello\n");
    mkdirSync(join(fromHome, ".config"), { recursive: true });
    writeFileSync(join(fromHome, ".config", "app.conf"), `workdir=${fromHome}/workspace\n`);
    writeFileSync(join(fromHome, ".bashrc"), `export HOME_ALIAS=${fromHome}\nkeep=${fromHome}fs/data\n`);
    const venv = join(fromHome, "workspace", "venv");
    mkdirSync(join(venv, "bin"), { recursive: true });
    writeFileSync(join(venv, "pyvenv.cfg"), "home = /usr/bin\n");
    writeFileSync(join(venv, "bin", "python"), `#!${fromHome}/workspace/venv/bin/python3\n`);

    const res = await copyHome({
      fromSandbox: src.sandbox,
      fromHandle: src.handle,
      fromHome,
      toSandbox: dst.sandbox,
      toHandle: dst.handle,
      toHome,
    });

    assert.match(res.sha, /^[0-9a-f]{64}$/);
    assert.ok(res.sourceFiles >= 3);
    assert.equal(readFileSync(join(toHome, "notes.txt"), "utf8"), "hello\n");
    assert.equal(readFileSync(join(toHome, ".config", "app.conf"), "utf8"), `workdir=${toHome}/workspace\n`);
    assert.equal(
      readFileSync(join(toHome, ".bashrc"), "utf8"),
      `export HOME_ALIAS=${toHome}\nkeep=${fromHome}fs/data\n`,
    );
    assert.ok(!existsSync(join(toHome, "workspace", "venv")), "venv should be nuked");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("copyHome never mutates the source", async () => {
  const root = mkdtempSync(join(tmpdir(), "copyhome-src-"));
  const fromHome = join(root, "src");
  const toHome = join(root, "dst");
  const src = hostSandbox(fromHome);
  const dst = hostSandbox(toHome);
  try {
    mkdirSync(join(fromHome, ".config"));
    writeFileSync(join(fromHome, ".config", "app.conf"), `workdir=${fromHome}/x\n`);
    await copyHome({
      fromSandbox: src.sandbox,
      fromHandle: src.handle,
      fromHome,
      toSandbox: dst.sandbox,
      toHandle: dst.handle,
      toHome,
    });
    assert.equal(readFileSync(join(fromHome, ".config", "app.conf"), "utf8"), `workdir=${fromHome}/x\n`);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("copyHome throws on a corrupt transfer instead of leaving a truncated $HOME", async () => {
  const root = mkdtempSync(join(tmpdir(), "copyhome-corrupt-"));
  const fromHome = join(root, "src");
  const toHome = join(root, "dst");
  const src = hostSandbox(fromHome);
  const dst = hostSandbox(toHome);
  writeFileSync(join(fromHome, "big.txt"), "x".repeat(5000));
  const corrupt: Sandbox = {
    ...dst.sandbox,
    async writeFileBytes(h, rel, data) {
      const bad = Buffer.from(data);
      bad[0] = bad[0]! ^ 0xff;
      return dst.sandbox.writeFileBytes(h, rel, bad);
    },
  };
  try {
    await assert.rejects(
      copyHome({
        fromSandbox: src.sandbox,
        fromHandle: src.handle,
        fromHome,
        toSandbox: corrupt,
        toHandle: dst.handle,
        toHome,
      }),
      /sha-mismatch|verify\/extract failed/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
