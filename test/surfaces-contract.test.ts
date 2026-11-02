import { test } from "node:test";
import assert from "node:assert/strict";
import { createDeliveryStore } from "../src/delivery/delivery-store.ts";
import type { SlackIdentityMode, SlackUser } from "../src/slack/identity.ts";
import { externalSlackNamespace } from "../src/slack/external-access.ts";
import { createDeliveryPoller } from "../src/slack/deliveries.ts";
import { createSurfaceRegistry } from "../src/surfaces/registry.ts";
import { createSlackSurface } from "../src/surfaces/slack/adapter.ts";
import type { DeliveryProvenance } from "../src/types.ts";

const slackSurface = () => createSlackSurface({ deliveries: createDeliveryStore() });

const provenance = (sourceThreadRef: string): DeliveryProvenance => ({
  trigger: "cron",
  surface: "slack",
  fireKey: "fire-1",
  sourceScopeId: "scope-1",
  sourceThreadRef,
});

test("surface registry rejects duplicate kinds", () => {
  assert.throws(() => createSurfaceRegistry({ surfaces: [slackSurface(), slackSurface()] }), /unique: slack/);
});

test("slack adapter principals carry the classified slack identity", () => {
  const ada: SlackUser = {
    id: "U1",
    team_id: "T1",
    real_name: "Ada",
    profile: { display_name: "ada", email: " Ada@Example.com " },
  };
  const guest: SlackUser = { id: "U2", team_id: "T1", is_restricted: true, profile: { email: "guest@example.com" } };
  const bot: SlackUser = { id: "B1", team_id: "T1", is_bot: true, real_name: "Helper Bot" };
  const noEmail: SlackUser = { id: "U6", team_id: "T1" };
  const cases: [SlackIdentityMode, SlackUser | undefined, object][] = [
    ["slack-id", ada, { externalId: "U1", isExternalGuest: false, displayName: "ada" }],
    ["email", ada, { externalId: "ada@example.com", isExternalGuest: false, displayName: "ada" }],
    ["slack-id", guest, { externalId: "U2", isExternalGuest: true, displayName: "U2" }],
    ["email", guest, { externalId: "guest@example.com", isExternalGuest: true, displayName: "U2" }],
    ["email", bot, { externalId: "B1", isExternalGuest: false, isBot: true, displayName: "Helper Bot" }],
    ["slack-id", noEmail, { externalId: "U6", isExternalGuest: false, displayName: "U6" }],
    ["email", noEmail, { externalId: "U6", isExternalGuest: true, displayName: "U6" }],
    ["email", undefined, { externalId: "", isExternalGuest: true }],
  ];
  const surface = slackSurface();
  for (const [identityMode, user, expected] of cases) {
    const surfaceUser = surface.native("slack")!.userFrom(user, { id: "default", ownTeamId: "T1", identityMode });
    assert.deepEqual(surface.principalFor(surfaceUser), expected, `${identityMode} ${user?.id}`);
  }
  const adaUser = surface.native("slack")!.userFrom(ada, { id: "default", ownTeamId: "T1", identityMode: "email" });
  assert.equal(surface.mention(adaUser), "<@U1>");
});

test("slack adapter post enqueues provenance, attachments and account routing", async () => {
  const deliveries = createDeliveryStore();
  const surface = createSlackSurface({ deliveries });
  const attachments = [{ name: "a.txt", mimetype: "text/plain", sizeBytes: 1, blobId: "blob-1" }];
  await surface.post(
    {
      surface: "slack",
      account: "partner",
      workspace: "T1",
      policyNamespace: "ns",
      kind: "channel",
      container: "C1",
      thread: "1700.0001",
    },
    { text: "in thread", attachments, provenance: provenance("ns:C1") },
    "k1",
  );
  const [queued] = await deliveries.pending("slack");
  assert.deepEqual(queued?.destination, {
    type: "slack",
    target: "C1:1700.0001",
    account: { id: "partner", workspace: "T1", policyNamespace: "ns" },
  });
  assert.equal(queued?.text, "in thread");
  assert.deepEqual(queued?.attachments, attachments);
  assert.deepEqual(queued?.provenance, provenance("ns:C1"));
  await assert.rejects(
    surface.post(
      { surface: "slack", account: "default", kind: "dm", container: "D1" },
      { text: "x", provenance: provenance("dm:D1") },
      "run:r1",
    ),
    /reserved idempotency key/,
  );
});

test("slack drainer delivers adapter posts under an external policy namespace only in their workspace", async () => {
  const policy = { companyDomains: ["company.example"], companyTeamIds: ["TCOMPANY"], serviceCredentials: [] };
  const namespace = externalSlackNamespace("TPARTNER", policy);
  const deliveries = createDeliveryStore();
  const surface = createSlackSurface({ deliveries });
  const ref = { surface: "slack", account: "partner", policyNamespace: namespace, kind: "channel" as const };
  await surface.post(
    { ...ref, workspace: "TPARTNER", container: "CSHARED" },
    { text: "Synthetic channel update", provenance: provenance(`${namespace}:CSHARED`) },
    "k-ok",
  );
  await surface.post(
    { ...ref, workspace: "TOTHER", container: "CSHARED" },
    { text: "Synthetic wrong workspace", provenance: provenance(`${namespace}:CSHARED`) },
    "k-team",
  );
  await surface.post(
    { ...ref, workspace: "TPARTNER", container: "COTHER" },
    { text: "Synthetic unnamespaced", provenance: provenance("ch:COTHER") },
    "k-drop",
  );
  const queued = await deliveries.pending("slack");
  const byKey = new Map(queued.map((d) => [d.idempotencyKey, d.id]));
  const posts: { channel: string }[] = [];
  const acks: string[] = [];
  let pending = true;
  const client = {
    conversations: { history: async () => ({ messages: [] }) },
    chat: {
      postMessage: async (args: { channel: string }) => {
        posts.push(args);
        return { ts: "3" };
      },
    },
  };
  const poller = createDeliveryPoller({
    core: {
      holdDeliveryDispatch: (fn: (lost: Promise<void>) => Promise<unknown>) => fn(new Promise<void>(() => {})),
      claimDeliveries: async (type: string) => {
        if (type !== "slack" || !pending) return [];
        pending = false;
        return queued;
      },
      ackDelivery: async (id: string) => {
        acks.push(id);
      },
    } as never,
    flow: { inFlightRuns: new Set() } as never,
    threads: { mark: () => {} } as never,
    clientForIdentity: () => {
      throw new Error("wrong identity route");
    },
    clientForAccount: (id, teamId) => (id === "partner" && teamId === "TPARTNER" ? client : undefined),
    externalNamespace: () => namespace,
  });
  await poller.pollDeliveries(client);
  assert.deepEqual(
    posts.map((p) => p.channel),
    ["CSHARED"],
  );
  assert.deepEqual(acks.sort(), [byKey.get("k-ok"), byKey.get("k-drop")].sort());
});
