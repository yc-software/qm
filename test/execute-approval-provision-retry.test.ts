import { test } from "node:test";
import assert from "node:assert/strict";
import { NeedsApproval, createToolContext } from "../src/tools/primitives.ts";
import { scopeId } from "../src/types.ts";
import type { Sandbox, SandboxHandle } from "../src/sandbox/sandbox.ts";

test("an approved command whose computer is not ready yet keeps its one-time approval for the retry", async () => {
  const handle: SandboxHandle = { id: "box", rootDir: "/workspace" };
  let ready = false;
  let uses = 1;
  const ran: string[] = [];
  const ctx = createToolContext({
    sandbox: {
      async run(_handle: SandboxHandle, script: string) {
        ran.push(script);
        return { stdout: "", stderr: "", code: 0, timedOut: false };
      },
    } as unknown as Sandbox,
    provision: async () => {
      if (!ready) throw new Error("this conversation has no computer yet");
      return handle;
    },
    writableScopeId: scopeId("channel", "C1"),
    readOnlyScopeIds: [],
    commandPolicy: () => ({ mode: "denylist", rules: [{ pattern: "rm -rf", decision: "require_approval" }] }),
    authorizeCommand: () => {
      if (uses <= 0) return false;
      uses -= 1;
      return true;
    },
    restoreCommand: () => {
      uses += 1;
    },
    grantedHandles: [],
    deploy: {} as never,
    acl: {} as never,
    createdBy: "U1",
  });

  await assert.rejects(ctx.execute("rm -rf /tmp/x"), /no computer yet/);
  ready = true;
  await ctx.execute("rm -rf /tmp/x");
  assert.equal(ran.length, 1);
  await assert.rejects(ctx.execute("rm -rf /tmp/x"), (err) => err instanceof NeedsApproval);
});
