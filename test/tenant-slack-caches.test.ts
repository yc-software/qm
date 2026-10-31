import assert from "node:assert/strict";
import test from "node:test";
import { currentTenant, withTenant } from "../src/tenants/context.ts";
import { neutralizeMentions, setMentionIndex, toSlackMrkdwn } from "../src/slack/mrkdwn.ts";
import { scopeActivity } from "../src/api/routes/admin/scope-activity.ts";
import type { SessionStore } from "../src/sessions/session-store.ts";

const A = "00000000-0000-4000-8000-00000000000a";
const B = "00000000-0000-4000-8000-00000000000b";

test("each tenant arms and names mentions from its own index", () => {
  withTenant(A, () => setMentionIndex(new Map([["alex", "UAAA"]])));
  withTenant(B, () => setMentionIndex(new Map([["alex", "UBBB"]])));
  assert.match(
    withTenant(A, () => toSlackMrkdwn("hi @alex")),
    /<@UAAA>/,
  );
  assert.match(
    withTenant(B, () => toSlackMrkdwn("hi @alex")),
    /<@UBBB>/,
  );
  assert.equal(
    withTenant(B, () => neutralizeMentions("<@UAAA>")),
    "@UAAA",
  );
  withTenant(A, () => setMentionIndex(new Map()));
  assert.doesNotMatch(
    withTenant(A, () => toSlackMrkdwn("hi @alex")),
    /<@/,
  );
  assert.match(
    withTenant(B, () => toSlackMrkdwn("hi @alex")),
    /<@UBBB>/,
  );
  assert.throws(() => toSlackMrkdwn("hi @alex"), /No tenant is bound/);
});

test("admin scope activity snapshots are kept per tenant for a shared store", async () => {
  const store = {
    scopeActivity: async () => [
      { scopeId: `channel:${currentTenant()}`, conversations: 1, crons: 0, background: 0, lastActivity: 0 },
    ],
  } as unknown as SessionStore;
  withTenant(A, () => scopeActivity(store));
  withTenant(B, () => scopeActivity(store));
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual([...withTenant(A, () => scopeActivity(store))!.byScope.keys()], [`channel:${A}`]);
  assert.deepEqual([...withTenant(B, () => scopeActivity(store))!.byScope.keys()], [`channel:${B}`]);
  assert.throws(() => scopeActivity(store), /No tenant is bound/);
});
