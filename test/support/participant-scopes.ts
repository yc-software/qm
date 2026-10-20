import assert from "node:assert/strict";
import type { ScopeId } from "../../src/types.ts";
import type { SessionStore } from "../../src/sessions/session-store.ts";

async function appendUser(store: SessionStore, sessionId: string, scope: ScopeId, text: string): Promise<void> {
  const { lease } = await store.acquireLease(sessionId);
  assert.ok(lease);
  await store.append(lease, { type: "user", payload: { text }, scopeLabel: scope });
  await store.releaseLease(lease);
}

export async function assertLateJoinerScopes(store: SessionStore, prefix: string): Promise<void> {
  const scope = `channel:${prefix}-C1` as ScopeId;
  const session = await store.getOrCreateByThread(`slack:${prefix}-C1:1`, "channel", scope, "eng");
  await store.addParticipant(session.id, `${prefix}-early`);
  await appendUser(store, session.id, scope, "before the late joiner");
  await store.addParticipant(session.id, `${prefix}-late`);

  const [early] = await store.participantScopes(`${prefix}-early`);
  assert.equal(early?.sessionCount, 1);
  assert.equal(
    early?.lastActivityAt,
    (await store.getForParticipant(session.id, `${prefix}-early`))?.lastActivityAt,
    "a scope's recency is its newest session's user activity",
  );
  assert.deepEqual(await store.participantScopes(`${prefix}-late`), [
    { scopeId: scope, channelName: "eng", sessionCount: 0, lastActivityAt: null },
  ]);
  assert.equal((await store.getForParticipant(session.id, `${prefix}-late`))?.hasEntries, false);

  await appendUser(store, session.id, scope, "after the late joiner");
  const [late] = await store.participantScopes(`${prefix}-late`);
  assert.equal(late?.sessionCount, 1, "the late joiner counts the session once it has something they can see");
}
