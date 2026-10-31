import { test } from "node:test";
import assert from "node:assert/strict";
import { createDeliveryStore } from "../src/delivery/delivery-store.ts";
import { classifyUser, type SlackIdentityMode, type SlackUser } from "../src/slack/identity.ts";
import { parseSurfaceThreadRef, surfaceContainerRef, surfaceThreadRef } from "../src/surfaces/refs.ts";
import { createSurfaceRegistry } from "../src/surfaces/registry.ts";
import { createSlackSurface } from "../src/surfaces/slack/adapter.ts";

const slackSurface = () => createSlackSurface({ deliveries: createDeliveryStore() });

test("surface thread refs round-trip and reject malformed input", () => {
  const thread = {
    surface: "slack",
    account: "default",
    kind: "channel" as const,
    container: "C1",
    thread: "1700.0001",
  };
  assert.equal(surfaceThreadRef(thread), "slack:default:ch:C1:1700.0001");
  assert.deepEqual(parseSurfaceThreadRef(surfaceThreadRef(thread)), thread);
  const dm = { surface: "bookface", account: "acct", kind: "dm" as const, container: "D9" };
  assert.equal(surfaceThreadRef(dm), "bookface:acct:dm:D9");
  assert.deepEqual(parseSurfaceThreadRef("bookface:acct:dm:D9"), dm);
  assert.deepEqual(parseSurfaceThreadRef("x:y:grp:G1")?.kind, "group");
  assert.equal(surfaceContainerRef(thread), "slack:default:C1");
  assert.throws(() => surfaceThreadRef({ ...dm, container: "" }), /container/);
  assert.throws(() => surfaceThreadRef({ ...thread, thread: "a:b" }), /thread/);
  for (const bad of [
    "dm:C1",
    "ch:C1:1700.1",
    "slack:T1:xx:C1",
    "slack:T1:ch:C1:1:2",
    "slack::ch:C1",
    "slack:T1:ch",
    "slack:T1:ch:C1:",
  ])
    assert.equal(parseSurfaceThreadRef(bad), undefined, bad);
});

test("surface registry enforces unique kinds and resolves labels", () => {
  const slack = slackSurface();
  const registry = createSurfaceRegistry({ surfaces: [slack] });
  assert.equal(registry.get("slack"), slack);
  assert.equal(registry.get("web"), undefined);
  assert.equal(registry.label("slack"), "Slack");
  assert.equal(registry.label("web"), undefined);
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
    assert.throws(() => surface.principalFor({ surface: "slack", account: "other", id: "U1" }), /other/);
  }
});

test("slack adapter post enqueues the destination turn replies use for the account", async () => {
  const deliveries = createDeliveryStore();
  const surface = createSlackSurface({ deliveries });
  surface.native("slack")!.accounts.set("default", { ownTeamId: "T1", identityMode: "email" });
  await surface.post(
    { surface: "slack", account: "default", kind: "channel", container: "C1", thread: "1700.0001" },
    { text: "in thread" },
    "k1",
  );
  await surface.post({ surface: "slack", account: "default", kind: "dm", container: "D1" }, { text: "dm" }, "k2");
  const byKey = new Map((await deliveries.pending("slack")).map((d) => [d.idempotencyKey, d]));
  const account = { slackAccountId: "default", slackTeamId: "T1" };
  assert.deepEqual(byKey.get("k1")?.destination, { type: "slack", target: "C1:1700.0001", ...account });
  assert.equal(byKey.get("k1")?.text, "in thread");
  assert.deepEqual(byKey.get("k2")?.destination, { type: "slack", target: "D1", ...account });
  await assert.rejects(
    surface.post({ surface: "slack", account: "other", kind: "dm", container: "D1" }, { text: "x" }, "k3"),
    /other/,
  );
});
