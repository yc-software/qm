import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSpritesSandbox } from "../src/sandbox/sprites-sandbox.ts";
import { createLocalWorkspaceStore } from "../src/workspace/workspace-store.ts";
import { scopeId } from "../src/types.ts";
import { nonInteractiveShellPrefix, NONINTERACTIVE_ENV } from "../src/sandbox/sandbox-env.ts";
import { installFakeSprites, type FakeSprites } from "./support/fake-sprites.ts";
import { createMemoryMap } from "../src/persistence/durable-map.ts";
import { createMemoryAdvisoryLock } from "../src/persistence/advisory-lock.ts";

let ff: FakeSprites;
before(() => {
  ff = installFakeSprites();
});
after(() => ff.cleanup());

function spritesHandle(env?: Record<string, string>) {
  const dir = mkdtempSync(join(tmpdir(), "noninteractive-"));
  const sandbox = createSpritesSandbox(createLocalWorkspaceStore(dir), {
    initializationStore: createMemoryMap(),
    advisoryLock: createMemoryAdvisoryLock(),
    token: "test-token",
    baseUrl: ff.baseUrl,
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

test("provisioning installs a sudoers env_keep entry so sudo keeps the proxy and non-interactive env", async () => {
  const bin = mkdtempSync(join(tmpdir(), "nopass-sudo-"));
  writeFileSync(join(bin, "sudo"), '#!/bin/sh\nwhile [ "${1#-}" != "$1" ]; do shift; done\nexec "$@"\n');
  chmodSync(join(bin, "sudo"), 0o755);
  const path = process.env.PATH;
  process.env.PATH = `${bin}:${path}`;
  try {
    const { sandbox, layers } = spritesHandle();
    const first = await sandbox.provision(layers);
    const sudoersDir = join(ff.homeDir(first.id), ".etc-sudoers.d");
    assert.equal(existsSync(sudoersDir), false);
    mkdirSync(sudoersDir);
    await sandbox.provision(layers);
    assert.equal(
      readFileSync(join(sudoersDir, "qm-env"), "utf8"),
      'Defaults env_keep += "DEBIAN_FRONTEND GIT_TERMINAL_PROMPT http_proxy https_proxy HTTP_PROXY HTTPS_PROXY ALL_PROXY all_proxy no_proxy NO_PROXY GIT_HTTP_PROXY_AUTHMETHOD"\n',
    );
  } finally {
    process.env.PATH = path;
  }
});
