import "./support/auto-fake-sprites.ts";
import { test } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { buildApp } from "./support/build-app.ts";
import { testConfig } from "./support/test-config.ts";
import { selectDefaultSandbox } from "./support/default-sandbox.ts";
import { createServer } from "../src/api/server.ts";
import { serverDeps } from "../src/wiring.ts";
import { orgId } from "../src/config.ts";
import type { Agent } from "../src/agent/agent.ts";
import { slackSurfaceOrigin } from "../src/surfaces/slack/adapter.ts";
import { proactiveScopeDelegation, type ScopeDelegationRequest } from "../src/resolution/scope-membership.ts";
import type { SessionSyscallBinding, SessionSyscalls } from "../src/sessions/session-syscalls.ts";
import { scopeId, type Principal, type TurnRequest } from "../src/types.ts";

const ambient = `system:ambient:${orgId()}`;
const channel = "CDEALS";
const scope = scopeId("channel", channel);
const internalSource = slackSurfaceOrigin({ accountId: "default", teamId: "TYC", userId: "UQM" });

function proactiveWake(threadRef: string): TurnRequest {
  return {
    surface: "slack",
    surfaceOrigin: internalSource,
    actor: { externalId: ambient },
    conversation: { kind: "channel", threadRef, channelRef: channel, audience: [] },
    deliveryTarget: channel,
    text: "a deal was mentioned",
    origin: { kind: "automation", screenData: "{}" },
    surfaceTools: true,
    async: true,
    spawned: true,
  };
}

