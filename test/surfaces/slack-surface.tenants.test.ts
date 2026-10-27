import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createSlackSurface } from "../../src/surfaces/slack-surface.ts";
import { createSlackCoreClient, type SlackCoreClientDeps } from "../../src/api/slack-core-client.ts";
import type { OutboundPost } from "../../src/surfaces/outbound.ts";
import { tenantFor, withTenant } from "../../src/tenant.ts";

const post = (text: string): OutboundPost => ({
  destination: { type: "slack", target: "C1" },
  text,
  idempotencyKey: text,
});

test("each tenant's Slack plugin registers its own account, sender and events handler on the shared surface", async () => {
  const a = tenantFor("org-a", randomUUID(), "a");
  const b = tenantFor("org-b", randomUUID(), "b");
  const surface = createSlackSurface();
  const delivered: string[] = [];
  for (const t of [a, b])
    withTenant(t, () => {
      const name = t.slug!;
      surface.slack.accounts.set("default", { client: { bot: name }, teamId: `T${name}` });
      surface.slack.attach(async (p) => void delivered.push(`${name}:${p.text}`));
      surface.slack.serveEvents("", async (_req, res) => void res.end(name));
    });

  assert.equal(
    withTenant(a, () => surface.slack.accounts.get("default")?.client.bot),
    "a",
  );
  assert.equal(
    withTenant(b, () => surface.slack.accounts.get("default")?.client.bot),
    "b",
  );
  assert.equal(
    withTenant(a, () => surface.slack.accounts.size),
    1,
  );
  await withTenant(a, () => surface.deliver(post("hello")));
  await withTenant(b, () => surface.deliver(post("hola")));
  assert.deepEqual(delivered, ["a:hello", "b:hola"]);
  const ended: string[] = [];
  const res = { end: (body: string) => ended.push(body) } as never;
  await withTenant(a, () => surface.slack.events("")!({} as never, res));
  await withTenant(b, () => surface.slack.events("")!({} as never, res));
  assert.deepEqual(ended, ["a", "b"]);
  await assert.rejects(surface.deliver(post("nobody")), /no slack connection is available/);
});

test("Slack upkeep runs only the closures attached under the current tenant", async () => {
  const a = tenantFor("org-a", randomUUID(), "a");
  const b = tenantFor("org-b", randomUUID(), "b");
  const core = createSlackCoreClient({ runs: { onTerminal() {} } } as unknown as SlackCoreClientDeps);
  const ran: string[] = [];
  for (const t of [a, b])
    withTenant(t, () => core.upkeep.attach({ reconcileStatus: async () => void ran.push(t.slug!) }));
  await withTenant(a, () => core.upkeep.run("reconcileStatus"));
  assert.deepEqual(ran, ["a"]);
  await withTenant(b, () => core.upkeep.run("reconcileStatus"));
  assert.deepEqual(ran, ["a", "b"]);
});
