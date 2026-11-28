import assert from "node:assert/strict";
import { it } from "node:test";
import type { App } from "../src/api/app-types.ts";
import { createGenericChatInbound, signedGenericChatHandler } from "../src/surfaces/generic-chat/inbound.ts";
import { createGenericChatClient } from "../src/surfaces/generic-chat/client.ts";
import { genericChatSender } from "../src/surfaces/generic-chat/outbound.ts";
import { genericChatAccount, signGenericChat } from "../src/surfaces/generic-chat/protocol.ts";
import { boundTenant, withTenant } from "../src/tenants/context.ts";
import { tenantLookup } from "../src/tenants/lookup.ts";
import { describeTwoTenants } from "./support/two-tenants.ts";

const secret = "generic-chat-shared-secret-0123456789abcdef";
const issuer = "https://idp.example";

describeTwoTenants("generic chat on a shared host", (db) => {
  const handledIn: (string | undefined)[] = [];
  const containers: string[] = [];
  const requests: { url: string; init: RequestInit }[] = [];
  const app = {
    ingestSurfaceEvents: async (events: Parameters<App["ingestSurfaceEvents"]>[0]) => {
      handledIn.push(boundTenant());
      containers.push(...events.map((event) => event.container));
      return { upserted: 1 };
    },
    onContextRequestCreated: () => () => {},
  } as unknown as App;
  const surfaceCache = { readMessages: async () => [] };
  const isInternalEmail = async () => true;
  const unansweredReply = async () => {};
  const client = createGenericChatClient({
    url: "https://chat.example",
    secret,
    fetch: async (url, init) => {
      requests.push({ url: String(url), init: init! });
      return Response.json({});
    },
  });
  const stageBlob = async () => ({ blobId: "" });
  const lookup = () => tenantLookup(db.app);
  const accountTenant = (account: string) => lookup().externalOrgTenant(issuer, account);
  const bind = (tenant: string, org: string, by = issuer) =>
    db.owner.q("INSERT INTO tenant_external_orgs(issuer, org_id, tenant) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING", [
      by,
      org,
      tenant,
    ]);
  const inbound = createGenericChatInbound({
    registerGroup: async () => {},
    accountTenant,
    client,
    stageBlob,
    turns: { start: async () => {} },
    app,
    surfaceCache,
    isInternalEmail,
    unansweredReply,
    guestReply: unansweredReply,
    onAction: async () => {},
  });
  const handle = signedGenericChatHandler(secret, inbound.dispatch);
  const blobs = { readBlob: async () => Buffer.alloc(0), readFileArtifact: async () => Buffer.alloc(0) };
  const send = genericChatSender({ app, accountTenant, client, blobs });

  async function deliver(account: string, origin?: string): Promise<number> {
    const ada = { id: "5", email: "ada@x.test" };
    const chat = { id: "88", kind: "group", members: [ada, { id: "9", bot: true }] };
    const message = { id: "1001", user: { id: "5" }, body: "hello there", created_at: "2026-11-02T20:00:00Z" };
    const raw = JSON.stringify({ event_id: "ev-1", type: "message.created", account, origin, chat, message });
    const ts = String(Math.floor(Date.now() / 1000));
    return (await handle(ts, signGenericChat(secret, ts, raw), raw)).status;
  }

  function post(account: string) {
    const delivery = { destination: { type: "partner-chat", target: `partner-chat:${account}:group:88` }, text: "hi" };
    return withTenant(db.tenants[0], (tenant) => send(delivery as Parameters<typeof send>[0], tenant));
  }

  it("routes an account to the workspace its organization is linked to, and posts only for the sender's own", async () => {
    for (const [i, tenant] of db.tenants.entries()) await bind(tenant, `700${i}`);
    const [other] = await db.owner.q("INSERT INTO tenants DEFAULT VALUES RETURNING id::text AS id");
    await bind(String(other!.id), "7002", "https://other-idp.example");
    const deliveries = [await deliver("7000"), await deliver("7001"), await deliver("7002"), await deliver("9999")];
    assert.deepEqual(deliveries, [200, 200, 404, 404]);
    assert.deepEqual(handledIn, [...db.tenants]);
    const orgs = await Promise.all(
      db.tenants.map((t) => withTenant(t, (tenant) => lookup().boundExternalOrg(tenant, issuer))),
    );
    assert.deepEqual(orgs, ["7000", "7001"]);
    assert.equal(await withTenant(String(other!.id), (tenant) => lookup().boundExternalOrg(tenant, issuer)), undefined);
    assert.equal(await post("7000"), undefined);
    assert.ok((await post("7001"))?.refused);
    await db.owner.q(`UPDATE tenants SET settings = settings || '{"serving": false}' WHERE id = $1`, [db.tenants[1]]);
    assert.equal(await deliver("7001"), 404);
  });

  it("isolates cloned chats by signed origin and returns that origin through the configured callback", async () => {
    await bind(db.tenants[0], "7000");
    const origins = ["https://one.dev.example.test", "https://two.dev.example.test"];
    const start = containers.length;
    for (const origin of origins) assert.equal(await deliver("7000", origin), 200);
    assert.equal(new Set(containers.slice(start)).size, origins.length);
    for (const origin of origins) {
      assert.equal(await post(genericChatAccount("7000", origin)), undefined);
      const { url, init } = requests.at(-1)!;
      assert.equal(url, "https://chat.example/agent_app/messages");
      assert.equal(JSON.parse(String(init.body)).origin, origin);
      const headers = new Headers(init.headers);
      assert.equal(headers.get("x-agent-app-account"), "7000");
      assert.equal(init.redirect, "error");
    }
  });

  it("rejects malformed origins without throwing", async () => {
    for (const origin of ["", "not a URL", "https://", "https://one.dev.example.test/"]) {
      assert.equal(await deliver("7000", origin), 400);
      assert.ok((await post(genericChatAccount("7000", origin)))?.refused);
    }
  });
});
