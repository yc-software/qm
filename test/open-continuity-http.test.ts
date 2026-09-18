import "./support/auto-fake-sprites.ts";
import { test, mock, type TestContext } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { createMockHarness } from "../src/harness/mock-harness.ts";
import type { HarnessTurnInput } from "../src/harness/harness.ts";
import { mintCapabilityToken, type CapabilityClaims } from "../src/auth/capability-token.ts";
import { signedHeaders } from "../plugins/chassis/src/core-client.ts";
import { testConfig } from "./support/test-config.ts";

// Only the model and provider transport are synthetic. HTTP routing, capability
// verification, control service, scheduler, turn authorization and tools are real.
mock.module("../src/harness/mock-harness.ts", {
  namedExports: {
    createMockHarness: () => {
      const h = createMockHarness();
      const run = h.turns.runTurn;
      h.turns.runTurn = async (turn: HarnessTurnInput) => {
        const match = /!proof (\{[^\n]+\})/.exec(turn.input);
        if (!match) return run(turn);
        const command = JSON.parse(match[1]!) as { id: string; command: string };
        await turn.emit({ type: "user", payload: { text: turn.input }, scopeLabel: turn.scopeLabel });
        let reply: string;
        try {
          const out = await turn.tools.execute(command.command, { sandboxId: command.id });
          reply = out.stdout.trim() || out.stderr.trim();
        } catch (e) {
          reply = `DENIED: ${String(e)}`;
        }
        await turn.emit({ type: "assistant", payload: { text: reply }, scopeLabel: turn.scopeLabel });
        return { reply };
      };
      return h;
    },
  },
});
const { buildApp } = await import("../src/wiring.ts");
const { createServer } = await import("../src/api/server.ts");
const SECRET = "synthetic-continuity-http-signing-key";
const members = ["alice", "bob"].map((id) => ({ id, type: "internal" as const }));

