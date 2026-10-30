import assert from "node:assert/strict";
import type { DirectoryStore } from "../../src/directory/directory-store.ts";

export async function directoryObservationCases(store: DirectoryStore): Promise<void> {
  const room = { channelId: "C_OBS", name: "room", isPrivate: true };
  const other = { channelId: "C_OTHER", name: "other", isPrivate: true };
  const member = { channelId: room.channelId, principalId: "U_ONE" };
  const patch = (at: number) =>
    store.recordObservation({
      kind: "channel",
      id: room.channelId,
      name: room.name,
      isPrivate: room.isPrivate,
      memberIds: ["U_ONE"],
      observedAt: at,
    });
  await store.replaceChannels([other], [], 100);
  assert.equal(await patch(300), true);
  assert.equal(await store.channelMembership(room.channelId, member.principalId), true);
  assert.equal(await store.channelPrivacy(other.channelId), true);
  assert.equal(await store.replaceChannels([other], [], 200), true);
  assert.equal(await store.channelMembership(room.channelId, member.principalId), true);
  assert.equal(await store.replaceChannels([other], [], 400), true);
  assert.equal(await store.channelPrivacy(room.channelId), undefined);
  assert.equal(await patch(350), false);
  assert.equal(await patch(500), true);
  assert.equal(await patch(450), false);
  assert.equal(await store.replaceChannels([room, other], [], 475, [], [member]), true);
  assert.equal(await store.channelMembership(room.channelId, member.principalId), true);
  assert.equal(await store.replaceChannels([room, other], [], 600, [], [member]), true);
  assert.equal(await store.channelMembership(room.channelId, member.principalId), false);
  assert.equal(await patch(550), false);
  assert.equal(await patch(600), false);
  assert.equal(await store.channelMembership(room.channelId, member.principalId), false);
  assert.equal(await patch(650), true);
  assert.equal(await patch(650), false);
  assert.equal(await store.replaceChannels([room, other], [], 650, [], [member]), true);
  assert.equal(await store.channelMember(room.channelId, member.principalId), false);
  assert.equal(await patch(650), false);
  assert.equal(await patch(675), true);
  assert.equal(await store.replaceChannels([other], [], 660), true);
  assert.equal(await store.channelMember(room.channelId, member.principalId), true);
  assert.equal(await store.replaceChannels([other], [], 700), true);
  assert.equal(await store.channelPrivacy(room.channelId), undefined);
  assert.equal(await patch(800), true);
  assert.equal(await store.replaceChannels([room, other], []), true);
  assert.equal(await store.channelMembership(room.channelId, member.principalId), false);
  assert.equal(await patch(900), true);
  assert.equal(await store.replaceChannels([], []), true);
  assert.equal(await store.channelPrivacy(room.channelId), undefined);
}

export async function groupObservationCases(store: DirectoryStore): Promise<void> {
  const rows = (rosters: Record<string, string[]>) =>
    Object.entries(rosters).flatMap(([groupId, ids]) => ids.map((principalId) => ({ groupId, principalId })));
  const live = (groupId: string, memberIds: string[], observedAt: number) =>
    store.recordObservation({ kind: "group", id: groupId, memberIds, observedAt });
  const crawl = (rosters: Record<string, string[]>, at: number) =>
    store.replaceGroups(rows(rosters), at, Object.keys(rosters), Object.keys(rosters));
  const [fresh, other, late] = ["G_OBS_NEW", "G_OBS_OTHER", "G_OBS_LATE"];

  assert.equal(await crawl({ [other]: ["U_ONE"] }, 100), true);
  assert.equal(await store.groupMembership(fresh, "U_ONE"), false);
  assert.equal(await live(fresh, ["U_ONE"], 200), true);
  assert.equal(await store.groupMember(fresh, "U_ONE"), true);
  assert.equal(await store.groupMembership(fresh, "U_ONE"), true);
  assert.equal(await store.groupMembership("G_OBS_UNLISTED", "U_ONE"), false);

  assert.equal(await crawl({ [other]: ["U_TWO"] }, 150), true, "an in-flight crawl still lands");
  assert.equal(await store.groupMember(other, "U_ONE"), false);
  assert.equal(await store.groupMember(other, "U_TWO"), true);
  assert.equal(await store.groupMember(fresh, "U_ONE"), true, "the newer live group survives the older crawl");

  assert.equal(await live(late, ["U_ONE"], 120), false, "a live write older than the last crawl is stale");
  assert.equal(await store.groupMember(late, "U_ONE"), false);
  assert.equal(await live(fresh, ["U_ONE", "U_TWO"], 200), false, "an equal observation does not overwrite");
  assert.equal(await store.groupMember(fresh, "U_TWO"), false);

  assert.equal(await crawl({ [fresh]: ["U_TWO"], [other]: ["U_TWO"] }, 300), true);
  assert.equal(await store.groupMember(fresh, "U_ONE"), false, "a newer crawl removes the member");
  assert.equal(await live(fresh, ["U_ONE"], 200), false, "replaying the old observation does not resurrect");
  assert.equal(await live(fresh, ["U_ONE"], 250), false);
  assert.equal(await store.groupMember(fresh, "U_ONE"), false);
  assert.equal(await store.groupMembership(fresh, "U_ONE"), false);

  assert.equal(await live(fresh, ["U_ONE", "U_TWO"], 400), true, "a newer observation is accepted");
  assert.equal(await store.groupMember(fresh, "U_ONE"), true);
  assert.equal(await store.groupMembership("G_OBS_UNLISTED", "U_ONE"), false);
  assert.equal(await crawl({ [fresh]: ["U_TWO"], [other]: ["U_TWO"] }, 500), true);
  assert.equal(await store.groupMember(fresh, "U_ONE"), false, "a newer crawl wins even when it repeats the last one");
}
