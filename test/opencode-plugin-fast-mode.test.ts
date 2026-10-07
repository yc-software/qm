import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import plugin from "../src/harness/opencode-plugin.ts";
import type { PluginInput, Hooks } from "@opencode-ai/plugin";

test("OpenCode plugin applies session-local fast options to the actual requested model", async (t) => {
  const previous = { url: process.env.OPENCODE_BRIDGE_URL, secret: process.env.OPENCODE_BRIDGE_SECRET };
  const requests: string[] = [];
  const server = createServer((req, res) => {
    assert.equal(req.headers.authorization, "Bearer test-secret");
    requests.push(req.url!);
    res.setHeader("content-type", "application/json");
    res.end(
      JSON.stringify(
        req.url === "/definitions"
          ? []
          : {
              modelOptions: req.url?.includes("/fast/") ? { serviceTier: "priority" } : {},
            },
      ),
    );
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  process.env.OPENCODE_BRIDGE_URL = `http://127.0.0.1:${address.port}`;
  process.env.OPENCODE_BRIDGE_SECRET = "test-secret";
  t.after(async () => {
    for (const [key, value] of [
      ["OPENCODE_BRIDGE_URL", previous.url],
      ["OPENCODE_BRIDGE_SECRET", previous.secret],
    ]) {
      if (value === undefined) delete process.env[key!];
      else process.env[key!] = value;
    }
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  const hooks = await plugin({ client: {} } as PluginInput);
  const input = (sessionID: string) =>
    ({ sessionID, model: { id: "gpt/alias" } }) as Parameters<NonNullable<Hooks["chat.params"]>>[0];
  const output = () => ({
    temperature: 0,
    topP: 1,
    topK: 1,
    maxOutputTokens: undefined,
    options: { reasoningEffort: "high" },
  });
  const fast = output();
  const standard = output();
  await Promise.all([hooks["chat.params"]!(input("fast"), fast), hooks["chat.params"]!(input("standard"), standard)]);
  assert.deepEqual(fast.options, { reasoningEffort: "high", serviceTier: "priority" });
  assert.deepEqual(standard.options, { reasoningEffort: "high" });
  assert.ok(requests.includes("/session/fast/context?model=gpt%2Falias"));
  assert.ok(requests.includes("/session/standard/context?model=gpt%2Falias"));
});