test("an unprompted wake in a private Slack channel opens a helper that executes and returns to its parent", async (t) => {
  const seen: Array<{ role: "parent" | "helper"; input: string; delegates: boolean }> = [];
  const returned: string[] = [];
  let opened: Awaited<ReturnType<SessionSyscalls["open"]>> | undefined;
  let token = "";
  const agent: Agent = {
    async runTurn(turn) {
      const helper = !!turn.session.parentSessionId;
      seen.push({ role: helper ? "helper" : "parent", input: turn.input, delegates: !!turn.delegateWork });
      if (helper) await turn.tools.execute("true");
      else if (!opened) opened = await turn.tools.sessionSyscalls!.open({ task: "look up the memo" });
      else returned.push(...(await turn.tools.sessionSyscalls!.receive!(0)).map((m) => m.text));
      return { reply: helper ? "memo found" : "done", modelCalls: 1 };
    },
  };
  const config = testConfig({ workers: 1, signingSecret: "ambient-helper".repeat(3), apiBaseUrl: "http://core.test" });
  const built = buildApp(config, { agent });
  const provision = built.sandbox.provision.bind(built.sandbox);
  built.sandbox.provision = (owner, opts) => {
    token = opts?.env?.AGENT_API_TOKEN ?? token;
    return provision(owner, opts);
  };
  await built.directory.replaceChannels(
    [{ channelId: channel, name: "deals", isPrivate: true }],
    [{ channelId: channel, principalId: "U1" }],
  );
  await selectDefaultSandbox(built, ambient, scope);
  const server = createServer(built.app, serverDeps(config, built));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  built.runtime.start();

  const queued = await built.app.turn(proactiveWake(`slack:${channel}:ambient:1`));
  await built.runs.waitFor(queued.runId!, 60_000);
  assert.ok(opened?.ok, opened && !opened.ok ? opened.message : "the parent never opened a helper");
  const parent = await built.sessions.getByThread(`slack:${channel}:ambient:1`);
  for (let i = 0; i < 1200 && !returned.length; i++) await new Promise((r) => setTimeout(r, 50));
  assert.deepEqual(
    seen.map((s) => [s.role, s.delegates]),
    [
      ["parent", true],
      ["helper", false],
      ["parent", true],
    ],
    "the Slack parent delegates without execute; its helper executes; the result wakes the parent",
  );
  assert.match(returned.join("\n"), /memo found/, "the helper's result reached its parent");
  const child = await built.sessions.get(opened.sessionId);
  assert.equal(child?.parentSessionId, parent?.id);
  assert.equal(child?.scopeId, scope);
  assert.deepEqual(child?.spawnMeta?.surfaceOrigin, internalSource);

  assert.ok(token, "the helper's execute minted a self-API token");
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const api = (path: string, body: unknown) =>
    fetch(base + path, {
      method: "POST",
      headers: { "x-agent-capability": token, "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  assert.equal((await api("/v1/crons", { schedule: { everyMs: 3_600_000 }, task: "watch deals" })).status, 403);
  assert.equal((await api("/v1/share", { type: "session", id: child!.id, toScope: "org" })).status, 403);
});

test("only a verified internal Slack wake by this org's ambient actor, in its own channel, may delegate", () => {
  const base: ScopeDelegationRequest = {
    surface: "slack",
    surfaceOrigin: internalSource,
    actor: { id: ambient, type: "internal" },
    conversation: { kind: "channel", threadRef: `slack:${channel}:ambient:2`, channelRef: channel, audience: [] },
    origin: { kind: "automation", screenData: "{}" },
  };
  const external = slackSurfaceOrigin({
    accountId: "partner",
    teamId: "TP",
    userId: "UQM",
    external: { companyDomains: ["ycombinator.com"], companyTeamIds: ["TYC"], serviceCredentials: [] },
  });
  const allowed = (request: Partial<ScopeDelegationRequest>, target = scope, policies = {}) =>
    proactiveScopeDelegation({ ...base, ...request }, target, policies);
  assert.equal(allowed({}), true);
  assert.equal(allowed({}, scopeId("channel", "COTHER")), false, "wrong channel");
  assert.equal(allowed({ actor: { id: "system:ambient:other-org", type: "internal" } }), false, "other org");
  assert.equal(allowed({ actor: { id: "U1", type: "internal" } }), false, "a person");
  assert.equal(allowed({ surfaceOrigin: undefined }), false, "missing provenance");
  assert.equal(allowed({ surfaceOrigin: external }), false, "external provenance");
  assert.equal(
    allowed({}, scope, {
      default: { companyDomains: ["ycombinator.com"], companyTeamIds: [], serviceCredentials: [] },
    }),
    false,
    "an account bound to an external policy",
  );
  assert.equal(allowed({ surfaceOrigin: { ...internalSource, workspace: "" } }), false, "no workspace binding");
  assert.equal(allowed({ surface: "web" }), false, "not a Slack source");
  assert.equal(allowed({ origin: { kind: "human" } }), false, "human origin");
  assert.equal(allowed({ origin: { kind: "automation", ownerFire: true } }), false, "owner fire");
  assert.equal(allowed({ origin: undefined }), false, "no origin");
  assert.equal(allowed({ botActor: true }), false, "bot-triggered wake");
  assert.equal(
    allowed({ conversation: { kind: "dm", threadRef: "slack:dm:x", channelRef: channel, audience: [] } }, scope),
    false,
    "dm",
  );
});

test("an ambient helper caller is refused in another channel and for sessions it does not take part in", async () => {
  const built = buildApp(testConfig({ openaiApiKey: "sk-test" }));
  const actor: Principal = { id: ambient, type: "internal" };
  const caller = async (request: Partial<SessionSyscallBinding["request"]>, sessionScope = scope) => {
    const room = await built.sessions.getOrCreateByThread(
      `slack:${channel}:ambient:${Math.random()}`,
      "channel",
      sessionScope,
      undefined,
      "slack",
    );
    await built.sessions.addParticipant(room.id, actor.id);
    return built.sessionSyscalls.forTurn({
      session: room,
      scopeId: sessionScope,
      request: {
        surface: "slack",
        surfaceOrigin: internalSource,
        conversation: { kind: "channel", threadRef: room.threadRef, channelRef: channel, audience: [actor] },
        actor,
        origin: { kind: "automation" },
        ...request,
      },
    });
  };
  const refusal = /can't currently be confirmed as a member/;
  const cases: Array<[string, Partial<SessionSyscallBinding["request"]>, string?]> = [
    ["wrong channel", {}, scopeId("channel", "COTHER")],
    ["missing provenance", { surfaceOrigin: undefined }],
    ["human origin", { origin: { kind: "human" } }],
    ["owner fire", { origin: { kind: "automation", ownerFire: true } }],
    ["other org", { actor: { id: "system:ambient:other-org", type: "internal" } }],
  ];
  for (const [label, request, target] of cases) {
    const out = await (await caller(request, target)).open({ task: "look up the memo" });
    assert.equal(out.ok, false, label);
    assert.match(out.ok ? "" : out.message, refusal, label);
  }
  const ok = await caller({});
  assert.equal((await ok.open({ task: "look up the memo" })).ok, true);
  const someoneElses = await built.sessions.getOrCreateByThread(
    "slack:CDEALS:u1",
    "channel",
    scope,
    undefined,
    "slack",
  );
  await built.sessions.addParticipant(someoneElses.id, "U1");
  const sent = await ok.write({ target: someoneElses.id, text: "hi" });
  assert.deepEqual(sent, { ok: false, message: "you are not a participant in that session." });
});
