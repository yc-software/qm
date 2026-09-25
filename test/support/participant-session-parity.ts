import assert from "node:assert/strict";
import { scopeId } from "../../src/types.ts";
import type { SessionStore } from "../../src/sessions/session-store.ts";

async function appendAll(
  store: SessionStore,
  sessionId: string,
  scope: ReturnType<typeof scopeId>,
  payloads: Array<{ type: "user" | "assistant"; payload: Record<string, unknown> }>,
): Promise<void> {
  const { lease } = await store.acquireLease(sessionId);
  assert.ok(lease);
  for (const { type, payload } of payloads) await store.append(lease, { type, payload, scopeLabel: scope });
  await store.releaseLease(lease);
}

export async function assertParticipantSessionParity(store: SessionStore, prefix: string): Promise<void> {
  const [owner, guest, stranger] = [`${prefix}-owner`, `${prefix}-guest`, `${prefix}-stranger`];
  const personal = scopeId("personal", owner);
  const channel = scopeId("channel", `${prefix}-C1`);

  const owned = await store.getOrCreateByThread(`${prefix}:owned`, "dm", personal);
  await store.addParticipant(owned.id, owner);
  await appendAll(store, owned.id, personal, [
    { type: "user", payload: { text: "first" } },
    { type: "assistant", payload: { text: "reply" } },
    { type: "user", payload: { overheard: true, text: "chatter" } },
    { type: "user", payload: { text: "second" } },
  ]);
  await store.updateParticipantView(owned.id, owner, {
    title: "Renamed by the viewer",
    pinned: true,
    archived: true,
    color: "#ff0000",
  });

  const shared = await store.getOrCreateByThread(`${prefix}:shared`, "channel", channel);
  await store.addParticipant(shared.id, owner);
  await appendAll(store, shared.id, channel, [{ type: "user", payload: { text: "before the guest joined" } }]);
  await store.addParticipant(shared.id, guest);
  await appendAll(store, shared.id, channel, [{ type: "user", payload: { text: "while the guest was here" } }]);
  await store.removeParticipant(shared.id, guest);
  await appendAll(store, shared.id, channel, [{ type: "user", payload: { text: "after the guest left" } }]);

  const foreign = await store.getOrCreateByThread(`${prefix}:foreign`, "dm", scopeId("personal", guest));
  await store.addParticipant(foreign.id, guest);

  const empty = await store.getOrCreateByThread(`${prefix}:empty`, "dm", personal);
  await store.addParticipant(empty.id, owner);

  const unclaimed = await store.getOrCreateByThread(`${prefix}:unclaimed`, "channel", channel);

  const ids = [owned.id, shared.id, foreign.id, empty.id, unclaimed.id, `${prefix}-does-not-exist`];

  for (const principalId of [owner, guest, stranger]) {
    const list = await store.listByParticipant(principalId);
    let matched = 0;
    for (const id of ids) {
      const expected = list.find((session) => session.id === id) ?? null;
      const actual = await store.getForParticipant(id, principalId);
      assert.deepEqual(
        actual,
        expected,
        `the single-session read must agree with the list for ${principalId} on ${id}`,
      );
      if (expected) matched++;
    }
    assert.equal(matched, list.length, `every row ${principalId} can list is reachable one at a time`);
  }

  assert.ok(
    (await store.getForParticipant(owned.id, owner))?.pinned,
    "the participant's own view of the row survives the single-session read",
  );
  assert.equal(
    (await store.getForParticipant(shared.id, guest))?.hasEntries,
    true,
    "a closed tenure still reports the entries it saw",
  );
  assert.equal(
    (await store.getForParticipant(empty.id, owner))?.hasEntries,
    false,
    "an entry-less session reports no entries",
  );
  assert.equal(await store.getForParticipant(foreign.id, owner), null, "another principal's session is not readable");
  assert.equal(
    await store.getForParticipant(unclaimed.id, owner),
    null,
    "a session with no participants is not readable",
  );
  assert.equal(await store.getForParticipant(`${prefix}-does-not-exist`, owner), null, "an unknown id reads as null");

  for (const missing of [undefined, null, ""] as unknown as string[]) {
    assert.equal(
      await store.getForParticipant(missing, owner),
      null,
      `a missing session id (${String(missing)}) must not resolve to one of the viewer's rows`,
    );
  }

  await store.deleteSession(owned.id);
  assert.equal(await store.getForParticipant(owned.id, owner), null, "a deleted session stops being readable");
}
