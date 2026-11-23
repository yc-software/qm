import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { it } from "node:test";
import { PUBLIC } from "@microsoft/teams.api";
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from "jose";
import type { App } from "../src/api/app-types.ts";
import { createTeamsClient } from "../src/surfaces/teams/client.ts";
import { decodeTeamsChat, encodeTeamsChat, encodeTeamsUser } from "../src/surfaces/teams/ids.ts";
import { createTeamsInbound } from "../src/surfaces/teams/inbound.ts";
import { onTenantLoad } from "../src/tenants/cache.ts";
import { inTenant } from "../src/tenants/claim.ts";
import { tenantLookup } from "../src/tenants/lookup.ts";
import { loadTenantSettings } from "../src/tenants/settings.ts";
import { fakeEntra } from "./support/fake-entra.ts";
import { describeTwoTenants } from "./support/two-tenants.ts";

const TID = "0f2e7c64-5b1a-4d3e-9c8b-2a6f1e4d7b90";
const APP = "3d9b1f27-8e4c-4a6b-b5d2-7c1e9f0a4b63";
const SERVICE_URL = "https://smba.trafficmanager.net/amer/";
const CHANNEL = "19:abc@thread.tacv2";
const ada = { id: "29:ada", name: "Ada", email: "ada@contoso.com", tenantId: TID, userRole: "user" };
const guest = { id: "29:gus", name: "Gus", email: "gus@other.dev", tenantId: "other", userRole: "guest" };

function activity(overrides: Record<string, unknown> = {}) {
  return {
    type: "message",
    id: "1700000000002",
    timestamp: "2026-11-19T15:00:00.000Z",
    serviceUrl: SERVICE_URL,
    from: { id: ada.id, name: ada.name },
    recipient: { id: `28:${APP}`, name: "QM" },
    conversation: { id: `${CHANNEL};messageid=1700000000001`, conversationType: "channel", tenantId: TID },
    text: "<at>QM</at> what is <at>Gus</at> working on?",
    entities: [
      { type: "mention", text: "<at>QM</at>", mentioned: { id: `28:${APP}`, name: "QM" } },
      { type: "mention", text: "<at>Gus</at>", mentioned: { id: guest.id, name: "Gus" } },
    ],
    ...overrides,
  };
}

type Json = Record<string, any>;

