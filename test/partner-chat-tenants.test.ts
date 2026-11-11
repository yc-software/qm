import assert from "node:assert/strict";
import { it } from "node:test";
import type { App } from "../src/api/app-types.ts";
import { createPartnerChatInbound } from "../src/surfaces/partner-chat/inbound.ts";
import { partnerChatSender } from "../src/surfaces/partner-chat/outbound.ts";
import { signPartnerChat } from "../src/surfaces/partner-chat/protocol.ts";
import { boundTenant, withTenant } from "../src/tenants/context.ts";
import { tenantLookup } from "../src/tenants/lookup.ts";
import { describeTwoTenants } from "./support/two-tenants.ts";

const secret = "partner-chat-shared-secret-0123456789abcdef";

describeTwoTenants("partner chat on a shared host", (db) => {
  const handledIn: (string | undefined)[] = [];
  const app = {
    tenantFor: (...key: Parameters<App["tenantFor"]>) => tenantLookup(db.app).tenantFor(...key),
    ingestSurfaceEvents: async () => (handledIn.push(boundTenant()), { upserted: 1 }),
    onContextRequestCreated: () => () => {},
  } as unknown as App;
  const surfaceCache = { readMessages: async () => [] };
  const isInternalEmail = async () => true;
  const unansweredReply = async () => {};
  const inbound = createPartnerChatInbound({ secret, app, surfaceCache, isInternalEmail, unansweredReply });
  const send = partnerChatSender({ url: "https://chat.example", secret, app, fetch: async () => Response.json({}) });

  async function deliver(account: string): Promise<number> {
    const ada = { id: "5", email: "ada@x.test" };
    const chat = { id: "88", kind: "group", members: [ada, { id: "9", bot: true }] };
    const message = { id: "1001", user: { id: "5" }, body: "hello there", created_at: "2026-11-02T20:00:00Z" };
    const raw = JSON.stringify({ event_id: "ev-1", type: "message.created", account, chat, message });
    const ts = String(Math.floor(Date.now() / 1000));
    return (await inbound.handle(ts, signPartnerChat(secret, ts, raw), raw)).status;
  }

  function post(account: string) {
    const delivery = { destination: { type: "partner-chat", target: `partner-chat:${account}:group:88` }, text: "hi" };
    return withTenant(db.tenants[0], (tenant) => send(delivery as Parameters<typeof send>[0], tenant));
  }

  it("binds an account to one workspace, handles its events there and posts only for the sender's own", async () => {
    const bind = (tenant: string, account: string) =>
      db.owner.q("UPDATE tenants SET settings = $2 WHERE id = $1", [tenant, { partnerChatAccount: account }]);
    for (const [i, tenant] of db.tenants.entries()) await bind(tenant, `700${i}`);
    await assert.rejects(bind(db.tenants[1], "7000"), /tenants_partner_chat_account/);
    assert.deepEqual([await deliver("7000"), await deliver("7001"), await deliver("9999")], [200, 200, 404]);
    assert.deepEqual(handledIn, [...db.tenants]);
    assert.equal(await post("7000"), undefined);
    assert.ok((await post("7001"))?.refused);
    await db.owner.q(`UPDATE tenants SET settings = settings || '{"serving": false}' WHERE id = $1`, [db.tenants[1]]);
    assert.equal(await deliver("7001"), 404);
  });
});
