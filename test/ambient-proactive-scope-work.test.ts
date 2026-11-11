import "./support/auto-fake-sprites.ts";

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { withTenant } from "../src/tenants/context.ts";
import type { AddressInfo } from "node:net";
import type { Agent } from "../src/agent/agent.ts";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  mintCapabilityToken,
  unpromptedRefusal,
  verifyCapabilityToken,
  type CapabilityClaims,
} from "../src/auth/capability-token.ts";
import { createDeployService } from "../src/deploy/deploy-service.ts";
import { createDeployStore } from "../src/deploy/deploy-store.ts";
import { createCanReadScope, createCanWriteScope } from "../src/resolution/scope-membership.ts";
import { singleProcessDeps } from "./support/single-process.ts";
import { testDeployBackings } from "./support/test-database.ts";
import { canAdministerCron, canAdministerWebhook, createControlService } from "../src/api/control-service.ts";
import { canAdministerLoop } from "../src/api/loop-administration.ts";
import { createServer } from "../src/api/server.ts";
import { isSubagentThreadRef, UNPROMPTED_REACH_REFUSAL } from "../src/sessions/session-syscalls.ts";
import { serverDeps } from "../src/wiring.ts";
import { scopeActor, scopeId } from "../src/types.ts";
import { buildApp } from "./support/build-app.ts";
import { selectDefaultSandbox } from "./support/default-sandbox.ts";
import { createMockAgent } from "./support/mock-agent.ts";
import { runNowSettled, settle } from "./support/settle.ts";
import { TEST_CAPABILITY_SECRET, testConfig } from "./support/test-config.ts";

const policies = { partner: { companyDomains: ["acme.com"], companyTeamIds: ["TINTERNAL"], serviceCredentials: [] } };
const source = { account: "default", workspace: "TINTERNAL", assistant: "UBOT" };
const notMember = (channel: string) =>
  `can't currently be confirmed as a member of channel:${channel}, so helpers can't run here; nothing was started or sent.`;
const schedulesRefusal = unpromptedRefusal("schedules");
const loopsRefusal = unpromptedRefusal("loops");
const manageRefusal = (what: string) =>
  `unprompted work can't manage this conversation's ${what}s; ask in the conversation so a person does it`;
const outcome = (p: Promise<unknown>): Promise<string> =>
  p.then(
    () => "ok",
    (e: Error) => `refused: ${e.message}`,
  );

