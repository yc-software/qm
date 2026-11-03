import assert from "node:assert/strict";
import { createHmac, randomUUID } from "node:crypto";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import type { App as BoltApp, ReceiverEvent } from "@slack/bolt";
import type { AckGate } from "../src/slack/deferred-ack.ts";
import { createApprovals } from "../src/slack/approvals.ts";
import { createHttpEventsReceiver } from "../src/slack/http-events.ts";
import { slackTeamOf } from "../src/slack/index.ts";
import { boundTenant } from "../src/tenants/context.ts";

const SECRET = "approval-tenants-signing-secret";
const A = randomUUID();
const B = randomUUID();
const TENANTS: Record<string, string> = { TAAA: A, TBBB: B };

test("approval button clicks from two workspaces each resolve under the tenant that installed their workspace", async (t) => {
  const lookups: Array<[string, string | undefined]> = [];
  const updates: Array<[string, string | undefined]> = [];
  const approvals = createApprovals({
    core: {
      getApproval: async (requestId: string) => {
        lookups.push([requestId, boundTenant()]);
        return null;
      },
    },
    flow: {},
    directory: {},
    threads: {},
    externalAccess: false,
  } as unknown as Parameters<typeof createApprovals>[0]);
  let onAction: ((args: unknown) => Promise<void>) | undefined;
  approvals.registerActions({ action: (_pattern, handler) => void (onAction = handler) });
  const client = {
    chat: {
      update: async (args: { channel: string }) => {
        updates.push([args.channel, boundTenant()]);
        return { ok: true };
      },
      postEphemeral: async () => ({ ok: true }),
    },
  };
  const receiver = createHttpEventsReceiver({
    signingSecret: SECRET,
    port: 0,
    tenantFor: async (body) => TENANTS[slackTeamOf(body) ?? ""] ?? null,
  });
  receiver.init?.({
    processEvent: async (event: ReceiverEvent) => {
      const body = event.body as { actions: unknown[] };
      await onAction!({ ack: event.ack, body, action: body.actions[0], client });
      (event.customProperties?.ackGate as AckGate | undefined)?.persisted();
    },
  } as unknown as BoltApp);
  await receiver.start(0 as never);
  t.after(() => receiver.stop(0 as never));
  const port = (receiver.server.address() as AddressInfo).port;
  const click = async (team: string, requestId: string, channel: string) => {
    const payload = JSON.stringify({
      type: "block_actions",
      team: { id: team },
      user: { id: "U1" },
      channel: { id: channel },
      message: { ts: "1.1" },
      actions: [{ action_id: "hilo_allow_once", value: requestId }],
    });
    const raw = `payload=${encodeURIComponent(payload)}`;
    const timestamp = String(Math.floor(Date.now() / 1000));
    const signature = `v0=${createHmac("sha256", SECRET).update(`v0:${timestamp}:${raw}`).digest("hex")}`;
    const response = await fetch(`http://127.0.0.1:${port}/slack/events`, {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        "x-slack-signature": signature,
        "x-slack-request-timestamp": timestamp,
      },
      body: raw,
    });
    return response.status;
  };
  assert.equal(await click("TAAA", "req-a", "CA"), 200);
  assert.equal(await click("TBBB", "req-b", "CB"), 200);
  assert.equal(await click("TZZZ", "req-z", "CZ"), 403);
  assert.deepEqual(lookups, [
    ["req-a", A],
    ["req-b", B],
  ]);
  assert.deepEqual(updates, [
    ["CA", A],
    ["CB", B],
  ]);
});
