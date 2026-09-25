import "./support/auto-fake-sprites.ts";
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildApp } from "../src/wiring.ts";
import { testConfig } from "./support/test-config.ts";
import { actingPrincipal, loopRoutes } from "../src/api/routes/loops.ts";
import { findRoute, run, type ApiCtx } from "../src/api/routes/route.ts";
import { CONTROL_PLANE_AUD } from "../src/auth/capability-token.ts";

test("Open live authors can restore and retarget loops without gaining ship authority", async () => {
  const built = buildApp(testConfig());
  const { loop } = await built.loops.store.create({
    owner: "owner",
    createdBy: "owner",
    ownerScopeId: "personal:owner",
    name: "synthetic",
    playbook: "inspect",
    successCondition: "inspected",
    shipActions: [{ action: "send", gate: "hold" }],
  });
  const capability = {
    actorId: "admin-alice",
    scopeId: "group:room",
    aud: CONTROL_PLANE_AUD,
    liveActor: false,
    liveAuthor: true,
    exp: Date.now() + 60_000,
  };
  const deps = {
    ...built,
    config: { ...built.config, resolveSharingPostureDurable: async () => "open" as const },
  };
  const call = async (method: string, suffix: string, body: unknown, liveAuthor = true) => {
    const pathname = `/v1/loops/${loop.id}${suffix}`;
    const found = findRoute(loopRoutes, method, pathname)!;
    let status = 0;
    const ctx = {
      deps,
      app: built.app,
      method,
      pathname,
      url: new URL(`http://localhost${pathname}`),
      params: found.params,
      body,
      capability: { ...capability, liveAuthor },
      res: {
        writeHead(code: number) {
          status = code;
          return this;
        },
        end() {},
      },
    } as unknown as ApiCtx;
    assert.equal(actingPrincipal(ctx)?.liveHuman, liveAuthor);
    await run(found.route, found.params, ctx);
    return status;
  };
  for (const state of ["quarantined", "archived"] as const) {
    await built.loops.store.update(loop.id, { state });
    assert.equal(await call("PATCH", "", { state: "enabled" }, false), 403);
    assert.equal(await call("PATCH", "", { state: "enabled" }), 200);
    assert.equal((await built.loops.store.get(loop.id))?.state, "enabled");
  }
  assert.equal(await call("PATCH", "", { destinationKey: null }), 200);
  assert.equal(await call("POST", "/autopilot", { enabled: true }), 403);
  assert.equal(await call("POST", "/grants", { shipAction: "send" }), 403);
  assert.equal(await call("POST", "/outputs/output/decide", { decision: "ship" }), 403);
  assert.equal((await built.loops.store.get(loop.id))?.owner, "owner");
  assert.equal((await built.loops.store.get(loop.id))?.createdBy, "owner");
});
