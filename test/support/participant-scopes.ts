import assert from "node:assert/strict";
import type { ScopeId, SpawnMeta } from "../../src/types.ts";
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

export async function assertLeanListing(store: SessionStore, prefix: string): Promise<void> {
  const me = `${prefix}-U1`;
  const personal = `personal:${me}` as ScopeId;
  const channel = `channel:${prefix}-C1` as ScopeId;
  const spawnMeta = {
    surface: "web",
    conversation: { kind: "dm", threadRef: `web:${me}:root`, audience: [] },
    actor: { id: me, type: "internal" },
  } as unknown as SpawnMeta;
  const child = await store.getOrCreateByThread(`subagent:${prefix}-root:1`, "dm", personal, undefined, "web", [
    { name: "screenshot", description: "Take a screenshot", inputSchema: { type: "object" } },
  ]);
  await store.setSpawnMeta(child.id, spawnMeta);
  await store.addParticipant(child.id, me, "Child task");
  const empty = await store.getOrCreateByThread(`web:${me}:empty`, "dm", personal);
  await store.addParticipant(empty.id, me);
  const shared = await store.getOrCreateByThread(`slack:${prefix}-C1:1`, "channel", channel, "eng");
  await store.addParticipant(shared.id, me);
  const theirs = await store.getOrCreateByThread(`web:${prefix}-U2:a`, "dm", `personal:${prefix}-U2` as ScopeId);
  await store.addParticipant(theirs.id, `${prefix}-U2`, "Theirs");

  const listed = (await store.listByParticipant(me)).find((session) => session.id === child.id);
  assert.equal(listed?.title, "Child task");
  assert.equal(listed?.spawnMeta, undefined);
  assert.equal(listed?.clientTools, undefined);
  assert.ok((await store.getForParticipant(child.id, me))?.spawnMeta, "a single session read keeps spawn metadata");

  const scopes = new Map((await store.participantScopes(me)).map((scope) => [scope.scopeId, scope]));
  assert.deepEqual([...scopes.keys()].sort(), [channel, personal].sort());
  assert.equal(scopes.get(personal)?.sessionCount, 1);
  assert.equal(scopes.get(personal)?.lastActivityAt, (await store.getForParticipant(child.id, me))?.lastActivityAt);
  assert.deepEqual(scopes.get(channel), {
    scopeId: channel,
    channelName: "eng",
    sessionCount: 0,
    lastActivityAt: null,
  });
}
