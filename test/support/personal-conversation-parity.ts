import assert from "node:assert/strict";
import { scopeId, type SessionType } from "../../src/types.ts";
import { tapeTranscriptEntryRecord, type SessionStore } from "../../src/sessions/session-store.ts";

export async function assertPersonalConversationParity(store: SessionStore, prefix: string): Promise<void> {
  const scope = scopeId("personal", prefix);
  const create = async (
    name: string,
    payload?: Record<string, unknown>,
    type: SessionType = "dm",
    sessionScope = scope,
    threadRef = `${prefix}:${name}`,
  ) => {
    const session = await store.getOrCreateByThread(threadRef, type, sessionScope);
    if (payload) {
      const { lease } = await store.acquireLease(session.id);
      assert.ok(lease);
      await store.append(lease, { type: "user", payload, scopeLabel: sessionScope });
      await store.releaseLease(lease);
    }
    return session;
  };
  await create("empty");
  await create("proactive", { text: "Greet the user", hidden: true });
  await create("overheard", { text: "Ambient chatter", overheard: true });
  await create("channel", { text: "Hello" }, "channel");
  await create("other", { text: "Hello" }, "dm", scopeId("personal", `${prefix}-other`));
  for (const origin of ["cron", "webhook", "monitor"])
    await create(origin, { text: "Hello" }, "dm", scope, `agent:main:${origin}:${prefix}`);
  const child = await create("child", { text: "Delegated work" });
  await store.setParentSession(child.id, "parent");
  const fork = await create("fork", { text: "Copied user request" });
  await store.updateForkProvenance(fork.id, { forkedFrom: { sessionId: "source" }, forkBoundarySeq: 0 });
  assert.equal(await store.countPersonalConversations(scope), 0);
  const archived = await create("archived", { text: "Hello" });
  await store.addParticipant(archived.id, prefix);
  await store.updateParticipantView(archived.id, prefix, { archived: true });
  assert.equal(await store.countPersonalConversations(scope), 1);
  const { lease } = await store.acquireLease(fork.id);
  assert.ok(lease);
  await store.append(lease, { type: "user", payload: { text: "A new request" }, scopeLabel: scope });
  await store.append(lease, { type: "user", payload: { text: "Another turn" }, scopeLabel: scope });
  await store.releaseLease(lease);
  assert.equal(await store.countPersonalConversations(scope), 2);
  const canonical = await create("canonical", { text: "Synthetic", hidden: true });
  const canonicalLease = (await store.acquireLease(canonical.id)).lease;
  assert.ok(canonicalLease);
  const [original] = await store.getEntries(canonical.id);
  assert.ok(original);
  await store.appendTape(canonicalLease, tapeTranscriptEntryRecord({ ...original, payload: { text: "Real request" } }));
  await store.releaseLease(canonicalLease);
  assert.equal(await store.countPersonalConversations(scope), 3);
  await create("fourth", { text: "Hello\u0000", hidden: "true", overheard: "true" });
  assert.equal(await store.countPersonalConversations(scope), 3);
  assert.equal(await store.countPersonalConversations(scope, 4), 4);
  assert.equal(await store.countPersonalConversations(scope, 1), 1);
  assert.equal(await store.countPersonalConversations(scope, 0), 0);
}