describeTwoTenants("Microsoft Teams as a generic chat host", (db) => {
  onTenantLoad(() => loadTenantSettings(db.app));
  const app = {
    tenantFor: (...key: Parameters<App["tenantFor"]>) => tenantLookup(db.app).tenantFor(...key),
  } as unknown as App;
  const bind = (tenant: string) =>
    db.owner.q("UPDATE tenants SET settings = $2 WHERE id = $1", [
      tenant,
      { teams: { tenantId: TID, appId: APP, appSecret: "bot-secret" } },
    ]);

  it("turns a signed activity into a generic chat event from the bound workspace, and refuses other tokens", async () => {
    await bind(db.tenants[0]);
    await assert.rejects(bind(db.tenants[1]), /tenants_teams_tenant/);
    const { privateKey, publicKey } = await generateKeyPair("RS256");
    const keys = createLocalJWKSet({ keys: [{ ...(await exportJWK(publicKey)), kid: "k1", alg: "RS256" }] });
    const token = (audience: string) =>
      new SignJWT({ serviceurl: SERVICE_URL })
        .setProtectedHeader({ alg: "RS256", kid: "k1" })
        .setIssuer(PUBLIC.tokenIssuer)
        .setAudience(audience)
        .setIssuedAt()
        .setExpirationTime("5m")
        .sign(privateKey);
    const dispatched: [Json, string | undefined][] = [];
    const lookups: string[] = [];
    const inbound = createTeamsInbound({
      client: {
        members: async () => (lookups.push("roster"), [ada, guest]),
        member: async (_chat, id) => (lookups.push(id), { ...ada, id, name: "Newcomer" }),
      },
      app,
      keys,
      dispatch: async (event, tenant) => (
        dispatched.push([event as Json, tenant]),
        { status: 200, body: { ok: true } }
      ),
    });
    const send = async (auth: string, body: object) =>
      (await inbound.handle(`Bearer ${auth}`, JSON.stringify(body))).status;

    assert.equal(await send(await token(APP), activity()), 200);
    assert.equal(
      await send(await token(APP), activity({ value: { qm_action: "approve:a1" }, replyToId: "1700000000050" })),
      200,
    );
    assert.equal(await send(await token(APP), activity({ from: { id: "29:new", name: "Newcomer" } })), 200);
    assert.deepEqual(lookups, ["roster", "29:new"]);
    assert.equal(await send(await token("someone-else"), activity()), 401);
    assert.equal(
      await send(
        await token(APP),
        activity({
          conversation: { id: CHANNEL, conversationType: "channel", tenantId: "1b4e28ba-2fa1-11d2-883f-0016d3cca427" },
        }),
      ),
      404,
    );

    assert.deepEqual(
      dispatched.map(([, tenant]) => tenant),
      [db.tenants[0], db.tenants[0], db.tenants[0]],
    );
    const [message, click] = dispatched.map(([event]) => event) as [Json, Json];
    assert.equal(message.type, "message.created");
    assert.equal(message.account, TID);
    assert.deepEqual(decodeTeamsChat(message.chat.id), { type: "channel", id: CHANNEL });
    assert.equal(message.thread_id, "1700000000001");
    assert.deepEqual(
      { body: message.message.body, mentions: message.message.mentions_agent, author: message.message.user.id },
      { body: "what is Gus working on?", mentions: true, author: encodeTeamsUser(ada.id) },
    );
    assert.deepEqual(
      message.chat.members.map((m: Record<string, unknown>) => [m.name, m.member ?? null, m.bot ?? false]),
      [
        ["Ada", true, false],
        ["Gus", false, false],
        ["QM", null, true],
      ],
    );
    assert.deepEqual(
      { type: click.type, id: click.action.id, on: click.message.id, by: click.action.user.id },
      { type: "action.invoked", id: "approve:a1", on: "1700000000050", by: encodeTeamsUser(ada.id) },
    );
  });

  it("posts, threads, targets and decorates messages through the Bot Connector with the workspace's bot", async () => {
    const seen: { method: string; url: string; auth: string; body: Json }[] = [];
    const connector = createServer((req, res) => {
      let raw = "";
      req.on("data", (c) => (raw += c));
      req.on("end", () => {
        seen.push({
          method: req.method!,
          url: decodeURIComponent(req.url!),
          auth: req.headers.authorization!,
          body: raw ? JSON.parse(raw) : {},
        });
        res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ id: "1700000000099" }));
      });
    });
    await new Promise<void>((resolve) => connector.listen(0, "127.0.0.1", resolve));
    const entra = fakeEntra(() => ({ token: "bot-token" }));
    const client = createTeamsClient({
      serviceUrl: `http://127.0.0.1:${(connector.address() as AddressInfo).port}/`,
      networkClient: entra.network,
    });
    const chat_id = encodeTeamsChat({ type: "channel", id: CHANNEL });
    try {
      const posted = await inTenant(db.tenants[0], async () => {
        const reply = await client.post(TID, {
          client_message_id: "k",
          chat_id,
          thread_id: "1700000000001",
          body: "**Done**",
        });
        await client.post(TID, {
          client_message_id: "k2",
          chat_id,
          body: "Approve?",
          actions: [{ id: "approve:a1", label: "Approve", style: "primary" }],
        });
        await client.post(TID, {
          client_message_id: "k3",
          chat_id,
          body: "Only you",
          recipient_user_id: encodeTeamsUser(ada.id),
        });
        await client.react(TID, { chat_id, message_id: "1700000000099", name: "eyes" }, { on: true, emoji: "👀" });
        await client.post(TID, { client_message_id: "k4", chat_id, body: "line\n".repeat(4_000) });
        return reply;
      });
      assert.deepEqual(posted, { message_id: "1700000000099" });
    } finally {
      connector.close();
    }
    assert.deepEqual(entra.secrets, ["bot-secret"]);
    assert.ok(seen.every((r) => r.auth === "Bearer bot-token"));
    const [threaded, carded, targeted, reacted] = seen;
    assert.equal(threaded!.url, `/v3/conversations/${CHANNEL};messageid=1700000000001/activities`);
    assert.deepEqual([threaded!.body.text, threaded!.body.textFormat], ["**Done**", "markdown"]);
    const card = carded!.body.attachments[0];
    assert.equal(card.contentType, "application/vnd.microsoft.card.adaptive");
    assert.deepEqual(card.content.actions, [
      { type: "Action.Submit", title: "Approve", style: "positive", data: { qm_action: "approve:a1" } },
    ]);
    assert.deepEqual(targeted!.body.recipient, { id: ada.id, name: "", role: "user", isTargeted: true });
    assert.equal(reacted!.method, "PUT");
    assert.ok(reacted!.url.includes("1700000000099") && reacted!.url.includes("1f440_eyes"));
    const long = seen.slice(4).map((r) => r.body.text as string);
    assert.equal(long.join(""), "line\n".repeat(4_000));
    assert.ok(long.length > 1 && long.every((t) => t.length <= 9_000));
  });
});
