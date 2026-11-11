import assert from "node:assert/strict";
import { after, before, describe, it } from "./support/unbound-test.ts";
import type { App } from "../src/api/app-types.ts";
import { createPartnerChatInbound } from "../src/surfaces/partner-chat/inbound.ts";
import { partnerChatSender } from "../src/surfaces/partner-chat/outbound.ts";
import { signPartnerChat } from "../src/surfaces/partner-chat/protocol.ts";
import { bindBootTenant } from "../src/tenants/boot.ts";
import { boundTenant, withTenant } from "../src/tenants/context.ts";
import { tenantLookup } from "../src/tenants/lookup.ts";
import type { Delivery } from "../src/types.ts";
import { twoTenants, type TwoTenants } from "./support/two-tenants.ts";

const SECRET = "partner-chat-shared-secret-0123456789abcdef";
const ACCOUNTS = ["7001", "7002"] as const;

describe("partner chat on a shared host", () => {
  let db: TwoTenants;
  const mirroredIn: (string | undefined)[] = [];
  const app = () =>
    ({
      tenantFor: tenantLookup(db.app).tenantFor,
      ingestSurfaceEvents: async (events: unknown[]) => (mirroredIn.push(boundTenant()), { upserted: events.length }),
      onContextRequestCreated: () => () => {},
    }) as unknown as App;

  before(async () => {
    await bindBootTenant(async () => undefined);
    db = await twoTenants();
    for (const [i, tenant] of db.tenants.entries())
      await db.owner.q("UPDATE tenants SET settings = $2 WHERE id = $1", [
        tenant,
        JSON.stringify({ partnerChatAccount: ACCOUNTS[i] }),
      ]);
  });

  after(() => db?.close());

  it("handles each event in the workspace bound to its account, and no other", async () => {
    const inbound = createPartnerChatInbound({
      secret: SECRET,
      app: app(),
      surfaceCache: { readMessages: async () => [] },
      isInternalEmail: async () => true,
      unansweredReply: async () => {},
    });
    const deliver = (account: string) => {
      const person = { id: "5", email: "ada@example.com", name: "Ada Lovelace" };
      const raw = JSON.stringify({
        event_id: `ev-${account}`,
        type: "message.created",
        account,
        chat: { id: "88", kind: "group", members: [person, { id: "9", name: "QM", bot: true }] },
        message: { id: "1001", user: person, body: "hello there", created_at: "2026-11-02T20:00:00Z" },
      });
      const ts = String(Math.floor(Date.now() / 1000));
      return inbound.handle(ts, signPartnerChat(SECRET, ts, raw), raw);
    };
    assert.deepEqual([(await deliver(ACCOUNTS[0])).status, (await deliver(ACCOUNTS[1])).status], [200, 200]);
    assert.deepEqual(mirroredIn, [...db.tenants]);
    await db.owner.q(`UPDATE tenants SET settings = settings || '{"serving": false}' WHERE id = $1`, [db.tenants[1]]);
    assert.deepEqual([(await deliver("9999")).status, (await deliver(ACCOUNTS[1])).status], [404, 404]);
    assert.deepEqual(mirroredIn, [...db.tenants]);
  });

  it("posts only into the sending workspace's own account", async () => {
    const posted: unknown[] = [];
    const send = partnerChatSender({
      url: "https://chat.example",
      secret: SECRET,
      app: app(),
      fetch: async (_url, init) => {
        posted.push(new Headers(init?.headers).get("x-agent-app-account"));
        return Response.json({ message_id: "51" });
      },
    });
    const post = (account: string) =>
      withTenant(db.tenants[0], () =>
        send({
          id: `d-${account}`,
          destination: { type: "partner-chat", target: `partner-chat:${account}:group:88` },
          text: "hi",
          idempotencyKey: `k-${account}`,
        } as Delivery),
      );
    assert.equal(await post(ACCOUNTS[0]), undefined);
    assert.ok((await post(ACCOUNTS[1]))?.refused);
    assert.deepEqual(posted, [ACCOUNTS[0]]);
  });
});
