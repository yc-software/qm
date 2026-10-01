import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSpritesSandbox } from "../src/sandbox/sprites-sandbox.ts";
import { createLocalWorkspaceStore } from "../src/workspace/workspace-store.ts";
import { scopeId } from "../src/types.ts";
import { installFakeSprites, type FakeSprites } from "./support/fake-sprites.ts";

let ff: FakeSprites;
before(() => {
  ff = installFakeSprites();
});
after(() => ff.cleanup());

function spritesHandle(env?: Record<string, string>) {
  const dir = mkdtempSync(join(tmpdir(), "noninteractive-"));
  const sandbox = createSpritesSandbox(createLocalWorkspaceStore(dir), {
    token: "test-token",
    baseUrl: ff.baseUrl,
  });
  const layers = [{ scopeId: scopeId("personal", "U1"), mountPath: "", mode: "rw" as const }];
  return { sandbox, layers, ...(env ? { env } : {}) };
}

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
