import { test } from "node:test";
import assert from "node:assert/strict";
import { createSkillStore } from "../src/skills/skill-store.ts";
import { scopeId } from "../src/types.ts";

const manifest = (body: string) => ({ name: "deploy", description: "d", requiredCapabilities: [], body });

test("moving a skill into a scope that already has a live skill of that name is refused", async () => {
  const store = createSkillStore();
  const channel = scopeId("channel", "C1");
  const personal = scopeId("personal", "U1");
  const resident = await store.create({ scopeId: channel, manifest: manifest("team"), createdBy: "U2" });
  await store.review(resident.id, "r", []);
  await store.publish(resident.id);
  const mine = await store.create({ scopeId: personal, manifest: manifest("mine"), createdBy: "U1" });
  await store.review(mine.id, "r", []);
  await store.publish(mine.id);

  await assert.rejects(store.move(mine.id, channel), /already has a skill named "deploy"/);
  const resolved = await store.resolve("deploy", [channel]);
  assert.equal(resolved.skill?.id, resident.id, "the resident skill still resolves");
  assert.equal((await store.get(mine.id))?.scopeId, personal, "the refused move changed nothing");

  await store.archive(resident.id);
  await store.move(mine.id, channel);
  assert.equal((await store.resolve("deploy", [channel])).skill?.id, mine.id, "an archived resident doesn't block");
});
