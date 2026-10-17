import assert from "node:assert/strict";
import { test } from "node:test";
import { matchSessionTitles } from "../src/search-titles.ts";
import type { CoreSession } from "../src/core-bridge.ts";

const s = (id: string, title: string | null, extra: Partial<CoreSession> = {}): CoreSession => ({
  id,
  type: "dm",
  scopeId: "personal:me",
  threadRef: `web:me:${id}`,
  createdAt: 1,
  title,
  ...extra,
});
const ids = (list: CoreSession[]) => list.map((x) => x.id);
const title = (x: CoreSession) => x.title ?? "";

test("every term must prefix-match a word in the title", () => {
  const list = [s("a", "Pin babysitter for qm-fleet"), s("b", "Babysitting notes"), s("c", "Fleet pin review")];
  assert.deepEqual(ids(matchSessionTitles(list, "pin baby", title, 10)), ["a"]);
  assert.deepEqual(ids(matchSessionTitles(list, "fle", title, 10)).sort(), ["a", "c"]);
  assert.deepEqual(ids(matchSessionTitles(list, "itter", title, 10)), []);
});

test("live chats rank before archived ones, most recent first, and the limit applies", () => {
  const list = [
    s("old", "Search UX", { lastActivityAt: 10 }),
    s("new", "Search UX v2", { lastActivityAt: 30 }),
    s("arch", "Search UX v0", { lastActivityAt: 50, archived: true }),
    s("child", "Search UX worker", { lastActivityAt: 60, parentSessionId: "new" }),
  ];
  assert.deepEqual(ids(matchSessionTitles(list, "search", title, 10)), ["new", "old", "arch"]);
  assert.deepEqual(ids(matchSessionTitles(list, "search", title, 2)), ["new", "old"]);
});

test("channel names match too", () => {
  const list = [s("a", null, { type: "channel", channelName: "qm-dev" })];
  assert.deepEqual(ids(matchSessionTitles(list, "qm-dev", title, 10)), ["a"]);
});
