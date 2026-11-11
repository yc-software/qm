import assert from "node:assert/strict";
import { it } from "node:test";
import type { App } from "../src/api/app-types.ts";
import { createPartnerChatInbound } from "../src/surfaces/partner-chat/inbound.ts";
import { partnerChatSender } from "../src/surfaces/partner-chat/outbound.ts";
import { signPartnerChat } from "../src/surfaces/partner-chat/protocol.ts";
import { onTenantLoad } from "../src/tenants/cache.ts";
import { boundTenant, withTenant } from "../src/tenants/context.ts";
import { tenantLookup } from "../src/tenants/lookup.ts";
import { loadTenantSettings } from "../src/tenants/settings.ts";
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
  const posted: unknown[] = [];
  const fetch = async (_url: unknown, init?: RequestInit) => (
    posted.push(JSON.parse(String(init?.body))),
    Response.json({})
  );
  const send = partnerChatSender({ url: "https://chat.example", secret, app, fetch });
  onTenantLoad(() => loadTenantSettings(db.app));

  async function deliver(workspace: string): Promise<number> {
    const ada = { id: "5", email: "ada@x.test" };
    const chat = { id: "88", kind: "group", members: [ada, { id: "9", bot: true }] };
    const message = { id: "1001", user: { id: "5" }, body: "hello there", created_at: "2026-11-02T20:00:00Z" };
    const raw = JSON.stringify({
      event_id: "ev-1",
      type: "message.created",
      account: "7001",
      workspace,
      chat,
      message,
    });
    const ts = String(Math.floor(Date.now() / 1000));
    return (await inbound.handle(ts, signPartnerChat(secret, ts, raw), raw)).status;
  }

  it("handles each event in the workspace it names and names the sender's workspace on each post", async () => {
    const [a, b] = db.tenants.map((tenant) => `pc${tenant.slice(0, 8)}`) as [string, string];
    for (const [i, tenant] of db.tenants.entries())
      await db.owner.q("UPDATE tenants SET settings = $2 WHERE id = $1", [tenant, { handle: [a, b][i] }]);
    assert.deepEqual([await deliver(a), await deliver(b.toUpperCase()), await deliver("nobody")], [200, 200, 404]);
    assert.deepEqual(handledIn, [...db.tenants]);
    const delivery = { destination: { type: "partner-chat", target: "partner-chat:7001:group:88" }, text: "hi" };
    await withTenant(db.tenants[0], () => send(delivery as Parameters<typeof send>[0]));
    assert.equal((posted[0] as { workspace?: string }).workspace, a);
    await db.owner.q(`UPDATE tenants SET settings = settings || '{"serving": false}' WHERE id = $1`, [db.tenants[1]]);
    assert.equal(await deliver(b), 404);
  });
});
