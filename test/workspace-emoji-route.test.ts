import assert from "node:assert/strict";
import test from "node:test";
import { listWorkspaceEmoji } from "../src/api/routes/emoji.ts";
import type { ApiCtx } from "../src/api/routes/route.ts";

test("workspace emoji requires a browser identity and preserves Slack aliases without exposing credentials", async () => {
  let calls = 0;
  const catalog = { party_blob: "https://emoji.slack-edge.com/test/blob.gif", yay: "alias:party_blob" };
  async function invoke(actor: unknown, capability?: unknown) {
    let status = 0;
    let body = "";
    await listWorkspaceEmoji({
      actor,
      capability,
      deps: {
        slackEnvBotToken: "test-bot-secret",
        slackWebClient: (token: string) => ({
          async apiCall(method: string) {
            calls++;
            assert.equal(token, "test-bot-secret");
            assert.equal(method, "emoji.list");
            return { ok: true, emoji: catalog };
          },
        }),
      },
      res: {
        setHeader() {},
        getHeader() {},
        writeHead(code: number) {
          status = code;
        },
        end(text: string) {
          body = text;
        },
      },
    } as unknown as ApiCtx);
    return { status, body };
  }
  assert.equal((await invoke(null)).status, 403);
  assert.equal((await invoke({ p: "alice", imp: "admin" })).status, 403);
  assert.equal((await invoke({ p: "alice" }, { actorId: "alice" })).status, 403);
  assert.equal(calls, 0);
  const result = await invoke({ p: "alice" });
  assert.equal(result.status, 200);
  assert.deepEqual(JSON.parse(result.body), { emoji: catalog });
  assert.ok(!result.body.includes("test-bot-secret"));
});
