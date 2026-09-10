import assert from "node:assert/strict";
import { test } from "node:test";
import { getContextPolicy, setContextPolicy } from "../src/api/routes/context-policy.ts";
import type { ApiCtx } from "../src/api/routes/route.ts";
import { createMemoryChannelPolicyStore } from "../src/surface-cache/channel-policy-store.ts";
import { createAmbientHelpers } from "../src/api/app-ambient.ts";
import { createTurnMethods } from "../src/api/app-turn.ts";
import type { App, AppDeps } from "../src/api/app-types.ts";
import { orgId } from "../src/config.ts";
import { isSharedScope, parseScopeId } from "../src/types.ts";

for (const ambientEnabled of [true, false, null])
  test(`project orders-only save reaches the actual addressed-turn envelope (legacy=${ambientEnabled})`, async () => {
    const channelPolicy = createMemoryChannelPolicyStore();
    const ref = "web-project-317";
    const scope = `group:${ref}`;
    await channelPolicy.set(ref, "before", { ambientEnabled, bots: { CI: { mode: "action" } } });
    const orders = "Issue 317: keep the project standing order in addressed turns.";
    let status = 0;
    let body: any;
    const ctx = {
      url: new URL(`http://test/v1/contexts/policy?principalId=alice&scope=${scope}`),
      body: { principalId: "alice", scope, orders },
      res: {
        writeHead(s: number) {
          status = s;
        },
        end(s: string) {
          body = JSON.parse(s);
        },
      },
      app: { listContexts: async () => [{ scopeId: scope }] },
      deps: { channelPolicy, auditLog: { record() {} } },
    } as unknown as ApiCtx;
    await setContextPolicy(ctx);
    assert.equal(status, 200);
    await getContextPolicy(ctx);
    assert.equal(status, 200);
    assert.equal(body.policy.orders, orders);
    assert.equal(body.policy.supportsAmbient, false);
    let captured: any;
    let judges = 0;
    const actor = { id: "alice", type: "internal" };
    const deps = {
      channelPolicy,
      identity: {
        refresh: async () => {},
        resolve: () => actor,
        isInternal: (p: any) => p.type === "internal",
        classify: (id: string) => ({ id, type: "internal" }),
      },
      config: { getRuntimeSelectionDurable: async () => null, getIndividualModelAuthDurable: async () => true },
      userModelCredentials: {},
      projects: {
        get: async () => ({
          id: "317",
          orgId: orgId(),
          ownerId: "alice",
          memberIds: ["alice"],
          name: "Synthetic",
          updatedAt: 1,
        }),
        withVersion: async (_ref: string, _v: number, fn: () => Promise<unknown>) => fn(),
      },
      directory: { get: async () => null },
      sessions: { getByThread: async () => null, participantsOf: async () => [] },
      runs: {
        enqueue: async ({ request }: any) => {
          captured = request;
          return { run: { id: "synthetic", status: "pending", request }, deduped: false };
        },
      },
      ambientJudge: async () => {
        judges++;
        return { act: false };
      },
    } as unknown as AppDeps;
    const ambient = createAmbientHelpers(deps, {} as App);
    const app = createTurnMethods(
      deps,
      { pendingApprovalResultForThread: async () => null } as unknown as Parameters<typeof createTurnMethods>[1],
      ambient,
    );
    const r = await app.turn({
      surface: "web",
      liveActor: true,
      async: true,
      actor: { externalId: "alice" },
      conversation: { kind: "group", channelRef: ref, threadRef: "web:alice:synthetic-317" },
      text: "Synthetic project message",
    });
    assert.equal(r.status, "queued");
    assert.equal(captured.envelopeWrapped, true);
    assert.equal(captured.addressed, true);
    assert.match(captured.text, /<standing-orders/);
    assert.ok(captured.text.includes(orders));
    assert.match(captured.text, /<wake reason="addressed" surface="web"/);
    assert.equal(judges, 0);
  });

test("ambient applicability does not narrow shared scopes or require parsed project IDs", async () => {
  const { supportsAmbientControls } = await import("../src/surface-cache/policy-scope.ts");
  for (const scope of ["channel:C1", "channel:private", "group:G1"]) assert.equal(supportsAmbientControls(scope), true);
  for (const scope of [
    "group:web-project-317",
    "group:web-project-",
    "group:web-project-invalid:tail",
    "channel:",
    "group:",
    "personal:alice",
    "team:T1",
    "org:default-org",
  ])
    assert.equal(supportsAmbientControls(scope), false, scope);
  assert.equal(isSharedScope("group:web-project-317"), true);
  assert.deepEqual(parseScopeId("group:web-project-317"), { kind: "group", ref: "web-project-317" });
});
