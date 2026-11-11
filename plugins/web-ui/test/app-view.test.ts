import { item } from "./item-fixture.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
import { APP_SCREENSHOT_TOOL, createAppViewExecutor, shotResult } from "../src/app-view.ts";

const call = (id: string, tool = APP_SCREENSHOT_TOOL) => ({
  item: item("ToolCall", { createdAt: Date.now(), tool, callId: id, body: { client: true, args: {} } }),
});

test("answers each screenshot call once and ignores other tools and finished calls", async () => {
  let shots = 0;
  const sent: string[] = [];
  const execute = createAppViewExecutor(
    async () => {
      shots++;
      return { content: "ok" };
    },
    async (id) => {
      sent.push(id);
    },
  );
  const done = { item: item("ToolResult", { createdAt: Date.now(), callId: "old", body: {} }) };
  const run = { status: "running", alive: true, activity: [call("a"), call("b", "desktop"), call("old"), done] };
  await execute(run);
  await execute(run);
  await execute({ ...run, status: "done" });
  assert.deepEqual(sent, ["a"]);
  assert.equal(shots, 1);
});

test("a failed or imageless capture becomes an error, never an empty picture", () => {
  assert.deepEqual(shotResult({ ok: false, error: "the app tab is hidden" }), {
    content: "Screenshot failed: the app tab is hidden",
    isError: true,
  });
  assert.equal(shotResult({ ok: true }).isError, true);
});

test("a capture carries the picture and the facts a picture cannot show", () => {
  const result = shotResult({
    ok: true,
    image: "aGk=",
    mimeType: "image/jpeg",
    url: "https://x.example/",
    width: 800,
    height: 600,
    dark: true,
    consoleErrors: ["boom"],
  });
  assert.deepEqual(result.images, [{ data: "aGk=", mimeType: "image/jpeg" }]);
  assert.match(result.content, /Viewport: 800×600/);
  assert.match(result.content, /Color scheme: dark/);
  assert.match(result.content, /boom/);
});
