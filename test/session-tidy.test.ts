import "./support/auto-fake-sprites.ts";

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildApp } from "../src/wiring.ts";
import { testConfig } from "./support/test-config.ts";
import type { TurnRequest } from "../src/types.ts";

const actor = { externalId: "U1" };
function dm(text: string, thread: string): TurnRequest {
  return { surface: "test", actor, conversation: { kind: "dm", threadRef: thread }, text };
}

test("tidy archives only the idle conversations the judge marks finished", async () => {
  const { app } = buildApp(testConfig({ dataDir: mkdtempSync(join(tmpdir(), "ap-tidy-")) }));
  const done = (await app.turn(dm("Reset my password !done", "web:U1:done"))).sessionId!;
  const open = (await app.turn(dm("Plan the Q3 roadmap with me", "web:U1:open"))).sessionId!;
  const pinnedDone = (await app.turn(dm("Quick one !done", "web:U1:pinned"))).sessionId!;
  await app.updateSession(pinnedDone, "U1", { pinned: true });

  const fresh = await app.tidySessions("U1", { idleMs: 60 * 60_000 });
  assert.deepEqual(fresh, { archived: [], considered: 0 }, "nothing idle long enough is even considered");

  const out = await app.tidySessions("U1", { idleMs: 0 });
  assert.deepEqual(out.archived, [done]);
  assert.equal(out.considered, 2, "pinned chats are never candidates");
  const after = new Map((await app.listSessions("U1")).map((s) => [s.id, s]));
  assert.equal(after.get(done)?.archived, true);
  assert.equal(after.get(open)?.archived, undefined);
  assert.equal(after.get(pinnedDone)?.archived, undefined);

  assert.deepEqual(await app.tidySessions("U1", { idleMs: 0 }), { archived: [], considered: 1 });
  assert.deepEqual(await app.tidySessions("stranger", { idleMs: 0 }), { archived: [], considered: 0 });
});
