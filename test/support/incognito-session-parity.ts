import assert from "node:assert/strict";
import { scopeId } from "../../src/types.ts";
import type { SessionStore } from "../../src/sessions/session-store.ts";

export async function assertIncognitoSessionParity(store: SessionStore, prefix: string): Promise<void> {
  const principal = `${prefix}-owner`;
  const scope = scopeId("personal", principal);
  const seed = async (threadRef: string, text: string, incognito?: boolean) => {
    const session = await store.getOrCreateByThread(threadRef, "dm", scope, undefined, "web", undefined, { incognito });
    await store.addParticipant(session.id, principal, undefined, { includeHistory: true });
    const { lease } = await store.acquireLease(session.id);
    assert.ok(lease);
    await store.append(lease, { type: "user", payload: { text }, scopeLabel: scope });
    await store.releaseLease(lease);
    return session;
  };
  const secret = await seed(`web:${principal}:incognito`, "zebrafish tasting notes", true);
  const normal = await seed(`web:${principal}:normal`, "zebrafish aquarium plans");
  assert.equal(secret.incognito, true);
  assert.equal(normal.incognito, undefined);

  const again = await store.getOrCreateByThread(secret.threadRef, "dm", scope, undefined, "web", undefined, {
    incognito: false,
  });
  assert.equal(again.id, secret.id);
  assert.equal(again.incognito, true, "a later call cannot turn an incognito session normal");
  const normalAgain = await store.getOrCreateByThread(normal.threadRef, "dm", scope, undefined, "web", undefined, {
    incognito: true,
  });
  assert.equal(normalAgain.incognito, undefined, "a later call cannot turn a normal session incognito");

  assert.equal((await store.get(secret.id))?.incognito, true);
  assert.equal((await store.getByThread(secret.threadRef))?.incognito, true);
  assert.equal((await store.getForParticipant(secret.id, principal))?.incognito, true);
  const listed = await store.listByParticipant(principal);
  assert.equal(listed.find((s) => s.id === secret.id)?.incognito, true);
  assert.equal(listed.find((s) => s.id === normal.id)?.incognito, undefined);

  const page = await store.listParticipantPage(principal, { limit: 50 });
  assert.deepEqual(
    page.sessions.map((s) => s.id),
    [normal.id],
    "the session page leaves incognito sessions out",
  );
  const [personal] = await store.participantScopes(principal);
  assert.equal(personal?.sessionCount, 1, "scope counts leave incognito sessions out");

  await store.updateTitle(secret.id, "zebrafish secret");
  await store.updateTitle(normal.id, "zebrafish public");
  assert.deepEqual(
    (await store.searchSessionTitles(principal, "zebrafish")).map((s) => s.id),
    [normal.id],
    "title search leaves incognito sessions out",
  );

  const hits = await store.searchEntries(principal, "zebrafish");
  assert.deepEqual(
    hits.map((hit) => hit.sessionId),
    [normal.id],
    "search leaves incognito sessions out",
  );
}
