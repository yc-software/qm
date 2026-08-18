import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { run, spawnDetached, winSpawnArgv } from "../scripts/dev/lib/proc.ts";

const onWindows = process.platform === "win32";

test("winSpawnArgv routes batch shims through cmd.exe on Windows", { skip: !onWindows }, () => {
  const { cmd, args } = winSpawnArgv("npm", ["--version"]);
  assert.match(cmd, /cmd\.exe$/i);
  assert.deepEqual(args.slice(0, 3), ["/d", "/s", "/c"]);
  // Everything after /c is one pre-quoted command line (paths with spaces stay
  // intact for cmd.exe's re-parse), wrapped in an outer pair /s strips.
  assert.equal(args.length, 4, "single command-line argument after /c");
  const line = args[3]!;
  assert.ok(line.startsWith('"') && line.endsWith('"'), "outer quote pair present");
  assert.match(line, /npm\.cmd/i, "npm must resolve to its .cmd shim on PATH");
  assert.match(line, /--version"?\s*$/, "original args preserved");
});

test("winSpawnArgv resolves plain executables without cmd.exe on Windows", { skip: !onWindows }, () => {
  const { cmd, args } = winSpawnArgv("node", ["-e", "0"]);
  assert.doesNotMatch(cmd, /cmd\.exe$/i, "node.exe must not be routed through cmd.exe");
  assert.match(cmd, /node(\.exe)?$/i);
  assert.equal(args[0], "-e");
});

test("winSpawnArgv passes non-batch and unknown commands through", { skip: onWindows }, () => {
  assert.deepEqual(winSpawnArgv("npm", ["--version"]), { cmd: "npm", args: ["--version"], verbatim: false });
});

test("run() executes npm on Windows (bare-name spawn regression)", { skip: !onWindows }, async () => {
  // Before the fix this resolved to spawn("npm") -> ENOENT (or spawn("npm.cmd") ->
  // EINVAL), reported as code -1 with the spawn error in stderr.
  const res = await run("npm", ["--version"], { timeoutMs: 60_000 });
  assert.equal(res.code, 0, `npm --version failed: ${res.stderr}`);
  assert.match(res.stdout.trim(), /^\d+\.\d+\.\d+/, "npm printed its version");
});

test("spawnDetached runs a node child through the same choke point", async () => {
  const dir = mkdtempSync(join(tmpdir(), "qm-proc-test-"));
  try {
    const marker = join(dir, "marker.txt");
    spawnDetached({
      cwd: dir,
      logFile: join(dir, "log.txt"),
      argv: [
        process.execPath,
        "-e",
        `require("node:fs").writeFileSync(${JSON.stringify(marker)}, "ok")`,
      ],
      env: process.env as Record<string, string>,
    });
    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline && !existsSync(marker)) {
      await new Promise((r) => setTimeout(r, 100));
    }
    assert.ok(existsSync(marker), "detached child ran");
    assert.equal(readFileSync(marker, "utf8"), "ok");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
