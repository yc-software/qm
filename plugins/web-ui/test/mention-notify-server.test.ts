import { test, after } from "node:test";
import assert from "node:assert/strict";
import { createServer, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";

const core = createServer((req: IncomingMessage, res) => {
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify({ projects: [] }));
});
await new Promise<void>((resolve) => core.listen(0, resolve));
after(() => new Promise<void>((resolve) => core.close(() => resolve())));

process.env.CORE_API_URL = `http://localhost:${(core.address() as AddressInfo).port}`;
process.env.CORE_SIGNING_SECRET = "mention-notify-test";
process.env.WEB_UI_PRINCIPALS = "alice";

const { matchMentionMembers } = await import("../server/index.ts");

const members = [
  { principalId: "alice", displayName: "Alice" },
  { principalId: "dan", displayName: "Dan" },
  { principalId: "daniel", displayName: "Daniel" },
  { principalId: "lisi", displayName: "李四" },
  { principalId: "amy", displayName: "Amy" },
];

test("matchMentionMembers resolves an exact display name", () => {
  assert.deepEqual(matchMentionMembers(["daniel"], members, "alice"), ["daniel"]);
});

test("a trailing sentence period is stripped before matching", () => {
  assert.deepEqual(matchMentionMembers(["alice."], members, "dan"), ["alice"]);
});

test("a longer ascii name does not notify its shorter prefix namesake", () => {
  assert.deepEqual(matchMentionMembers(["daniel"], members, "dan"), ["daniel"]);
  assert.deepEqual(matchMentionMembers(["daniela"], [{ principalId: "x", displayName: "Dan" }, ...members.slice(1)], "alice"), []);
});

test("a CJK run-on token still notifies the embedded name", () => {
  assert.deepEqual(matchMentionMembers(["李四看一下"], members, "alice"), ["lisi"]);
});

test("the sender is never notified by their own mention", () => {
  assert.deepEqual(matchMentionMembers(["alice"], members, "alice"), []);
});

test("duplicate tokens notify a member once", () => {
  assert.deepEqual(matchMentionMembers(["amy", "amy."], members, "alice"), ["amy"]);
});
