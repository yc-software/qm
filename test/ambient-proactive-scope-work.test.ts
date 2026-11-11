import "./support/auto-fake-sprites.ts";

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import type { AddressInfo } from "node:net";
import type { Agent } from "../src/agent/agent.ts";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { verifyCapabilityToken, type CapabilityClaims } from "../src/auth/capability-token.ts";
import { createDeployService } from "../src/deploy/deploy-service.ts";
import { createDeployStore } from "../src/deploy/deploy-store.ts";
import { createCanReadScope, createCanWriteScope } from "../src/resolution/scope-membership.ts";
import { singleProcessDeps } from "./support/single-process.ts";
import { testDeployBackings } from "./support/test-database.ts";
import { canAdministerCron, canAdministerWebhook, createControlService } from "../src/api/control-service.ts";
import { canAdministerLoop } from "../src/api/loop-administration.ts";
import { createServer } from "../src/api/server.ts";
import { isSubagentThreadRef } from "../src/sessions/session-syscalls.ts";
import { serverDeps } from "../src/wiring.ts";
import { scopeActor, scopeId } from "../src/types.ts";
import { buildApp } from "./support/build-app.ts";
import { selectDefaultSandbox } from "./support/default-sandbox.ts";
import { createMockAgent } from "./support/mock-agent.ts";
import { runNowSettled, settle } from "./support/settle.ts";
import { TEST_CAPABILITY_SECRET, testConfig } from "./support/test-config.ts";

const policies = { partner: { companyDomains: ["acme.com"], companyTeamIds: ["TINTERNAL"], serviceCredentials: [] } };
const source = { account: "default", workspace: "TINTERNAL", assistant: "UBOT" };
const outcome = (p: Promise<unknown>): Promise<string> =>
  p.then(
    () => "ok",
    (e: Error) => `refused: ${e.message}`,
  );

test("unprompted channel work delegates and computes as the channel, but its minted claims manage nothing there", async (t) => {
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
    [{ channelId: "C-deals", name: "deals", isPrivate: true }],
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
    deployStore: createDeployStore(testDeployBackings({ git: { repoRoot: mkdtempSync(join(tmpdir(), "psw-repo-")) } })),
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

  await built.app.setChannelPolicy("C-deals", "!engage watch for memos", "U-admin");
  await built.app.ingestSurfaceEvents([
    { container: "C-deals", ts: "9.1", authorId: "U-A", authorName: "A", text: "memo?", createdAt: 1, source },
  ]);
  const parentRef = "slack:C-deals:ambient:9.1";
  let childRef: string | undefined;
  await settle(async () => {
    childRef = [...acted.keys()].find(isSubagentThreadRef);
    return acted.has(parentRef) && !!childRef && Object.keys(acted.get(childRef)!).includes("publish");
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
  const http = async (token: string, method: string, path: string) =>
    (
      await fetch(`${base}${path}`, {
        method,
        headers: { "x-agent-capability": token, "content-type": "application/json" },
        body: JSON.stringify(method === "PATCH" ? { title: "renamed" } : {}),
      })
    ).status;
  const markers = (c: CapabilityClaims) => [c.actorId, c.scopeId, c.triggered, c.liveActor, c.origin];
  const observed = {
    minted: { parent: markers(parent), child: markers(child), cronFire: markers(cronFire), person: markers(person) },
    worker: acted.get(parentRef),
    helper: acted.get(childRef!),
    parent: await manages(parent),
    child: await manages(child),
    legacy: await manages(legacy),
    cronFire: await manages(cronFire),
    person: await manages(person),
    http: {
      parentPatchesCron: await http(tokenByThread.get(parentRef)!, "PATCH", `/v1/crons/${cron.id}`),
      childDisablesCron: await http(tokenByThread.get(childRef!)!, "POST", `/v1/crons/${cron.id}/disable`),
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
    minted: {
      parent: [scopeActor(here), here, true, undefined, "conversation"],
      child: [scopeActor(here), here, true, undefined, "conversation"],
      cronFire: [scopeActor(here), here, true, undefined, "cron"],
      person: ["a@x.com", here, undefined, undefined, "conversation"],
    },
    worker: { execute: "ok", open: "ok", create: "ok", ...refused },
    helper: { execute: "ok", create: "ok", ...refused },
    parent: none,
    child: none,
    legacy: { ...today, privateChannelGate: false },
    cronFire: { ...today, privateChannelGate: false },
    person: today,
    http: { parentPatchesCron: 403, childDisablesCron: 403, parentDisablesWebhook: 403 },
  });
});
