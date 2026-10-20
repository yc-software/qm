import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSpritesSandbox } from "../src/sandbox/sprites-sandbox.ts";
import { createLocalWorkspaceStore } from "../src/workspace/workspace-store.ts";
import { scopeId } from "../src/types.ts";
import { nonInteractiveShellPrefix, NONINTERACTIVE_ENV } from "../src/sandbox/sandbox-env.ts";
import { installFakeSprites, type FakeSprites } from "./support/fake-sprites.ts";
import { createMemoryMap } from "../src/persistence/durable-map.ts";
import { createMemoryAdvisoryLock } from "../src/persistence/advisory-lock.ts";
import { mintCapabilityToken, EGRESS_PROXY_AUD } from "../src/auth/capability-token.ts";

let ff: FakeSprites;
before(() => {
  ff = installFakeSprites();
});
after(() => ff.cleanup());

function spritesHandle(env?: Record<string, string>, extra: { egressProxyUrl?: string } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "noninteractive-"));
  const sandbox = createSpritesSandbox(createLocalWorkspaceStore(dir), {
    initializationStore: createMemoryMap(),
    advisoryLock: createMemoryAdvisoryLock(),
    token: "test-token",
    baseUrl: ff.baseUrl,
    ...extra,
  });
  const layers = [{ scopeId: scopeId("personal", "U1"), mountPath: "", mode: "rw" as const }];
  return { sandbox, layers, ...(env ? { env } : {}) };
}

test("the shell prefix detaches stdin and exports every non-interactive default", () => {
  const prefix = nonInteractiveShellPrefix();
  assert.match(prefix, /exec <\/dev\/null;/);
  assert.match(prefix, /export PAGER="\$\{PAGER:-cat\}"/);
  assert.match(prefix, /export GIT_TERMINAL_PROMPT="\$\{GIT_TERMINAL_PROMPT:-0\}"/);
  assert.match(prefix, /export AWS_PAGER="\$\{AWS_PAGER-\}"/);
  for (const [name] of NONINTERACTIVE_ENV) assert.ok(prefix.includes(`export ${name}=`));
});

test("a command reading stdin gets EOF instead of burning the timeout", async () => {
  const { sandbox, layers } = spritesHandle();
  const handle = await sandbox.provision(layers);
  const r = await sandbox.run(handle, "cat", { timeoutMs: 3000 });
  assert.equal(r.timedOut, false);
  assert.equal(r.code, 0);
  assert.equal(r.stdout, "");
});

test("pager/frontend/terminal-prompt defaults are present in the command environment", async () => {
  const { sandbox, layers } = spritesHandle();
  const handle = await sandbox.provision(layers);
  const r = await sandbox.run(
    handle,
    'printf "%s|%s|%s|%s|[%s]" "$PAGER" "$GIT_PAGER" "$GIT_TERMINAL_PROMPT" "$DEBIAN_FRONTEND" "$AWS_PAGER"',
  );
  assert.equal(r.stdout, "cat|cat|0|noninteractive|[]");
});

test("an explicit per-turn env value wins over the non-interactive default", async () => {
  const { sandbox, layers, env } = spritesHandle({ PAGER: "less" });
  const handle = await sandbox.provision(layers, env ? { env } : undefined);
  const r = await sandbox.run(handle, 'printf "%s" "$PAGER"');
  assert.equal(r.stdout, "less");
});

function resettingSudoDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "fake-sudo-"));
  const sudo = join(dir, "sudo");
  writeFileSync(
    sudo,
    [
      "#!/usr/bin/env node",
      'const { spawnSync } = require("node:child_process");',
      "const args = process.argv.slice(2);",
      "let keep = [];",
      'while (args[0]?.startsWith("-")) {',
      "  const flag = args.shift();",
      '  if (flag.startsWith("--preserve-env=")) keep = flag.slice(15).split(",");',
      '  else if (flag === "-u") args.shift();',
      "}",
      "const env = { PATH: process.env.PATH };",
      "for (const name of keep) if (process.env[name] !== undefined) env[name] = process.env[name];",
      'process.exit(spawnSync(args[0], args.slice(1), { env, stdio: "inherit" }).status ?? 1);',
    ].join("\n"),
  );
  chmodSync(sudo, 0o755);
  return dir;
}

test("sudo keeps the forced egress proxy and non-interactive env that sudo would otherwise reset", async () => {
  const fakeSudo = resettingSudoDir();
  const { sandbox, layers } = spritesHandle(undefined, { egressProxyUrl: "https://proxy.example.com" });
  const egressToken = await mintCapabilityToken(
    { actorId: "tester", scopeId: layers[0]!.scopeId, aud: EGRESS_PROXY_AUD, exp: Date.now() + 600_000 },
    "secret",
  );
  const handle = await sandbox.provision(layers, { egressToken, env: { PATH: `${fakeSudo}:${process.env.PATH}` } });
  const r = await sandbox.run(
    handle,
    `sudo -u root sh -c 'printf "%s|%s|%s" "$DEBIAN_FRONTEND" "$(echo "$HTTPS_PROXY" | sed "s/x:.*@/x:T@/")" "$NO_PROXY"'`,
  );
  assert.equal(r.code, 0, r.stderr);
  assert.equal(r.stdout, "noninteractive|https://x:T@proxy.example.com|localhost,127.0.0.1,::1");
});
