import assert from "node:assert/strict";
import { chmodSync, existsSync, lstatSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { parse } from "smol-toml";
import {
  authenticateGrokHome,
  createGrokTurnHome,
  grokChildEnv,
  scavengeGrokHomes,
  sha256FileSync,
  verifyGrokRuntime,
} from "../src/harness/grok-home.ts";

function executable(directory: string, source: string): string {
  const path = join(directory, "grok");
  writeFileSync(path, `#!${process.execPath}\n${source}\n`, { mode: 0o700 });
  chmodSync(path, 0o700);
  return path;
}

test("Grok child environment is allowlisted and keeps loopback outside the optional proxy", () => {
  const env = grokChildEnv(
    {
      LANG: "C.UTF-8",
      HTTPS_PROXY: "http://proxy.test:8080",
      HTTP_PROXY: "http://forbidden.test",
      ALL_PROXY: "socks://forbidden.test",
      NO_PROXY: "metadata.internal",
      XAI_API_KEY: "secret",
      GROK_BASE_URL: "https://forbidden.test",
      DATABASE_URL: "secret",
    },
    { root: "/tmp/root", grokHome: "/tmp/root/grok", processHome: "/tmp/root/home" },
  );

  assert.equal(env.HTTPS_PROXY, "http://proxy.test:8080");
  assert.equal(env.NO_PROXY, "127.0.0.1,localhost");
  assert.equal(env.HTTP_PROXY, undefined);
  assert.equal(env.ALL_PROXY, undefined);
  assert.equal(env.XAI_API_KEY, undefined);
  assert.equal(env.GROK_BASE_URL, undefined);
  assert.equal(env.DATABASE_URL, undefined);
  assert.equal(env.GROK_TELEMETRY_ENABLED, "0");
  assert.equal(env.GROK_SUBAGENTS, "0");
});

test("Grok turn home is owner-only, restrictive, and disposable", (t) => {
  const home = createGrokTurnHome("grok-4.6", {});
  t.after(() => home.cleanup());

  for (const directory of [home.root, home.workspace, home.grokHome, home.processHome])
    assert.equal(lstatSync(directory).mode & 0o777, 0o700);
  for (const path of [join(home.grokHome, "qm-agent.md"), join(home.grokHome, "config.toml")])
    assert.equal(lstatSync(path).mode & 0o777, 0o600);
  const profile = readFileSync(join(home.grokHome, "qm-agent.md"), "utf8");
  assert.match(profile, /tools:\n {2}- use_tool/);
  assert.match(profile, /disallowedTools:\n {2}- search_tool/);
  assert.match(profile, /agents_md: false/);
  assert.doesNotMatch(profile, /secret system prompt/);
  home.cleanup();
  assert.equal(existsSync(home.root), false);
});

test("Grok turn config encodes quoted, escaped, and Unicode profile paths as valid TOML", (t) => {
  const previousTmpdir = process.env.TMPDIR;
  const parent = mkdtempSync(join(tmpdir(), "qm-grok-'\\-雪-"));
  process.env.TMPDIR = parent;
  t.after(() => {
    if (previousTmpdir === undefined) delete process.env.TMPDIR;
    else process.env.TMPDIR = previousTmpdir;
    rmSync(parent, { recursive: true, force: true });
  });
  const home = createGrokTurnHome("grok-4.6", {});
  const parsed = parse(readFileSync(join(home.grokHome, "config.toml"), "utf8")) as {
    agent?: { definition?: string };
  };
  assert.equal(parsed.agent?.definition, join(home.grokHome, "qm-agent.md"));
});

test("Grok external login unlinks the access source and accepts only the external auth record", async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "qm-grok-auth-test-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const binary = executable(
    directory,
    `const fs = require("node:fs");
const path = require("node:path");
const tokenPath = path.join(process.env.GROK_HOME, "access-token");
const key = fs.readFileSync(tokenPath, "utf8");
fs.writeFileSync(path.join(process.env.GROK_HOME, "auth.json"), JSON.stringify({ external: { auth_mode: "external", key } }), { mode: 0o600 });
process.stderr.write("private identity\\n");`,
  );
  const home = createGrokTurnHome("grok-4.6", {});
  t.after(() => home.cleanup());

  await authenticateGrokHome(binary, home, "access-only", { launcherPath: join(directory, "must-not-run") }, 2_000);

  assert.equal(existsSync(join(home.grokHome, "access-token")), false);
  assert.equal(lstatSync(join(home.grokHome, "auth.json")).mode & 0o777, 0o600);
  assert.deepEqual(JSON.parse(readFileSync(join(home.grokHome, "auth.json"), "utf8")), {
    external: { auth_mode: "external", key: "access-only" },
  });
});

test("Grok runtime verification requires the pinned release and system-requirements tier", (t) => {
  const directory = mkdtempSync(join(tmpdir(), "qm-grok-verify-test-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const binary = executable(
    directory,
    `process.stdout.write(JSON.stringify({ grokVersion: "1.0.13", configSources: { layers: [{ role: "system-requirements", path: "/etc/grok/requirements.toml" }] } }));`,
  );

  assert.equal(
    verifyGrokRuntime(binary, { expectedSha256: sha256FileSync(binary), expectedVersion: "1.0.13" }),
    binary,
  );
  assert.throws(
    () => verifyGrokRuntime(binary, { expectedSha256: "0".repeat(64), expectedVersion: "1.0.13" }),
    /digest/,
  );
});

test("Grok startup scavenging removes only stale owner-only turn homes", (t) => {
  const parent = mkdtempSync(join(tmpdir(), "qm-grok-sweep-test-"));
  t.after(() => rmSync(parent, { recursive: true, force: true }));
  const uid = process.getuid?.();
  if (uid === undefined) return;
  const deadPid = 2_000_000_000;
  const stale = join(parent, `qm-grok-${deadPid}-stale`);
  const permissive = join(parent, `qm-grok-${deadPid}-permissive`);
  const live = join(parent, `qm-grok-${process.pid}-live`);
  for (const directory of [stale, permissive, live]) mkdirSync(directory, { mode: 0o700 });
  chmodSync(permissive, 0o755);

  assert.deepEqual(scavengeGrokHomes(parent, uid), [stale]);
  assert.equal(existsSync(stale), false);
  assert.equal(existsSync(permissive), true);
  assert.equal(existsSync(live), true);
});
