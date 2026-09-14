import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { sessionCwdPath, withoutVolatileContext } from "../src/harness/pi-harness.ts";

test("the cwd pi appends to the system prompt is the same path on every turn of a session", () => {
  const a = sessionCwdPath("pi", "9fd79b52-af00-4ea6-a38f-a363016c32ac");
  assert.equal(a, sessionCwdPath("pi", "9fd79b52-af00-4ea6-a38f-a363016c32ac"));
  assert.equal(a, join(tmpdir(), "pi-cwd-9fd79b52-af00-4ea6-a38f-a363016c32ac"));
  assert.notEqual(a, sessionCwdPath("pi", "other"));
  assert.equal(sessionCwdPath("pi", "web:a@b.c/../x"), join(tmpdir(), "pi-cwd-web_a_b_c____x"));
});

const durable = "what's on today?\n\n<environment>\nThis message is from @alice.\n</environment>";
const volatile = "<environment>\n## The user's local time\nMonday 9am\n</environment>";
const sent = `${durable}\n\n${volatile}`;

test("the taped trigger message keeps the durable note and drops the volatile one", () => {
  assert.deepEqual(withoutVolatileContext({ role: "user", content: sent }, sent, durable), {
    role: "user",
    content: durable,
  });
  const image = { type: "image", data: "abc", mimeType: "image/png" };
  assert.deepEqual(
    withoutVolatileContext({ role: "user", content: [{ type: "text", text: sent }, image] }, sent, durable),
    { role: "user", content: [{ type: "text", text: durable }, image] },
  );
});

test("messages that are not the trigger text pass through by reference", () => {
  const other = { role: "user", content: "steer: stop" };
  assert.equal(withoutVolatileContext(other, sent, durable), other);
  const noVolatile = { role: "user", content: durable };
  assert.equal(withoutVolatileContext(noVolatile, durable, durable), noVolatile);
});
