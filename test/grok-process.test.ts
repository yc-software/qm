import assert from "node:assert/strict";
import { once } from "node:events";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { startGrokProcess } from "../src/harness/grok-process.ts";

function executable(directory: string, source: string): string {
  const path = join(directory, "process");
  writeFileSync(path, `#!${process.execPath}\n${source}\n`, { mode: 0o700 });
  chmodSync(path, 0o700);
  return path;
}

function launcher(directory: string): string {
  const path = join(directory, "launcher");
  writeFileSync(path, '#!/bin/sh\nexec "$@"\n', { mode: 0o700 });
  chmodSync(path, 0o700);
  return path;
}

test("Grok process shutdown begins with stdin EOF", async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "qm-grok-process-test-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const binary = executable(directory, "process.stdin.resume(); process.stdin.once('end', () => process.exit(0));");
  const running = startGrokProcess(binary, [], {
    cwd: directory,
    env: { PATH: process.env.PATH },
    eofGraceMs: 500,
    termGraceMs: 50,
    killGraceMs: 50,
  });

  await running.stop();
  assert.deepEqual(await running.exited, { code: 0, signal: null });
});

test("Grok process launchers receive the verified binary and arguments", async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "qm-grok-process-test-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const binary = executable(directory, "process.stdin.resume(); process.stdin.once('end', () => process.exit(0));");
  const running = startGrokProcess(binary, ["agent", "stdio"], {
    cwd: directory,
    env: { PATH: process.env.PATH },
    launcherPath: launcher(directory),
    eofGraceMs: 500,
  });

  await running.stop();
  assert.deepEqual(await running.exited, { code: 0, signal: null });
});

test("Grok process shutdown escalates through the detached process group", async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "qm-grok-process-test-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const binary = executable(
    directory,
    "process.stdin.resume(); process.on('SIGTERM', () => undefined); process.stdout.write('ready'); setInterval(() => undefined, 1000);",
  );
  const running = startGrokProcess(binary, [], {
    cwd: directory,
    env: { PATH: process.env.PATH },
    eofGraceMs: 25,
    termGraceMs: 25,
    killGraceMs: 500,
  });

  await once(running.child.stdout, "data");
  await running.stop();
  assert.equal((await running.exited).signal, "SIGKILL");
});
