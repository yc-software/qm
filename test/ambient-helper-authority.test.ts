import "./support/auto-fake-sprites.ts";

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { buildApp } from "./support/build-app.ts";
import { settle } from "./support/settle.ts";
import { testConfig } from "./support/test-config.ts";
import { withTenant } from "../src/tenants/context.ts";
import { scopeActor, scopeId } from "../src/types.ts";

const policies = { partner: { companyDomains: ["acme.com"], companyTeamIds: ["TINTERNAL"], serviceCredentials: [] } };
const source = { account: "default", workspace: "TINTERNAL", assistant: "UBOT" };

for (const wake of ["message", "scheduled"] as const)
  test(`an unprompted ${wake} worker in a private channel delegates there as the channel, and nothing else borrows that`, async (t) => {
    const built = buildApp(testConfig({ externalSlackPolicies: policies }));
    built.runtime.start();
    t.after(() => built.runtime.stop());
    const [here, other] = [scopeId("channel", "C-deals"), scopeId("channel", "C-other")];
    await built.directory.replace([{ principalId: "a@x.com", displayName: "A", type: "internal", slackId: "U-A" }]);
    await built.directory.replaceChannels(
      ["C-deals", "C-other"].map((channelId) => ({ channelId, name: channelId, isPrivate: true })),
      [{ channelId: "C-deals", principalId: "a@x.com" }],
    );
    await built.app.setChannelPolicy("C-deals", `${wake === "message" ? "!engage " : ""}watch for memos`, "U-admin");
    await built.app.ingestSurfaceEvents([
      { container: "C-deals", ts: "9.1", authorId: "U-A", authorName: "A", text: "memo?", createdAt: 1, source },
    ]);
    if (wake === "scheduled") {
      await settle(async () => (await built.ambientJudgments!.list({ container: "C-deals" })).length > 0);
      await built.app.setChannelPolicy("C-deals", "!engage watch for memos", "U-admin");
      await built.app.judgeAmbientContainer("slack", "C-deals", { reason: "scheduled" });
    }
    const thread = `slack:C-deals:ambient:${wake === "message" ? "9.1" : ""}`;
    let run: any;
    await settle(async () => {
      run = (await built.runs.list()).find((r) => r.sessionId === thread);
      return run?.status === "done";
    });
    const session = (await built.sessions.getByThread(run.sessionId))!;
    const open = (id: string, s = session): Promise<{ ok: boolean; message?: string; sessionId?: string }> =>
      built.sessionSyscalls
        .forTurn({
          session: s,
          scopeId: s.scopeId,
          request: { ...run.request, runId: run.id, actor: { id, type: "internal" } },
        })
        .open({ task: "look up the memo; read only" })
        .catch((err: Error) => ({ ok: false, message: err.message }));
    const opened = await open(run.request.actor.id);
    assert.ok(opened.ok, opened.message);
    assert.equal(run.request.actor.id, scopeActor(here));
    const [childRun] = await built.runs.list({ threadRef: (await built.sessions.get(opened.sessionId!))!.threadRef });
    assert.equal((await built.runs.waitFor(childRun!.id, 30_000)).status, "done");
    let parentWake: any;
    await settle(async () => {
      parentWake = (await built.runs.list({ threadRef: session.threadRef })).find((r) => r.id !== run.id);
      return parentWake?.status === "done";
    });
    assert.equal(parentWake?.status, "done");
    assert.equal(run.request.surfaceOrigin?.audience, "internal");
    for (const r of [childRun, parentWake]) assert.deepEqual(r.request.surfaceOrigin, run.request.surfaceOrigin);
    for (const id of [
      "system:ambient:default-org",
      scopeActor(other),
      scopeActor(scopeId("group", "C-deals")),
      "b@x.com",
    ])
      assert.match((await open(id)).message ?? "", /can't currently be confirmed as a member/, id);
    const elsewhere = await built.sessions.getOrCreateByThread(
      "slack:C-other:ambient:1",
      "channel",
      other,
      undefined,
      "slack",
    );
    assert.equal((await open(scopeActor(here), elsewhere)).ok, false);
    assert.equal((await withTenant(randomUUID(), () => open(scopeActor(here)))).ok, false);
    assert.equal((await built.sessions.childrenOf(session.id)).length, 1);
    const capability = (actorId: string, scope = here) =>
      built.app.authorizesCapabilityScope({ actorId, scopeId: scope, origin: "conversation" } as never);
    assert.deepEqual(
      await Promise.all([
        capability(scopeActor(here)),
        capability(scopeActor(here), other),
        capability(scopeActor(other)),
        capability("system:ambient:default-org"),
      ]),
      [true, false, false, false],
    );
  });
