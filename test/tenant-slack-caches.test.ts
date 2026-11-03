import assert from "node:assert/strict";
import test from "node:test";
import { currentTenant, withTenant, withoutTenant } from "../src/tenants/context.ts";
import { neutralizeMentions, setMentionIndex, toSlackMrkdwn } from "../src/slack/mrkdwn.ts";
import { scopeActivity } from "../src/api/routes/admin/scope-activity.ts";
import type { SessionStore } from "../src/sessions/session-store.ts";

const A = "00000000-0000-4000-8000-00000000000a";
const B = "00000000-0000-4000-8000-00000000000b";

test("each tenant arms and names mentions from its own index", async () => {
  await withTenant(A, () => setMentionIndex(new Map([["alex", "UAAA"]])));
  await withTenant(B, () => setMentionIndex(new Map([["alex", "UBBB"]])));
  assert.match(await withTenant(A, () => toSlackMrkdwn("hi @alex")), /<@UAAA>/);
  assert.match(await withTenant(B, () => toSlackMrkdwn("hi @alex")), /<@UBBB>/);
  assert.equal(await withTenant(B, () => neutralizeMentions("<@UAAA>")), "@UAAA");
  await withTenant(A, () => setMentionIndex(new Map()));
  assert.doesNotMatch(await withTenant(A, () => toSlackMrkdwn("hi @alex")), /<@/);
  assert.match(await withTenant(B, () => toSlackMrkdwn("hi @alex")), /<@UBBB>/);
  assert.throws(() => withoutTenant(() => toSlackMrkdwn("hi @alex")), /No tenant is bound/);
});

test("admin scope activity snapshots are kept per tenant for a shared store", async () => {
  const store = {
    scopeActivity: async () => [
      { scopeId: `channel:${currentTenant()}`, conversations: 1, crons: 0, background: 0, lastActivity: 0 },
    ],
  } as unknown as SessionStore;
  await withTenant(A, () => scopeActivity(store));
  await withTenant(B, () => scopeActivity(store));
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual([...(await withTenant(A, () => scopeActivity(store)))!.byScope.keys()], [`channel:${A}`]);
  assert.deepEqual([...(await withTenant(B, () => scopeActivity(store)))!.byScope.keys()], [`channel:${B}`]);
  assert.throws(() => withoutTenant(() => scopeActivity(store)), /No tenant is bound/);
});