for (const wake of ["message", "scheduled"] as const)
  test(`an unprompted ${wake} wake delegates and computes as the channel, but its minted claims manage nothing there`, async (t) => {
    const config = testConfig({
      externalSlackPolicies: policies,
      signingSecret: "proactive-scope-work".repeat(3),
      apiBaseUrl: "http://core.internal",
    });
    const mock = createMockAgent();
    const claimsByThread = new Map<string, CapabilityClaims>();
    const tokens = new Map<string, string>();
    const tokenByThread = new Map<string, string>();
    const acted = new Map<string, Record<string, string>>();
    const agent: Agent = {
      ...mock,
      async runTurn(turn) {
        const threadRef = turn.session.threadRef;
        const tag = `mint-${randomUUID()}`;
        const minted = await turn.tools.execute(`echo ${tag}`);
        const claims = await verifyCapabilityToken(tokens.get(tag) ?? "", TEST_CAPABILITY_SECRET);
        if (claims && !claimsByThread.has(threadRef)) {
          claimsByThread.set(threadRef, claims);
          tokenByThread.set(threadRef, tokens.get(tag)!);
        }
        const worker = threadRef.startsWith("slack:C-deals:ambient:") || isSubagentThreadRef(threadRef);
        if (worker && !acted.has(threadRef)) {
          const done: Record<string, string> = {};
          acted.set(threadRef, done);
          done.execute = minted.code === 0 && minted.stdout.includes(tag) ? "ok" : `refused: exit ${minted.code}`;
          if (!isSubagentThreadRef(threadRef)) {
            const opened = await turn.tools.sessionSyscalls!.open({ task: "look up the memo; read only" });
            done.open = opened.ok ? "ok" : `refused: ${opened.message}`;
          }
          let created: { id?: string } | undefined;
          done.create = await outcome(
            turn.tools.sandboxResources!("create", { backend: "sprites", name: "lookup" }).then((r) => {
              created = r as { id?: string };
            }),
          );
          if (created?.id) {
            done.default = await outcome(turn.tools.sandboxResources!("default", { sandboxId: created.id }));
            done.retire = await outcome(turn.tools.sandboxResources!("retire", { sandboxId: created.id }));
          }
          await turn.tools.execute("mkdir -p site && echo 'require(\"http\")' > site/server.js");
          done.publish = await outcome(
            turn.tools.publish({ dir: "site", entrypoint: "node server.js", name: "deal-notes" }),
          );
          return { reply: "done", modelCalls: 1 };
        }
        return mock.runTurn(turn);
      },
    };
    const built = buildApp(config, { agent });
    const realRun = built.sandbox.run.bind(built.sandbox);
    built.sandbox.run = (handle, command, opts) => {
      const tag = /^echo (mint-\S+)$/.exec(command)?.[1];
      if (tag && handle.env?.AGENT_API_TOKEN) tokens.set(tag, handle.env.AGENT_API_TOKEN);
      return realRun(handle, command, opts);
    };
    built.runtime.start();
    t.after(() => built.runtime.stop());
    const server = createServer(built.app, serverDeps(config, built));
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    t.after(() => server.close());
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const here = scopeId("channel", "C-deals");
    await built.directory.replace([{ principalId: "a@x.com", displayName: "A", type: "internal", slackId: "U-A" }]);
    await built.directory.replaceChannels(
      ["C-deals", "C-other"].map((channelId) => ({ channelId, name: channelId, isPrivate: true })),
      [{ channelId: "C-deals", principalId: "a@x.com" }],
    );
    await selectDefaultSandbox(built, "a@x.com", here);

    const cron = await built.app.createCron({
      ownerScopeId: here,
      owner: scopeActor(here),
      createdBy: "a@x.com",
      ownerConsentedAt: Date.now(),
      schedule: { everyMs: 3_600_000 },
      action: "post the deal notes",
    });
    const webhook = await built.app.createWebhook({
      ownerScopeId: here,
      owner: scopeActor(here),
      createdBy: "a@x.com",
      ownerConsentedAt: Date.now(),
      action: "handle the deal event",
      verification: { scheme: "hmac-sha256", secret: "webhook-secret" },
    });
    const loop = { owner: scopeActor(here), ownerScopeId: here };
    const deploy = createDeployService({
      ...singleProcessDeps(),
      deployStore: createDeployStore(
        testDeployBackings({ git: { repoRoot: mkdtempSync(join(tmpdir(), "psw-repo-")) } }),
      ),
      provider: {
        profile: { managedScaleToZero: false },
        apply: async () => ({ host: "127.0.0.1", port: 19998 }),
        destroy: async () => {},
      },
      auditLog: { record() {}, events: async () => [], tail: async () => [] },
      acl: built.acl,
      deployDir: mkdtempSync(join(tmpdir(), "psw-deploy-")),
      canReadScope: createCanReadScope({ directory: built.directory }),
      canWriteScope: createCanWriteScope({ directory: built.directory }),
    });
    const appFile = [{ path: "server.js", data: "console.log('deal board')" }];
    const deployment = await deploy.deploy({
      ownerScopeId: here,
      createdBy: scopeActor(here),
      createdInScope: here,
      name: "deal-board",
      entrypoint: "node server.js",
      files: appFile,
    });

    await built.app.setChannelPolicy("C-deals", `${wake === "message" ? "!engage " : ""}watch for memos`, "U-admin");
    await built.app.ingestSurfaceEvents([
      { container: "C-deals", ts: "9.1", authorId: "U-A", authorName: "A", text: "memo?", createdAt: 1, source },
    ]);
    if (wake === "scheduled") {
      await settle(async () => (await built.ambientJudgments!.list({ container: "C-deals" })).length > 0);
      await built.app.setChannelPolicy("C-deals", "!engage watch for memos", "U-admin");
      await built.app.judgeAmbientContainer("slack", "C-deals", { reason: "scheduled" });
    }
    let parentRef = "";
    let childRef: string | undefined;
    await settle(async () => {
      parentRef = [...acted.keys()].find((ref) => !isSubagentThreadRef(ref)) ?? "";
      childRef = [...acted.keys()].find(isSubagentThreadRef);
      return !!parentRef && !!childRef && Object.keys(acted.get(childRef)!).includes("publish");
    });
    const run = (await built.runs.list()).find((r) => r.sessionId === parentRef)!;
    const session = (await built.sessions.getByThread(parentRef))!;
    const elsewhere = await built.sessions.getOrCreateByThread(
      "slack:C-other:ambient:1",
      "channel",
      scopeId("channel", "C-other"),
      undefined,
      "slack",
    );
    const openAs = (id: string, s = session) =>
      built.sessionSyscalls
        .forTurn({
          session: s,
          scopeId: s.scopeId,
          request: { ...run.request, runId: run.id, actor: { id, type: "internal" } },
        })
        .open({ task: "look up the memo; read only" })
        .then(
          (r) => (r.ok ? "ok" : (r.message ?? "refused")),
          (e: Error) => e.message,
        );
    const [childRun] = await built.runs.list({ threadRef: childRef! });
    let parentWake: Awaited<ReturnType<typeof built.runs.list>>[number] | undefined;
    await settle(async () => {
      parentWake = (await built.runs.list({ threadRef: parentRef })).find((r) => r.id !== run.id);
      return parentWake?.status === "done";
    });
    const parent = claimsByThread.get(parentRef)!;
    const child = claimsByThread.get(childRef!)!;

    await runNowSettled(built.scheduler, cron.id);
    const fireRef = (await built.crons.listFires(cron.id)).runs.at(-1)!.threadRef;
    await settle(async () => claimsByThread.has(fireRef));
    const cronFire = claimsByThread.get(fireRef)!;
    const a = { externalId: "a@x.com" };
    const personResult = await built.app.turn({
      surface: "test",
      actor: a,
      conversation: {
        kind: "channel",
        threadRef: "ch:C-deals:1.1",
        channelRef: "C-deals",
        audience: [a],
        publishMembers: [a],
      },
      text: "hello",
    });
    const person = claimsByThread.get("ch:C-deals:1.1")!;
    assert.equal(personResult.status, "ok");

    const legacy = { ...parent };
    delete legacy.triggered;
    delete legacy.liveActor;
    delete legacy.origin;
    delete legacy.unprompted;

    const control = createControlService(built.app, built.scheduler);
    const manages = async (c: CapabilityClaims) => ({
      cronAdmin: await canAdministerCron(built.app, cron, c),
      webhookAdmin: await canAdministerWebhook(built.app, webhook, c),
      loopAdmin: await canAdministerLoop(built.app, loop, c),
      shareCron: (await control.shareArtifact({ type: "cron", id: cron.id, recipient: "a@x.com" }, c)).ok,
      listsCron: (await control.listCrons(c)).crons.some((x) => x.id === cron.id),
      listsWebhook: (await control.listWebhooks(c)).some((x) => x.id === webhook.id),
      managesApp: await deploy.canManageDeployment(deployment.id, c, c.scopeId),
      redeploysApp:
        (await outcome(
          deploy.deployOrUpdate({
            ownerScopeId: here,
            createdBy: c.actorId,
            scopeId: c.scopeId,
            triggered: c.triggered,
            liveActor: c.liveActor,
            origin: c.origin,
            createdInScope: here,
            name: "deal-board",
            entrypoint: "node server.js",
            files: appFile,
          }),
        )) === "ok",
      privateChannelGate: await built.app.authorizesCapabilityScope(c),
    });
    const http = async (token: string, method: string, path: string, payload?: object) => {
      const res = await fetch(`${base}${path}`, {
        method,
        headers: { "x-agent-capability": token, "content-type": "application/json" },
        ...(method === "GET"
          ? {}
          : { body: JSON.stringify(payload ?? (method === "PATCH" ? { title: "renamed" } : {})) }),
      });
      const body = (await res.json().catch(() => ({}))) as { message?: string; crons?: Array<{ id: string }> };
      return method === "GET"
        ? [res.status, body.crons?.some((c) => c.id === cron.id) ?? null]
        : [res.status, body.message ?? null];
    };
    const legacyToken = await mintCapabilityToken(legacy, TEST_CAPABILITY_SECRET);
    const markers = (c: CapabilityClaims) => [c.actorId, c.scopeId, c.triggered, c.liveActor, c.origin, c.unprompted];
    const observed = {
      othersOpen: [
        await openAs("system:ambient:default-org"),
        await openAs(scopeActor(scopeId("channel", "C-other"))),
        await openAs(scopeActor(scopeId("group", "C-deals"))),
        await openAs("b@x.com"),
        await openAs(scopeActor(here), elsewhere),
        await withTenant(randomUUID(), () => openAs(scopeActor(here))),
      ],
      delegation: {
        children: (await built.sessions.childrenOf(session.id)).length,
        childDone: (await built.runs.waitFor(childRun!.id, 30_000)).status,
        parentWakeDone: parentWake?.status,
        origins: [run, childRun!, parentWake!].map((r) => r.request.surfaceOrigin),
        crossScopeGate: [
          await built.app.authorizesCapabilityScope({ ...parent, scopeId: scopeId("channel", "C-other") }),
          await built.app.authorizesCapabilityScope({ ...parent, actorId: scopeActor(scopeId("channel", "C-other")) }),
        ],
      },
      minted: { parent: markers(parent), child: markers(child), cronFire: markers(cronFire), person: markers(person) },
      worker: acted.get(parentRef),
      helper: acted.get(childRef!),
      parent: await manages(parent),
      child: await manages(child),
      legacy: await manages(legacy),
      cronFire: await manages(cronFire),
      person: await manages(person),
      http: {
        parentListsCrons: await http(tokenByThread.get(parentRef)!, "GET", "/v1/crons"),
        childListsCrons: await http(tokenByThread.get(childRef!)!, "GET", "/v1/crons"),
        legacyListsCrons: await http(legacyToken, "GET", "/v1/crons"),
        parentPatchesCron: await http(tokenByThread.get(parentRef)!, "PATCH", `/v1/crons/${cron.id}`),
        childDisablesCron: await http(tokenByThread.get(childRef!)!, "POST", `/v1/crons/${cron.id}/disable`),
        childCreatesCron: await http(tokenByThread.get(childRef!)!, "POST", "/v1/crons", {
          schedule: { everyMs: 3_600_000 },
          action: "post the deal notes",
        }),
        parentCreatesLoop: await http(tokenByThread.get(parentRef)!, "POST", "/v1/loops"),
        parentDisablesWebhook: await http(tokenByThread.get(parentRef)!, "POST", `/v1/webhooks/${webhook.id}/disable`),
      },
    };
    const none = {
      cronAdmin: false,
      webhookAdmin: false,
      loopAdmin: false,
      shareCron: false,
      listsCron: false,
      listsWebhook: false,
      managesApp: false,
      redeploysApp: false,
      privateChannelGate: true,
    };
    const today = { ...none, ...Object.fromEntries(Object.keys(none).map((k) => [k, true])) };
    const refused = {
      default: "refused: unprompted work can't change this conversation's default computer",
      retire: "refused: unprompted work can't retire this conversation's computers",
      publish: "refused: unprompted work can't publish a new app; ask in the conversation so a person publishes it",
    };
    assert.deepEqual(observed, {
      othersOpen: [
        ...["system:ambient:default-org", "system:channel:C-other", "system:group:C-deals", "b@x.com"].map(
          (id) => `${id} ${notMember("C-deals")}`,
        ),
        `system:channel:C-deals ${notMember("C-other")}`,
        "this delegated task was stopped",
      ],
      delegation: {
        children: 1,
        childDone: "done",
        parentWakeDone: "done",
        origins: Array(3).fill({ ...run.request.surfaceOrigin, audience: "internal" }),
        crossScopeGate: [false, false],
      },
      minted: {
        parent: [scopeActor(here), here, true, undefined, "conversation", true],
        child: [scopeActor(here), here, true, undefined, "conversation", true],
        cronFire: [scopeActor(here), here, true, undefined, "cron", undefined],
        person: ["a@x.com", here, undefined, undefined, "conversation", undefined],
      },
      worker: { execute: "ok", open: "ok", create: "ok", ...refused },
      helper: { execute: "ok", create: "ok", ...refused },
      parent: none,
      child: none,
      legacy: { ...today, privateChannelGate: false },
      cronFire: { ...today, privateChannelGate: false },
      person: today,
      http: {
        parentListsCrons: [200, false],
        childListsCrons: [200, false],
        legacyListsCrons: [403, null],
        parentPatchesCron: [403, manageRefusal("cron")],
        childDisablesCron: [403, manageRefusal("cron")],
        parentDisablesWebhook: [403, manageRefusal("webhook")],
        childCreatesCron: [403, schedulesRefusal],
        parentCreatesLoop: [403, loopsRefusal],
      },
    });
  });

