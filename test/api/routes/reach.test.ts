import { it, before, after } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { createServer } from "../../../src/api/server.ts";
import { buildTestApp } from "../../support/test-app.ts";
import { scopeId } from "../../../src/types.ts";
import { mintCapabilityToken, CAPABILITY_TTL_MS, type CapabilityClaims } from "../../../src/auth/capability-token.ts";
import { createControlService, type ControlService } from "../../../src/api/control-service.ts";
import { testConfig } from "../../support/test-config.ts";
import { testDatabaseUrl } from "../../support/test-database.ts";
import { createPostgresReplayDedupe } from "../../../src/auth/replay-dedupe.ts";

const SECRET = "dm-relay-secret".repeat(3);

let server: Server;
let base: string;
let built: ReturnType<typeof buildTestApp>;

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
  built = buildTestApp(testConfig({ signingSecret: SECRET }));
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
  server = createServer(built.app, {
    replayDedupe: createPostgresReplayDedupe(testDatabaseUrl()),
    signingSecret: SECRET,
  });
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
    {
      schedule: { firstFireAt: Date.now() + 3_600_000 },
      action: "let Alice know the deploy is done",
      recipient: "Alice",
    },
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
    { schedule: { firstFireAt: Date.now() + 3_600_000 }, text: "ping", recipient: "Alice" },
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
    await createCron(
      { schedule: { firstFireAt: Date.now() + 3_600_000 }, action: "x", channel: "nope" },
      claimsDm("U-carol"),
    ),
  );
  assert.equal(miss.code, "channel_not_found");
  const amb = failure(
    await createCron(
      { schedule: { firstFireAt: Date.now() + 3_600_000 }, action: "x", channel: "design" },
      claimsDm("U-carol"),
    ),
  );
  assert.equal(amb.code, "ambiguous_channel");
  assert.equal(amb.candidates?.length, 2);
});

it("authorizes a private-channel send by membership: member → ok, non-member → refused", async () => {
  const ok = await createCron(
    { schedule: { firstFireAt: Date.now() + 3_600_000 }, action: "x", channel: "secret" },
    claimsDm("U-carol"),
  );
  assert.ok(ok.ok);
  assert.equal(ok.cron.ownerScopeId, "channel:C-secret");
  assert.equal(ok.channel?.channelId, "C-secret");

  const denied = failure(
    await createCron(
      { schedule: { firstFireAt: Date.now() + 3_600_000 }, action: "x", channel: "secret" },
      claimsDm("U-alice"),
    ),
  );
  assert.equal(denied.code, "not_a_member");
});

it("rejects specifying both a recipient and a channel", async () => {
  const result = failure(
    await createCron(
      { schedule: { firstFireAt: Date.now() + 3_600_000 }, action: "x", recipient: "Alice", channel: "eng" },
      claimsDm("U-carol"),
    ),
  );
  assert.equal(result.code, "bad_request");
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
  assert.equal(body.recipient.principalId, "U-alice");
  assert.equal(body.recipient.displayName, "Alice");
  assert.equal((await built.app.listCrons()).length, before.length);
  const d = (await built.posts.pending("principal")).at(-1);
  assert.ok(d, "posted to the principal surface");
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
  const d = (await built.posts.pending("slack")).at(-1);
  assert.ok(d, "posted to the channel");
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
  const d = (await built.posts.pending("group")).at(-1);
  assert.ok(d, "posted to the group DM");
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
