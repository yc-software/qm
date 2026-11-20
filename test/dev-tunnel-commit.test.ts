import assert from "node:assert/strict";
import { test } from "node:test";
import { chmodSync, existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveSandbox, startQuickTunnel } from "../scripts/dev/lib/sandbox.ts";
import { killTree, pidAlive } from "../scripts/dev/lib/proc.ts";

function fakeCloudflared(dir: string): void {
  const bin = join(dir, "cloudflared");
  writeFileSync(
    bin,
    `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args[0] === "--version") process.exit(0);
const [host, port] = args[args.indexOf("--metrics") + 1].split(":");
require("node:http").createServer((_, res) => res.end(JSON.stringify({ hostname: "t" + process.pid + ".trycloudflare.com" }))).listen(Number(port), host);
`,
  );
  chmodSync(bin, 0o755);
}

test("a quick tunnel writes no supervisor pid file and reports its own URL, not an earlier tunnel's", async () => {
  const dir = mkdtempSync(join(tmpdir(), "qm-tunnel-"));
  fakeCloudflared(dir);
  const path = process.env.PATH;
  process.env.PATH = `${dir}:${path}`;
  try {
    const first = await startQuickTunnel(1, dir, () => {});
    const second = await startQuickTunnel(1, dir, () => {});
    assert.ok(first && second);
    assert.equal(existsSync(join(dir, "tunnel.pid")), false);
    assert.equal(first.url, `https://t${first.pid}.trycloudflare.com`);
    assert.equal(second.url, `https://t${second.pid}.trycloudflare.com`);
    assert.ok(pidAlive(first.pid) && pidAlive(second.pid));
    await killTree(first.pid, 1000);
    await killTree(second.pid, 1000);
  } finally {
    process.env.PATH = path;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a quick tunnel that fails reports no URL instead of the cloudflared API host", async () => {
  const dir = mkdtempSync(join(tmpdir(), "qm-tunnel-"));
  const bin = join(dir, "cloudflared");
  writeFileSync(
    bin,
    `#!/bin/sh\n[ "$1" = "--version" ] && exit 0\necho 'failed to request quick Tunnel: Post "https://api.trycloudflare.com/tunnel": EOF'\nexit 1\n`,
  );
  chmodSync(bin, 0o755);
  const path = process.env.PATH;
  process.env.PATH = `${dir}:${path}`;
  try {
    const started = await startQuickTunnel(1, dir, () => {});
    assert.equal(started?.url, null);
  } finally {
    process.env.PATH = path;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("sandbox resolution gets its self-API URL from the caller's tunnel and starts none itself", async () => {
  let calls = 0;
  const resolved = await resolveSandbox({
    worktree: "/nonexistent",
    requested: "sprites",
    corePort: 1,
    tunnel: async () => {
      calls++;
      return "https://committed.trycloudflare.com";
    },
    baseEnv: { SPRITES_TOKEN: "t" },
    log() {},
  });
  assert.equal(calls, 1);
  assert.equal(resolved.publicApiUrl, "https://committed.trycloudflare.com");
  assert.equal(resolved.env.PUBLIC_API_URL, "https://committed.trycloudflare.com");
});
