import "./support/auto-fake-sprites.ts";
import { test, mock, type TestContext } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { randomUUID } from "node:crypto";
import { createMockHarness } from "./support/mock-harness.ts";
import type { HarnessTurnInput } from "../src/harness/harness.ts";
import type { CapabilityClaims } from "../src/auth/capability-token.ts";
import { createControlService } from "../src/api/control-service.ts";
import { signedHeaders } from "../plugins/chassis/src/core-client.ts";
import { credentialHandle } from "../src/credentials/keychain.ts";
import { testConfig } from "./support/test-config.ts";

mock.module("./support/mock-harness.ts", {
  namedExports: {
    createMockHarness: () => {
      const h = createMockHarness();
      const run = h.turns.runTurn;
      h.turns.runTurn = async (turn: HarnessTurnInput) => {
        const match = /!proof (\{[^\n]+\})/.exec(turn.input);
        if (!match) return run(turn);
        const command = JSON.parse(match[1]!) as {
          id?: string;
          ownerAuth?: boolean;
          command: string;
          credentials?: string[];
        };
        await turn.emit({ type: "user", payload: { text: turn.input }, scopeLabel: turn.scopeLabel });
        let reply: string;
        try {
          const out = await turn.tools.execute(command.command, {
            ...(command.id ? { sandboxId: command.id } : {}),
            ...(command.ownerAuth ? { ownerAuth: true } : {}),
            ...(command.credentials ? { credentials: command.credentials } : {}),
          });
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
const { buildApp } = await import("./support/build-app.ts");
const { createServer } = await import("../src/api/server.ts");
const SECRET = "synthetic-continuity-http-signing-key";
const members = ["alice", "bob"].map((id) => ({ id, type: "internal" as const }));

async function fixture(t: TestContext) {
  const b = buildApp(testConfig({ signingSecret: SECRET, memoryCapture: "off" }));
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
  const sharedSandbox = await b.sandboxResources.create("alice", "channel:public-room", "sprites", "shared-proof");
  await b.sandboxResources.setDefault("alice", "channel:public-room", sharedSandbox.id);
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
  const control = createControlService(b.app, b.scheduler, b.admin);
  const cap = (actorId: string, scopeId: CapabilityClaims["scopeId"] = "channel:public-room"): CapabilityClaims => ({
    actorId,
    scopeId,
    members,
    liveActor: true,
    exp: Date.now() + 600_000,
    destination: { type: "slack", target: "public-room", audienceScopeId: "channel:public-room" },
  });
  const createCron = async (claims: CapabilityClaims, title: string, task: string) => {
    const created = await control.createCron({ title, schedule: { everyMs: 3600000 }, action: task }, claims);
    assert.ok(created.ok, JSON.stringify(created));
    return created.cron.id;
  };
  const awaitFire = async (id: string, claims: CapabilityClaims) => {
    const deadline = Date.now() + 10000;
    while (Date.now() < deadline) {
      const response = await control.getCronRuns(id, {}, claims);
      assert.ok(response.ok, JSON.stringify(response));
      if (response.runs.some((f) => f.status !== "running")) return response.runs;
      await new Promise((r) => setTimeout(r, 20));
    }
    assert.fail("scheduler fire did not finish within 10s");
  };
  const turn = async (
    text: string,
    actor = "alice",
    room = true,
    audience: { externalId: string; isExternalGuest?: boolean }[] = members.map((m) => ({ externalId: m.id })),
  ) => {
    const body = JSON.stringify({
      surface: "test",
      idempotencyKey: randomUUID(),
      actor: { externalId: actor },
      origin: { kind: "human" },
      conversation: room
        ? {
            kind: "channel",
            channelRef: "public-room",
            threadRef: `proof:${actor}`,
            audience,
            publishMembers: audience,
          }
        : { kind: "dm", threadRef: `proof-dm:${actor}` },
      text,
    });
    const response = await fetch(base + "/v1/turns", {
      method: "POST",
      headers: { ...signedHeaders(SECRET, "POST", "/v1/turns", body), "content-type": "application/json" },
      body,
    });
    const result = (await response.json()) as { status: string; reply?: string; reason?: string };
    return { ...result, http: response.status };
  };
  return { ...b, control, cap, createCron, turn, roster, awaitFire };
}

test("HTTP Open continuity: personal sandbox follows owner into shared channel and back, never another member", async (t) => {
  const b = await fixture(t);
  const resource = await b.sandboxResources.create("alice", "personal:alice", "sprites", "personal-proof");
  const command = (cmd: string) => `!proof ${JSON.stringify({ id: resource.id, command: cmd })}`;
  const first = await b.turn(command("printf continuity-sentinel > proof.txt; cat proof.txt"), "alice", false);
  assert.equal(first.http, 200, JSON.stringify(first));
  assert.equal(first.reply, "continuity-sentinel");
  assert.equal((await b.turn(command("cat proof.txt"))).reply, "continuity-sentinel");
  assert.match((await b.turn(command("cat proof.txt"), "bob")).reply ?? "", /DENIED/);
  assert.match((await b.turn(command("cat proof.txt"), "stranger")).reply ?? "", /DENIED/);
  await b.config.setSharingPosture("personal:alice", "isolated");
  assert.match((await b.turn(command("cat proof.txt"))).reply ?? "", /DENIED/);
  assert.equal((await b.turn(command("cat proof.txt"), "alice", false)).reply, "continuity-sentinel");
  await b.config.clearSharingPosture("personal:alice");
  await b.roster(["bob"]);
  assert.equal((await b.turn(command("cat proof.txt"))).reply, "continuity-sentinel");
  const guests = [{ externalId: "alice" }, { externalId: "guest", isExternalGuest: true }];
  const refused = await b.turn(command("cat proof.txt"), "alice", true, guests);
  assert.equal(refused.http, 403);
  assert.equal(refused.status, "refused");
  assert.equal(refused.reply, undefined);
});

test("HTTP Open continuity: only the owner or a write grantee edits; grantee edits keep the owner, notify privately, and fire with owner resources", async (t) => {
  const b = await fixture(t);
  const resource = await b.sandboxResources.create("alice", "personal:alice", "sprites", "cron-proof");
  const action = `!proof ${JSON.stringify({ id: resource.id, command: "printf cron-owner-resource" })}`;
  const owner = b.cap("alice");
  const member = b.cap("bob");
  const id = await b.createCron(owner, "Continuity proof", action);
  const unshared = await b.control.patchCron(id, { title: "Unshared edit" }, member);
  assert.equal(unshared.ok ? "" : unshared.code, "forbidden");
  const shared = await b.control.shareArtifact({ type: "cron", id, scope: "personal:bob", permission: "write" }, owner);
  assert.ok(shared.ok, JSON.stringify(shared));
  const edit = await b.control.patchCron(id, { title: "Member edited proof" }, member);
  assert.ok(edit.ok, JSON.stringify(edit));
  assert.equal((await b.crons.get(id))?.owner, "alice");
  const notices = await b.deliveries.pending("principal");
  assert.equal(notices.length, 1);
  assert.equal(notices[0]!.destination.target, "alice");
  assert.match(notices[0]!.text, /bob.*renamed/);
  const hijack = await b.control.patchCron(id, { title: "hijacked" }, b.cap("stranger"));
  assert.equal(hijack.ok ? "" : hijack.code, "forbidden");
  const fired = await b.control.runCron(id, owner);
  assert.ok(fired.ok, JSON.stringify(fired));
  const log = await b.awaitFire(id, owner);
  assert.ok(log?.length, "the scheduler created a fire log");
  assert.ok(
    (await b.deliveries.pending("slack")).some((d) => d.text.includes("cron-owner-resource")),
    JSON.stringify(log),
  );
  assert.ok((await b.control.patchCron(id, { title: "Back in personal" }, b.cap("alice", "personal:alice"))).ok);
  assert.equal((await b.deliveries.pending("principal")).length, 1, "owner edits do not notify themselves");
});

test("HTTP Open shared cron isolates synthetic owner credential and revokes resource access", async (t) => {
  const b = await fixture(t);
  assert.ok(b.keychain);
  const credential = await b.keychain.save({
    ownerId: "alice",
    service: "continuity-synthetic",
    envKey: "CONTINUITY_PROOF_TOKEN",
    secret: "synthetic-owner-sentinel",
  });
  const owner = b.cap("alice");
  const id = await b.createCron(
    owner,
    "Owner keychain proof",
    `!proof ${JSON.stringify({ ownerAuth: true, credentials: [credentialHandle(credential)], command: 'test "$CONTINUITY_PROOF_TOKEN" = "synthetic-owner-sentinel" && printf owner-credential-present' })}`,
  );
  assert.ok((await b.control.runCron(id, owner)).ok);
  const log = await b.awaitFire(id, owner);
  assert.ok(
    (await b.deliveries.pending("slack")).some((d) => d.text.includes("owner-credential-present")),
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
  assert.equal(
    (await b.deliveries.pending("slack")).filter((d) => d.text.includes("owner-credential-present")).length,
    1,
    "once the owner leaves, the public-channel cron no longer gets their keychain",
  );
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
      const credential = await b.keychain.save({
        ownerId: "alice",
        service: "continuity-veto",
        envKey: "CONTINUITY_VETO_TOKEN",
        secret: "synthetic-veto-sentinel",
      });
      const id = await b.createCron(
        b.cap("alice"),
        "Opt-out proof",
        `!proof ${JSON.stringify({ ownerAuth: true, credentials: [credentialHandle(credential)], command: 'test "$CONTINUITY_VETO_TOKEN" = "synthetic-veto-sentinel" && printf veto-credential-present' })}`,
      );
      const initial = await b.scheduler.runNow(id);
      assert.equal(initial.started, true);
      if (initial.started) await initial.settled;
      assert.ok((await b.deliveries.pending("slack")).some((d) => d.text.includes("veto-credential-present")));
      const original = b.keychain.materializeOwnById.bind(b.keychain);
      let materializations = 0;
      b.keychain.materializeOwnById = async (...args: Parameters<typeof original>) => {
        materializations++;
        return original(...args);
      };
      await b.config.setSharingPosture(veto, "isolated");
      const revoked = await b.scheduler.runNow(id);
      if (revoked.started) await revoked.settled;
      assert.equal(materializations, 0);
      assert.equal(
        (await b.deliveries.pending("slack")).filter((d) => d.text.includes("veto-credential-present")).length,
        1,
      );
      assert.equal((await b.turn('!run printf "%s" "${CONTINUITY_VETO_TOKEN-unset}"', "bob")).reply, "unset");
    });
  }
}

test("HTTP private channel cron runs without its owner's keychain once the conversation isn't Open", async (t) => {
  const b = await fixture(t);
  assert.ok(b.keychain);
  await b.directory.replaceChannels(
    [{ channelId: "public-room", name: "private-room", isPrivate: true }],
    ["alice", "bob"].map((principalId) => ({ channelId: "public-room", principalId })),
  );
  await b.config.setSharingPosture("org:default-org", "isolated");
  const credential = await b.keychain.save({
    ownerId: "alice",
    service: "continuity-isolated",
    envKey: "CONTINUITY_ISOLATED_TOKEN",
    secret: "synthetic-isolated-sentinel",
  });
  const cron = await b.crons.create({
    owner: "alice",
    createdBy: "alice",
    ownerScopeId: "channel:public-room",
    schedule: { everyMs: 3600000 },
    action: `!proof ${JSON.stringify({ ownerAuth: true, credentials: [credentialHandle(credential)], command: 'test "$CONTINUITY_ISOLATED_TOKEN" = "synthetic-isolated-sentinel" && printf isolated-credential-present' })}`,
    destination: { type: "slack", target: "public-room", audienceScopeId: "channel:public-room" },
  });
  const fired = await b.scheduler.runNow(cron.id);
  assert.equal(fired.started, true);
  if (fired.started) await fired.settled;
  const { runs } = await b.crons.listFires(cron.id);
  assert.equal(runs.at(-1)?.status, "ok", "the fire still runs");
  assert.ok(!(await b.deliveries.pending("slack")).some((d) => d.text.includes("isolated-credential-present")));
  assert.equal((await b.crons.get(cron.id))?.enabled, true);
});
