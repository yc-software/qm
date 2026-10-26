import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type BuiltApp } from "../src/wiring.ts";
import { buildApp } from "./support/build-app.ts";
import { createServer } from "../src/api/server.ts";
import { createApp, type AppDeps } from "../src/api/app.ts";
import { createDeliveryStore } from "../src/delivery/delivery-store.ts";
import { createDirectoryStore } from "../src/directory/directory-store.ts";
import { createMemorySessionStore } from "../src/sessions/memory-session-store.ts";
import { scopeId } from "../src/types.ts";
import { mintCapabilityToken, CAPABILITY_TTL_MS, type CapabilityClaims } from "../src/auth/capability-token.ts";
import { createControlService, type ControlService } from "../src/api/control-service.ts";
import { testConfig } from "./support/test-config.ts";

const SECRET = "dm-relay-secret".repeat(3);

describe("agent → teammate DM: cron recipients and the reach route (§10)", () => {
  let server: Server;
  let base: string;
  let built: BuiltApp;

  const capDm = async (actorId: string) =>
    await mintCapabilityToken(
      { actorId, scopeId: scopeId("personal", actorId), exp: Date.now() + CAPABILITY_TTL_MS },
      SECRET,
    );
  const capGroup = async (actorId: string, groupId: string) =>
    await mintCapabilityToken(
      { actorId, scopeId: scopeId("group", groupId), exp: Date.now() + CAPABILITY_TTL_MS },
      SECRET,
    );

  const post = (path: string, body: unknown, headers: Record<string, string> = {}) =>
    fetch(`${base}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify(body),
    });

  before(async () => {
    built = buildApp(
      testConfig({
        dataDir: mkdtempSync(join(tmpdir(), "dm-relay-")),
        signingSecret: SECRET,
      }),
    );
    await built.app.upsertDirectory([
      { principalId: "U-alice", displayName: "Alice", type: "internal" },
      { principalId: "U-carol", displayName: "Carol", type: "internal" },
      { principalId: "U-sam1", displayName: "Sam Lee", type: "internal" },
      { principalId: "U-sam2", displayName: "Sam Park", type: "internal" },
    ]);
    await built.app.upsertChannels(
      [
        { channelId: "C", name: "current" },
        { channelId: "C-eng", name: "eng" },
        { channelId: "C-d1", name: "design-frontend" },
        { channelId: "C-d2", name: "design-backend" },
        { channelId: "C-secret", name: "secret", isPrivate: true },
      ],
      [
        { channelId: "C", principalId: "U-carol" },
        { channelId: "C-secret", principalId: "U-carol" },
      ],
    );
    await built.app.upsertGroups([
      { groupId: "G-jrs", principalId: "U-carol" },
      { groupId: "G-jrs", principalId: "U-alice" },
      { groupId: "G-jrs", principalId: "U-sam1" },
    ]);
    server = createServer(built.app, { signingSecret: SECRET });
    await new Promise<void>((resolve) => server.listen(0, resolve));
    base = `http://localhost:${(server.address() as AddressInfo).port}`;
  });

  after(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  const claimsDm = (actorId: string): CapabilityClaims => ({
    actorId,
    scopeId: scopeId("personal", actorId),
    exp: Date.now() + CAPABILITY_TTL_MS,
  });
  const claimsChannel = (actorId: string): CapabilityClaims => ({
    actorId,
    scopeId: scopeId("channel", "C"),
    exp: Date.now() + CAPABILITY_TTL_MS,
  });
  const createCron = (input: Parameters<ControlService["createCron"]>[0], claims: CapabilityClaims) =>
    createControlService(built.app).createCron(input, claims);
  const failure = (result: Awaited<ReturnType<typeof createCron>>) => {
    assert.equal(result.ok, false);
    return result.ok ? assert.fail("expected a refusal") : result;
  };

  it("builds a core-resolved principal destination the agent never authored", async () => {
    const result = await createCron(
      { schedule: { firstFireAt: Date.now() }, action: "let Alice know the deploy is done", recipient: "Alice" },
      claimsDm("U-carol"),
    );
    assert.ok(result.ok);
    const { cron } = result;
    assert.equal(cron.destination?.type, "principal");
    assert.equal(cron.destination?.target, "U-alice");
    assert.equal(cron.destination?.onBehalfOf, "U-carol");
    assert.equal(cron.destination?.audienceScopeId, "personal:U-alice");
    assert.equal(cron.owner, "U-carol");
  });

  it("sends a verbatim message and echoes the resolved recipient (findings #1 + #2)", async () => {
    const result = await createCron(
      { schedule: { firstFireAt: Date.now() + 3_600_000 }, text: "ship it 🚀", recipient: "Alice" },
      claimsDm("U-carol"),
    );
    assert.ok(result.ok);
    assert.equal(result.cron.message, "ship it 🚀");
    assert.equal(result.cron.action, undefined);
    assert.equal(result.cron.destination?.type, "principal");
    assert.equal(result.recipient?.principalId, "U-alice");
    assert.equal(result.recipient?.displayName, "Alice");
  });

  it("messages a teammate from a channel scope, reading the channel (§10 parity gate)", async () => {
    const result = await createCron(
      { schedule: { firstFireAt: Date.now() }, text: "ping", recipient: "Alice" },
      claimsChannel("U-carol"),
    );
    assert.ok(result.ok);
    const { cron } = result;
    assert.equal(cron.destination?.type, "principal");
    assert.equal(cron.destination?.target, "U-alice");
    assert.equal(cron.destination?.onBehalfOf, "U-carol");
    assert.equal(cron.ownerScopeId, "channel:C");
  });

  it("creates a channel cron that runs at the channel scope (named from a DM)", async () => {
    const result = await createCron(
      { schedule: { cron: "0 9 * * *", timezone: "America/Los_Angeles" }, action: "post the standup", channel: "eng" },
      claimsDm("U-carol"),
    );
    assert.ok(result.ok);
    const { cron } = result;
    assert.equal(cron.ownerScopeId, "channel:C-eng");
    assert.equal(cron.destination?.type, "slack");
    assert.equal(cron.destination?.target, "C-eng");
    assert.equal(cron.destination?.audienceScopeId, "channel:C-eng");
    assert.equal(cron.owner, "U-carol");
    assert.equal(result.channel?.channelId, "C-eng");
    assert.equal(result.channel?.name, "eng");
  });

  it("refuses an unknown channel and returns candidates for an ambiguous one", async () => {
    const miss = failure(
      await createCron({ schedule: { firstFireAt: Date.now() }, action: "x", channel: "nope" }, claimsDm("U-carol")),
    );
    assert.equal(miss.code, "channel_not_found");
    const amb = failure(
      await createCron({ schedule: { firstFireAt: Date.now() }, action: "x", channel: "design" }, claimsDm("U-carol")),
    );
    assert.equal(amb.code, "ambiguous_channel");
    assert.equal(amb.candidates?.length, 2);
  });

  it("authorizes a private-channel send by membership: member → ok, non-member → refused", async () => {
    const ok = await createCron(
      { schedule: { firstFireAt: Date.now() }, action: "x", channel: "secret" },
      claimsDm("U-carol"),
    );
    assert.ok(ok.ok);
    assert.equal(ok.cron.ownerScopeId, "channel:C-secret");
    assert.equal(ok.channel?.channelId, "C-secret");

    const denied = failure(
      await createCron({ schedule: { firstFireAt: Date.now() }, action: "x", channel: "secret" }, claimsDm("U-alice")),
    );
    assert.equal(denied.code, "not_a_member");
  });

  it("rejects specifying both a recipient and a channel", async () => {
    const result = failure(
      await createCron(
        { schedule: { firstFireAt: Date.now() }, action: "x", recipient: "Alice", channel: "eng" },
        claimsDm("U-carol"),
      ),
    );
    assert.equal(result.code, "bad_request");
  });

  it("creates a group-DM cron addressed by participant set, running at the group scope (§10)", async () => {
    const result = await createCron(
      {
        schedule: { cron: "0 9 * * *", timezone: "America/Los_Angeles" },
        text: "standup in 5",
        participants: ["U-alice", "U-sam1"],
      },
      claimsDm("U-carol"),
    );
    assert.ok(result.ok);
    const { cron } = result;
    assert.equal(cron.ownerScopeId, "group:G-jrs");
    assert.equal(cron.destination?.type, "group");
    assert.equal(cron.destination?.target, "G-jrs");
    assert.equal(cron.destination?.audienceScopeId, "group:G-jrs");
    assert.equal(cron.owner, "U-carol");
    assert.equal(cron.message, "standup in 5");
    assert.equal(result.group?.groupId, "G-jrs");
  });

  it("resolves the participant set order- and duplicate-insensitively, incl. the sender named explicitly", async () => {
    const result = await createCron(
      { schedule: { firstFireAt: Date.now() }, text: "hi", participants: ["U-sam1", "U-carol", "U-alice"] },
      claimsDm("U-carol"),
    );
    assert.ok(result.ok);
    assert.equal(result.cron.destination?.target, "G-jrs");
  });

  it("refuses when no group DM has exactly those participants", async () => {
    const result = failure(
      await createCron(
        { schedule: { firstFireAt: Date.now() }, text: "hi", participants: ["U-alice", "U-sam2"] },
        claimsDm("U-carol"),
      ),
    );
    assert.equal(result.code, "group_not_found");
  });

  it("refuses a group DM the sender isn't a member of (human parity)", async () => {
    const result = failure(
      await createCron(
        { schedule: { firstFireAt: Date.now() }, text: "hi", participants: ["U-carol", "U-alice"] },
        claimsDm("U-sam2"),
      ),
    );
    assert.equal(result.code, "group_not_found");
  });

  it("rejects specifying participants together with a recipient or channel", async () => {
    const r1 = failure(
      await createCron(
        { schedule: { firstFireAt: Date.now() }, text: "x", participants: ["U-alice"], recipient: "Alice" },
        claimsDm("U-carol"),
      ),
    );
    assert.equal(r1.code, "bad_request");
    const r2 = failure(
      await createCron(
        { schedule: { firstFireAt: Date.now() }, text: "x", participants: ["U-alice"], channel: "eng" },
        claimsDm("U-carol"),
      ),
    );
    assert.equal(r2.code, "bad_request");
  });

  it("POST /v1/reach sends a teammate DM immediately and creates NO cron row", async () => {
    const before = await built.app.listCrons();
    const res = await post(
      "/v1/reach",
      { text: "ship it 🚀", recipient: "Alice" },
      { "x-agent-capability": await capDm("U-carol") },
    );
    assert.equal(res.status, 200);
    const body = (await res.json()) as any;
    assert.ok(body.deliveryId, "returns the enqueued delivery id");
    assert.equal(body.recipient.principalId, "U-alice");
    assert.equal(body.recipient.displayName, "Alice");
    assert.equal((await built.app.listCrons()).length, before.length);
    const pending = await built.app.pendingDeliveries("principal");
    const d = pending.find((x) => x.id === body.deliveryId);
    assert.ok(d, "delivery is in the principal queue");
    assert.equal(d!.text, "ship it 🚀");
    assert.equal(d!.destination.relaySender, "Carol");
    assert.equal(d!.destination.onBehalfOf, "U-carol");
  });

  it("POST /v1/reach posts the EXACT text to a public channel immediately (from a personal scope — not withheld)", async () => {
    const res = await post(
      "/v1/reach",
      { text: "heads up team", channel: "eng", unfurlLinks: false },
      { "x-agent-capability": await capDm("U-carol") },
    );
    assert.equal(res.status, 200);
    const body = (await res.json()) as any;
    assert.equal(body.channel.channelId, "C-eng");
    const d = (await built.app.pendingDeliveries("slack")).find((x) => x.id === body.deliveryId);
    assert.ok(d, "delivery is in the channel queue");
    assert.equal(d!.text, "heads up team");
    assert.equal(d!.destination.unfurlLinks, false);
  });

  it("POST /v1/reach posts to a group DM immediately, floored to the group (§10)", async () => {
    const res = await post(
      "/v1/reach",
      { text: "heads up", participants: ["U-alice", "U-sam1"] },
      { "x-agent-capability": await capGroup("U-carol", "G-jrs") },
    );
    assert.equal(res.status, 200);
    const body = (await res.json()) as any;
    assert.equal(body.group.groupId, "G-jrs");
    const pending = await built.app.pendingDeliveries("group");
    const d = pending.find((x) => x.id === body.deliveryId);
    assert.ok(d, "delivery is in the group queue");
    assert.equal(d!.text, "heads up");
    assert.equal(d!.destination.relaySender, "Carol");
    assert.equal(d!.destination.type, "group");
    assert.equal(d!.destination.target, "G-jrs");
  });

  it("POST /v1/reach mirrors the cron resolution errors (404 / 409 / 403)", async () => {
    const miss = await post(
      "/v1/reach",
      { text: "x", recipient: "Nobody McMissing" },
      { "x-agent-capability": await capDm("U-carol") },
    );
    assert.equal(miss.status, 404);
    const amb = await post(
      "/v1/reach",
      { text: "x", recipient: "Sam" },
      { "x-agent-capability": await capDm("U-carol") },
    );
    assert.equal(amb.status, 409);
    assert.equal(((await amb.json()) as any).candidates.length, 2);
    const priv = await post(
      "/v1/reach",
      { text: "x", channel: "secret" },
      { "x-agent-capability": await capDm("U-alice") },
    );
    assert.equal(priv.status, 403);
  });

  it("POST /v1/reach requires text and a named target", async () => {
    const noText = await post("/v1/reach", { recipient: "Alice" }, { "x-agent-capability": await capDm("U-carol") });
    assert.equal(noText.status, 400);
    const noTarget = await post("/v1/reach", { text: "hi" }, { "x-agent-capability": await capDm("U-carol") });
    assert.equal(noTarget.status, 400);
  });
});