for (const [label, overrides] of [
  ["no public API URL", { signingSecret: "test-ingress-signing-key-with-enough-length", apiBaseUrl: undefined }],
  ["no token configuration", { signingSecret: undefined, apiBaseUrl: undefined }],
] as const)
  test(`unprompted work is refused management with ${label}`, async (t) => {
    const mock = createMockAgent();
    const acted: Record<string, string> = {};
    const agent: Agent = {
      ...mock,
      async runTurn(turn) {
        if (!turn.session.threadRef.startsWith("slack:C-deals:ambient:") || acted.create) return mock.runTurn(turn);
        let id = "";
        acted.create = await outcome(
          turn.tools.sandboxResources!("create", { backend: "sprites", name: "lookup" }).then((r) => {
            id = (r as { id: string }).id;
          }),
        );
        acted.default = await outcome(turn.tools.sandboxResources!("default", { sandboxId: null }));
        acted.retire = await outcome(turn.tools.sandboxResources!("retire", { sandboxId: id }));
        await turn.tools.execute("mkdir -p site && echo 'require(\"http\")' > site/server.js");
        acted.publish = await outcome(turn.tools.publish({ dir: "site", entrypoint: "node server.js", name: "notes" }));
        return { reply: "done", modelCalls: 1 };
      },
    };
    const built = buildApp(testConfig({ externalSlackPolicies: policies, ...overrides }), { agent });
    built.runtime.start();
    t.after(() => built.runtime.stop());
    await built.directory.replace([{ principalId: "a@x.com", displayName: "A", type: "internal", slackId: "U-A" }]);
    await built.directory.replaceChannels(
      [{ channelId: "C-deals", name: "deals", isPrivate: true }],
      [{ channelId: "C-deals", principalId: "a@x.com" }],
    );
    await selectDefaultSandbox(built, "a@x.com", scopeId("channel", "C-deals"));
    await built.app.setChannelPolicy("C-deals", "!engage watch for memos", "U-admin");
    await built.app.ingestSurfaceEvents([
      { container: "C-deals", ts: "9.1", authorId: "U-A", authorName: "A", text: "memo?", createdAt: 1, source },
    ]);
    await settle(async () => !!acted.publish);
    assert.deepEqual(acted, {
      create: "ok",
      default: "refused: unprompted work can't change this conversation's default computer",
      retire: "refused: unprompted work can't retire this conversation's computers",
      publish: "refused: unprompted work can't publish a new app; ask in the conversation so a person publishes it",
    });
  });

