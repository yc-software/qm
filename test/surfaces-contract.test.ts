import { test } from "node:test";
import assert from "node:assert/strict";
import { createDeliveryStore } from "../src/delivery/delivery-store.ts";
import { parseDeliveryTarget } from "../src/slack/delivery.ts";
import { classifyUser, type SlackIdentityMode, type SlackUser } from "../src/slack/identity.ts";
import { parseSurfaceThreadRef, surfaceContainerRef, surfaceThreadRef } from "../src/surfaces/refs.ts";
import { createSurfaceRegistry } from "../src/surfaces/registry.ts";
import { createSlackSurface } from "../src/surfaces/slack/adapter.ts";

const slackSurface = () => createSlackSurface({ deliveries: createDeliveryStore() });

test("surface thread refs round-trip and reject malformed input", () => {
  const thread = { surface: "slack", account: "T1", kind: "channel" as const, container: "C1", thread: "1700.0001" };
  assert.equal(surfaceThreadRef(thread), "slack:T1:ch:C1:1700.0001");
  assert.deepEqual(parseSurfaceThreadRef(surfaceThreadRef(thread)), thread);
  const dm = { surface: "bookface", account: "acct", kind: "dm" as const, container: "D9" };
  assert.equal(surfaceThreadRef(dm), "bookface:acct:dm:D9");
  assert.deepEqual(parseSurfaceThreadRef("bookface:acct:dm:D9"), dm);
  assert.deepEqual(parseSurfaceThreadRef("x:y:grp:G1")?.kind, "group");
  assert.equal(surfaceContainerRef(thread), "slack:T1:C1");
  assert.throws(() => surfaceThreadRef({ ...dm, container: "D 9" }), /container/);
  assert.throws(() => surfaceThreadRef({ ...thread, thread: "a:b" }), /thread/);
  for (const bad of ["dm:C1", "ch:C1:1700.1", "slack:T1:xx:C1", "slack:T1:ch:C1:1:2", "slack::ch:C1", "slack:T1:ch"])
    assert.equal(parseSurfaceThreadRef(bad), undefined, bad);
});

test("surface registry enforces unique kinds and resolves labels", () => {
  const slack = slackSurface();
  const registry = createSurfaceRegistry({ surfaces: [slack] });
  assert.equal(registry.get("slack"), slack);
  assert.equal(registry.get("web"), undefined);
  assert.equal(registry.label("slack"), "Slack");
  assert.equal(registry.label("web"), undefined);
  assert.equal(registry.label(undefined), undefined);
  assert.deepEqual(registry.list(), [slack]);
  assert.throws(() => createSurfaceRegistry({ surfaces: [slack, slackSurface()] }), /unique: slack/);
});

test("slack adapter principals match classifyUser for every identity mode", () => {
  const users: (SlackUser | undefined)[] = [
    { id: "U1", team_id: "T1", real_name: "Ada", profile: { display_name: "ada", email: " Ada@Example.com " } },
    { id: "U2", team_id: "T1", is_restricted: true, profile: { email: "guest@example.com" } },
    { id: "U3", team_id: "T2", name: "remote", profile: { email: "remote@example.com" } },
    { id: "U4", team_id: "T1", is_ultra_restricted: true, deleted: true },
    { id: "B1", team_id: "T1", is_bot: true, real_name: "Helper Bot" },
    { id: "U5", team_id: "T1", is_stranger: true, profile: { display_name: "", email: "" } },
    { id: "U6", team_id: "T1" },
    undefined,
  ];
  for (const identityMode of ["slack-id", "email"] as SlackIdentityMode[]) {
    const surface = slackSurface();
    const slack = surface.native("slack")!;
    slack.accounts.set("default", { ownTeamId: "T1", identityMode });
    for (const user of users)
      assert.deepEqual(
        surface.principalFor(slack.userFrom(user, "default")),
        classifyUser(user, "T1", identityMode),
        `${identityMode} ${user?.id}`,
      );
  }
});

test("slack adapter mentions, hints and native handle", () => {
  const surface = slackSurface();
  assert.equal(surface.mention({ surface: "slack", account: "default", id: "U42" }), "<@U42>");
  assert.equal(surface.promptHints().surfaceLabel, "Slack");
  assert.match(surface.promptHints().mentionSyntax ?? "", /<@U…>/);
  assert.ok(surface.native("slack"));
});

test("slack adapter post enqueues the destination the slack drainer reads", async () => {
  const deliveries = createDeliveryStore();
  const surface = createSlackSurface({ deliveries });
  await surface.post(
    { surface: "slack", account: "default", kind: "channel", container: "C1", thread: "1700.0001" },
    { text: "in thread" },
    "k1",
  );
  await surface.post({ surface: "slack", account: "default", kind: "dm", container: "D1" }, { text: "dm" }, "k2");
  await surface.post({ surface: "slack", account: "acct2", kind: "channel", container: "C2" }, { text: "other" }, "k3");
  const byKey = new Map((await deliveries.pending("slack")).map((d) => [d.idempotencyKey, d]));
  assert.deepEqual(byKey.get("k1")?.destination, { type: "slack", target: "C1:1700.0001" });
  assert.deepEqual(parseDeliveryTarget(byKey.get("k1")!.destination.target), { channel: "C1", threadTs: "1700.0001" });
  assert.equal(byKey.get("k1")?.text, "in thread");
  assert.deepEqual(byKey.get("k2")?.destination, { type: "slack", target: "D1" });
  assert.deepEqual(byKey.get("k3")?.destination, { type: "slack", target: "C2", slackAccountId: "acct2" });
});