async function fixture(t: TestContext) {
  const b = buildApp(testConfig({ signingSecret: SECRET, sandboxResourcesEnabled: true, memoryCapture: "off" }));
  await b.config.hydrate?.();
  await b.identity.hydrate();
  await b.deploymentLayerReady;
  await b.app.upsertDirectory(
    ["alice", "bob", "stranger"].map((principalId) => ({
      principalId,
      displayName: principalId,
      type: "internal" as const,
    })),
  );
  const roster = (ids: string[]) =>
    b.directory.replaceChannels(
      [{ channelId: "public-room", name: "public-room", isPrivate: false }],
      ids.map((principalId) => ({ channelId: "public-room", principalId })),
    );
  await roster(["alice", "bob"]);
  await b.config.setSharingPosture("org:default-org", "open");
  const server = createServer(b.app, {
    signingSecret: SECRET,
    scheduler: b.scheduler,
    config: b.config,
    admin: b.admin,
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  t.after(async () => {
    await new Promise<void>((r) => server.close(() => r()));
    b.scheduler.stop();
    b.deploymentLayerRefresh.stop();
    await b.runtime.stop();
  });
  const cap = (actorId: string, scopeId: CapabilityClaims["scopeId"] = "channel:public-room") =>
    mintCapabilityToken(
      {
        actorId,
        scopeId,
        members,
        liveActor: true,
        exp: Date.now() + 600_000,
        destination: { type: "slack", target: "public-room", audienceScopeId: "channel:public-room" },
      },
      SECRET,
    );
  const request = async (method: string, path: string, token: string, body?: unknown) => {
    const response = await fetch(base + path, {
      method,
      headers: { "x-agent-capability": token, "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return {
      status: response.status,
      body: (await response.json()) as { cron: { id: string; runAs?: string }; runs?: Array<{ status: string }> },
    };
  };
  const awaitFire = async (id: string, token: string) => {
    const deadline = Date.now() + 10000;
    while (Date.now() < deadline) {
      const response = await request("GET", `/v1/crons/${id}/runs`, token);
      assert.equal(response.status, 200, JSON.stringify(response.body));
      if (response.body.runs?.some((f) => f.status !== "running")) return response.body.runs;
      await new Promise((r) => setTimeout(r, 20));
    }
    assert.fail("HTTP scheduler fire did not finish within 10s");
  };
  const turn = async (text: string, actor = "alice", room = true) => {
    const body = JSON.stringify({
      surface: "test",
      actor: { externalId: actor },
      origin: { kind: "human" },
      conversation: room
        ? {
            kind: "channel",
            channelRef: "public-room",
            threadRef: `proof:${actor}`,
            audience: members.map((m) => ({ externalId: m.id })),
          }
        : { kind: "dm", threadRef: `proof-dm:${actor}` },
      text,
    });
    const response = await fetch(base + "/v1/turns", {
      method: "POST",
      headers: { ...signedHeaders(SECRET, "POST", "/v1/turns", body), "content-type": "application/json" },
      body,
    });
    return (await response.json()) as { status: string; reply?: string };
  };
  return { ...b, cap, request, turn, roster, awaitFire };
}

test("HTTP Open continuity: personal sandbox follows owner into shared channel and back, never another member", async (t) => {
  const b = await fixture(t);
  const resource = await b.sandboxResources.create("alice", "personal:alice", "sprites", "personal-proof");
  const command = (cmd: string) => `!proof ${JSON.stringify({ id: resource.id, command: cmd })}`;
  assert.equal(
    (await b.turn(command("printf continuity-sentinel > proof.txt; cat proof.txt"), "alice", false)).reply,
    "continuity-sentinel",
  );
  assert.equal((await b.turn(command("cat proof.txt"))).reply, "continuity-sentinel");
  assert.match((await b.turn(command("cat proof.txt"), "bob")).reply ?? "", /DENIED/);
  assert.match((await b.turn(command("cat proof.txt"), "stranger")).reply ?? "", /DENIED/);
  await b.config.setSharingPosture("personal:alice", "isolated");
  assert.match((await b.turn(command("cat proof.txt"))).reply ?? "", /DENIED/);
  assert.equal((await b.turn(command("cat proof.txt"), "alice", false)).reply, "continuity-sentinel");
  await b.config.clearSharingPosture("personal:alice");
  await b.roster(["bob"]);
  assert.match((await b.turn(command("cat proof.txt"))).reply ?? "", /DENIED/);
});

test("HTTP Open continuity: public channel permits explicit shared cron", async (t) => {
  const b = await fixture(t);
  const response = await b.request("POST", "/v1/crons", await b.cap("alice"), {
    title: "Shared proof",
    schedule: { everyMs: 3600000 },
    task: "hello",
    runAs: "scopeShared",
  });
  assert.equal(response.status, 200, JSON.stringify(response.body));
  assert.equal(response.body.cron.runAs, "scopeShared");
});

test("HTTP Open continuity: member edit keeps owner, notifies privately, fires with owner resources, and remains manageable in DM", async (t) => {
  const b = await fixture(t);
  const resource = await b.sandboxResources.create("alice", "personal:alice", "sprites", "cron-proof");
  const action = `!proof ${JSON.stringify({ id: resource.id, command: "printf cron-owner-resource" })}`;
  const owner = await b.cap("alice");
  const member = await b.cap("bob");
  const created = await b.request("POST", "/v1/crons", owner, {
    title: "Continuity proof",
    schedule: { everyMs: 3600000 },
    task: action,
  });
  assert.equal(created.status, 200, JSON.stringify(created.body));
  assert.equal(created.body.cron.runAs, "scopeShared", "Open shared cron defaults to owner-backed shared mode");
  const id = created.body.cron.id as string;
  const edit = await b.request("PATCH", `/v1/crons/${id}`, member, { title: "Member edited proof" });
  assert.equal(edit.status, 200, JSON.stringify(edit.body));
  assert.equal((await b.crons.get(id))?.owner, "alice");
  assert.equal((await b.crons.get(id))?.runAs, "scopeShared");
  const notices = await b.deliveries.pending("principal");
  assert.equal(notices.length, 1);
  assert.equal(notices[0]!.destination.target, "alice");
  assert.match(notices[0]!.text, /bob.*renamed/);
  assert.equal(
    (await b.request("PATCH", `/v1/crons/${id}`, await b.cap("stranger"), { title: "hijacked" })).status,
    403,
  );
  assert.equal((await b.request("PATCH", `/v1/crons/${id}`, member, { runAs: "owner" })).status, 403);
  const fired = await b.request("POST", `/v1/crons/${id}/run`, owner, {});
  assert.equal(fired.status, 200, JSON.stringify(fired.body));
  const log = await b.awaitFire(id, owner);
  assert.ok(log?.length, "HTTP scheduler created a fire log");
  assert.ok(
    (await b.deliveries.pending("slack")).some((d) => d.text.includes("cron-owner-resource")),
    JSON.stringify(log),
  );
  assert.equal(
    (await b.request("PATCH", `/v1/crons/${id}`, await b.cap("alice", "personal:alice"), { title: "Back in personal" }))
      .status,
    200,
  );
  assert.equal((await b.deliveries.pending("principal")).length, 1, "owner edits do not notify themselves");
  await b.roster(["alice"]);
  assert.equal((await b.request("PATCH", `/v1/crons/${id}`, member, { title: "revoked edit" })).status, 403);
});

test("HTTP Open shared cron isolates synthetic owner credential and revokes resource access", async (t) => {
  const b = await fixture(t);
  assert.ok(b.keychain);
  await b.keychain.save({
    ownerId: "alice",
    service: "continuity-synthetic",
    envKey: "CONTINUITY_PROOF_TOKEN",
    secret: "synthetic-owner-sentinel",
  });
  const owner = await b.cap("alice");
  const created = await b.request("POST", "/v1/crons", owner, {
    title: "Owner keychain proof",
    schedule: { everyMs: 3600000 },
    task: '!owner printf "%s" "$CONTINUITY_PROOF_TOKEN"',
  });
  assert.equal(created.status, 200, JSON.stringify(created.body));
  assert.equal(created.body.cron.runAs, "scopeShared");
  const id = created.body.cron.id;
  assert.equal((await b.request("POST", `/v1/crons/${id}/run`, owner, {})).status, 200);
  const log = await b.awaitFire(id, owner);
  assert.ok(
    (await b.deliveries.pending("slack")).some((d) => d.text.includes("synthetic-owner-sentinel")),
    JSON.stringify(log),
  );
  assert.equal(
    (await b.turn('!run printf "%s" "${CONTINUITY_PROOF_TOKEN-unset}"', "bob")).reply,
    "unset",
    "owner secret is not resident on the shared computer",
  );
  await b.roster(["bob"]);
  const result = await b.scheduler.runNow(id);
  if (result.started) await result.settled;
  assert.equal((await b.crons.get(id))?.enabled, false, "owner membership revocation disables the shared cron");
});

for (const isPrivate of [false, true]) {
  for (const veto of ["org:default-org", "personal:alice", "channel:public-room"]) {
    test(`HTTP Open cron opt-out stops owner credentials before materialization (${isPrivate ? "private" : "public"}, ${veto})`, async (t) => {
      const b = await fixture(t);
      assert.ok(b.keychain);
      await b.directory.replaceChannels(
        [{ channelId: "public-room", name: "public-room", isPrivate }],
        ["alice", "bob"].map((principalId) => ({ channelId: "public-room", principalId })),
      );
      await b.keychain.save({
        ownerId: "alice",
        service: "continuity-veto",
        envKey: "CONTINUITY_VETO_TOKEN",
        secret: "synthetic-veto-sentinel",
      });
      const response = await b.request("POST", "/v1/crons", await b.cap("alice"), {
        title: "Opt-out proof",
        schedule: { everyMs: 3600000 },
        task: '!owner printf "%s" "$CONTINUITY_VETO_TOKEN"',
      });
      assert.equal(response.status, 200, JSON.stringify(response.body));
      const id = response.body.cron.id;
      assert.equal((await b.crons.get(id))?.ownerResourcesRequireOpen, true);
      const initial = await b.scheduler.runNow(id);
      assert.equal(initial.started, true);
      if (initial.started) await initial.settled;
      assert.ok((await b.deliveries.pending("slack")).some((d) => d.text.includes("synthetic-veto-sentinel")));
      const original = b.keychain.materializeOwn.bind(b.keychain);
      let materializations = 0;
      b.keychain.materializeOwn = async (...args: Parameters<typeof original>) => {
        materializations++;
        return original(...args);
      };
      await b.config.setSharingPosture(veto, "isolated");
      const revoked = await b.scheduler.runNow(id);
      if (revoked.started) await revoked.settled;
      assert.equal(materializations, 0);
      assert.equal((await b.crons.get(id))?.enabled, false);
      assert.equal(
        (await b.deliveries.pending("slack")).filter((d) => d.text.includes("synthetic-veto-sentinel")).length,
        1,
      );
      assert.equal((await b.turn('!run printf "%s" "${CONTINUITY_VETO_TOKEN-unset}"', "bob")).reply, "unset");
    });
  }
}

test("HTTP legacy explicit private shared cron remains owner-authorized under isolated posture", async (t) => {
  const b = await fixture(t);
  assert.ok(b.keychain);
  await b.directory.replaceChannels(
    [{ channelId: "public-room", name: "private-room", isPrivate: true }],
    ["alice", "bob"].map((principalId) => ({ channelId: "public-room", principalId })),
  );
  await b.config.setSharingPosture("org:default-org", "isolated");
  await b.keychain.save({
    ownerId: "alice",
    service: "continuity-legacy",
    envKey: "CONTINUITY_LEGACY_TOKEN",
    secret: "synthetic-legacy-sentinel",
  });
  const cron = await b.crons.create({
    owner: "alice",
    createdBy: "alice",
    ownerScopeId: "channel:public-room",
    runAs: "scopeShared",
    members,
    schedule: { everyMs: 3600000 },
    action: '!owner printf "%s" "$CONTINUITY_LEGACY_TOKEN"',
    destination: { type: "slack", target: "public-room", audienceScopeId: "channel:public-room" },
  });
  assert.equal(cron.ownerResourcesRequireOpen, undefined);
  const fired = await b.scheduler.runNow(cron.id);
  assert.equal(fired.started, true);
  if (fired.started) await fired.settled;
  assert.ok((await b.deliveries.pending("slack")).some((d) => d.text.includes("synthetic-legacy-sentinel")));
  assert.equal((await b.turn('!run printf "%s" "${CONTINUITY_LEGACY_TOKEN-unset}"', "bob")).reply, "unset");
});