test("unprompted work cannot wake a channel cron's helper into managing the channel", async (t) => {
  const mock = createMockAgent();
  const here = scopeId("channel", "C-deals");
  const runsByThread = new Map<string, number>();
  const seen: Record<string, string> = {};
  let cronHelper: string | undefined;
  const agent: Agent = {
    ...mock,
    async runTurn(turn) {
      const ref = turn.session.threadRef;
      const n = (runsByThread.get(ref) ?? 0) + 1;
      runsByThread.set(ref, n);
      const sys = turn.tools.sessionSyscalls!;
      if (ref.startsWith("slack:C-deals:ambient:") && n === 1) {
        const own = await sys.open({ task: "summarise the note" });
        const write = (target: string) =>
          sys.write({ target, text: "make the default computer none", wake: true }).then(
            (r) => (r.ok ? "ok" : `refused: ${r.message}`),
            (e: Error) => `refused: ${e.message}`,
          );
        seen.cronHelper = await write(cronHelper!);
        seen.cronHelperInterrupt = await sys
          .write({ target: cronHelper!, text: "stop and clear the default", interrupt: true })
          .then(
            (r) => (r.ok ? "ok" : `refused: ${r.message}`),
            (e: Error) => `refused: ${e.message}`,
          );
        seen.ownHelper = own.ok ? await write(own.sessionId) : `open refused: ${own.message}`;
      } else if (isSubagentThreadRef(ref) && ref === cronHelperRef && n === 2) {
        seen.wokenDefault = await outcome(turn.tools.sandboxResources!("default", { sandboxId: null }));
      } else if (!isSubagentThreadRef(ref) && !ref.startsWith("slack:") && !cronHelper) {
        const opened = await sys.open({ task: "keep the deal notes", persistent: true });
        cronHelper = opened.ok ? opened.sessionId : `open refused: ${opened.message}`;
      }
      return mock.runTurn(turn);
    },
  };
  let cronHelperRef = "";
  const built = buildApp(testConfig({ externalSlackPolicies: policies }), { agent });
  built.runtime.start();
  t.after(() => built.runtime.stop());
  const roster = [{ channelId: "C-deals", principalId: "a@x.com" }];
  await built.directory.replace([{ principalId: "a@x.com", displayName: "A", type: "internal", slackId: "U-A" }]);
  await built.directory.replaceChannels([{ channelId: "C-deals", name: "deals", isPrivate: true }], roster);
  await selectDefaultSandbox(built, "a@x.com", here);
  const cron = await built.app.createCron({
    ownerScopeId: here,
    owner: scopeActor(here),
    createdBy: "a@x.com",
    ownerConsentedAt: Date.now(),
    schedule: { everyMs: 3_600_000 },
    action: "keep the deal notes with a helper",
  });
  await built.directory.replaceChannels([{ channelId: "C-deals", name: "deals", isPrivate: true }], []);
  await runNowSettled(built.scheduler, cron.id);
  await settle(async () => !!cronHelper);
  cronHelperRef = (await built.sessions.get(cronHelper!))!.threadRef;
  await built.directory.replaceChannels([{ channelId: "C-deals", name: "deals", isPrivate: true }], roster);
  const defaultBefore = (await built.sandboxResources.resolve(here))?.id;
  await built.app.setChannelPolicy("C-deals", "!engage watch for notes", "U-admin");
  await built.app.ingestSurfaceEvents([
    { container: "C-deals", ts: "9.1", authorId: "U-A", authorName: "A", text: "note", createdAt: 1, source },
  ]);
  await settle(async () => !!seen.ownHelper);
  await settle(async () => (await built.runs.list({ threadRef: cronHelperRef })).every((r) => r.status === "done"));
  assert.deepEqual(
    {
      ...seen,
      cronHelperRuns: runsByThread.get(cronHelperRef),
      defaultAfter: (await built.sandboxResources.resolve(here))?.id,
    },
    {
      cronHelper: `refused: ${UNPROMPTED_REACH_REFUSAL}`,
      cronHelperInterrupt: `refused: ${UNPROMPTED_REACH_REFUSAL}`,
      ownHelper: "ok",
      cronHelperRuns: 1,
      defaultAfter: defaultBefore,
    },
  );
});