describe("agent → teammate DM: delivery events in the recipient's session (anti-amnesia, §10)", () => {
  it("records a recipient delivery event without appending a normal assistant turn", async () => {
    const deliveries = createDeliveryStore();
    const sessions = createMemorySessionStore();
    const directory = createDirectoryStore();
    await directory.replace([{ principalId: "U-carol", displayName: "Carol", type: "internal" }]);
    const app = createApp({ deliveries, sessions, directory } as unknown as AppDeps);

    const d = await deliveries.enqueue({
      destination: {
        type: "principal",
        target: "U-alice",
        audienceScopeId: scopeId("personal", "U-alice"),
        onBehalfOf: "U-carol",
      },
      text: "the deploy is done",
      idempotencyKey: "k1",
      provenance: {
        trigger: "cron",
        surface: "cron",
        fireKey: "cron:c1:slot",
        sourceScopeId: scopeId("personal", "U-carol"),
        sourceThreadRef: "cron:c1:slot",
        sourceSessionId: "source-session",
        sourceUserSeq: 0,
        sourceAssistantEntrySeq: 1,
      },
    });

    await app.recordPrincipalDelivery(d.id, "dm:D-alice");

    const session = await sessions.getByThread("dm:D-alice");
    assert.ok(session, "recipient DM session created");
    assert.equal(session!.surface, "slack");
    const entries = await sessions.getEntries(session!.id);
    assert.equal(
      entries.some((e) => e.type === "assistant"),
      false,
      "principal delivery is not fake chat history",
    );
    const events = await deliveries.listByRecipientThread("dm:D-alice");
    assert.equal(events.length, 1);
    assert.equal(events[0]!.text, "the deploy is done");
    assert.equal(events[0]!.destination.onBehalfOf, "U-carol");
    assert.equal(events[0]!.recipientThreadRef, "dm:D-alice");
    assert.equal(events[0]!.provenance?.fireKey, "cron:c1:slot");
    assert.equal(events[0]!.provenance?.sourceUserSeq, 0);
    assert.equal(events[0]!.provenance?.sourceAssistantEntrySeq, 1);
  });

  it("is a no-op for a non-principal delivery", async () => {
    const deliveries = createDeliveryStore();
    const sessions = createMemorySessionStore();
    const directory = createDirectoryStore();
    const app = createApp({ deliveries, sessions, directory } as unknown as AppDeps);
    const d = await deliveries.enqueue({
      destination: { type: "slack", target: "C1" },
      text: "hi channel",
      idempotencyKey: "k2",
    });
    await app.recordPrincipalDelivery(d.id, "dm:D-alice");
    assert.equal(await sessions.getByThread("dm:D-alice"), null);
  });
});
