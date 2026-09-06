import { test } from "node:test";
import assert from "node:assert/strict";
import { createToolContext, type ToolContextDeps } from "../src/tools/primitives.ts";
import { scopeId, type WorkspaceLayer } from "../src/types.ts";
import type { Sandbox, SandboxHandle } from "../src/sandbox/sandbox.ts";

const handle: SandboxHandle = { id: "h", rootDir: "/workspace" };
const healthy = { machine: "healthy", listed: "warm", provisioned: true, guestResponsive: true };

function ctxFor(sandbox: Partial<Sandbox>, provision: ToolContextDeps["provision"]) {
  const scope = scopeId("channel", "C1");
  const layers: WorkspaceLayer[] = [{ scopeId: scope, mountPath: "", mode: "rw" }];
  return createToolContext({
    sandbox: { profile: { backend: "sprites" }, ...sandbox } as unknown as Sandbox,
    provision,
    layers,
    commandPolicy: () => ({ mode: "denylist", rules: [] }),
    authorizeCommand: () => false,
    grantedHandles: [],
    workspace: {} as never,
    deploy: {} as never,
    acl: {} as never,
    createdBy: "U1",
  });
}

test("computerStatus reports the guest as answering only when a command survives the real provision path", async () => {
  const ctx = ctxFor(
    {
      computerStatus: async () => healthy,
      run: async () => ({ stdout: "", stderr: "", code: 0, timedOut: false }),
    },
    async () => handle,
  );
  assert.deepEqual(await ctx.computerStatus(), healthy);
});

test("a provision failure turns a healthy-looking machine into NOT answering and names the cause", async () => {
  const ctx = ctxFor({ computerStatus: async () => healthy }, async () => {
    throw new TypeError("fetch failed", {
      cause: Object.assign(new Error("New streams cannot be created after receiving a GOAWAY"), {
        code: "ERR_HTTP2_GOAWAY_SESSION",
      }),
    });
  });
  const status = await ctx.computerStatus();
  assert.equal(status.guestResponsive, false);
  assert.equal(status.machine, "healthy");
  assert.match(status.probeError ?? "", /fetch failed <- Error ERR_HTTP2_GOAWAY_SESSION: New streams/);
});

test("a command that exits non-zero on the provisioned box is NOT answering without a probe error", async () => {
  const ctx = ctxFor(
    {
      computerStatus: async () => healthy,
      run: async () => ({ stdout: "", stderr: "", code: 127, timedOut: false }),
    },
    async () => handle,
  );
  const status = await ctx.computerStatus();
  assert.equal(status.guestResponsive, false);
  assert.equal(status.probeError, undefined);
});

test("computerStatus never provisions when the backend reports no machine", async () => {
  let provisions = 0;
  const none = { machine: "no sandbox provisioned yet", provisioned: false, guestResponsive: false };
  const ctx = ctxFor({ computerStatus: async () => none }, async () => {
    provisions += 1;
    return handle;
  });
  assert.deepEqual(await ctx.computerStatus(), none);
  assert.equal(provisions, 0, "a status check must not cold-start a box");
});
