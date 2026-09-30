import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import plugin from "../src/harness/opencode-plugin.ts";
import type { PluginInput, Hooks } from "@opencode-ai/plugin";

test("OpenCode plugin preserves model images while omitting their bytes from capture transport", async (t) => {
  const data = "iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAEklEQVR4nGP4zwAE/0Ho/38GAB7vBPzpVsU+AAAAAElFTkSuQmCC";
  const attachments = [{ type: "file", mime: "image/png", url: `data:image/png;base64,${data}` }];
  const previous = { url: process.env.OPENCODE_BRIDGE_URL, secret: process.env.OPENCODE_BRIDGE_SECRET };
  const server = createServer(async (req, res) => {
    assert.equal(req.headers.authorization, "Bearer test-secret");
    let request = "";
    for await (const chunk of req) request += chunk;
    if (req.url?.endsWith("/context")) {
      res.end(JSON.stringify({ systemPrompt: "Inspect the image." }));
      return;
    }
    if (req.url?.endsWith("/capture")) {
      assert.ok(Buffer.byteLength(request) < 16 * 1024 * 1024);
      const captured = JSON.parse(request);
      assert.equal(captured.system, "Inspect the image.");
      assert.equal(captured.messages[0].info.id, "user");
      assert.deepEqual(
        captured.messages[1].parts[0].state.attachments,
        Array.from({ length: 3 }, () => ({ type: "file", mime: "image/png", omitted: true })),
      );
      res.end(JSON.stringify({ ok: true }));
      return;
    }
    if (req.url !== "/definitions")
      assert.deepEqual(JSON.parse(request), {
        tool: "files",
        sessionID: "image-session",
        callID: "read-preview",
        args: { action: "read", path: "preview.png" },
      });
    res.setHeader("content-type", "application/json");
    res.end(
      JSON.stringify(
        req.url === "/definitions"
          ? [
              {
                name: "files",
                description: "Read workspace files.",
                parameters: {
                  type: "object",
                  properties: { action: { type: "string" }, path: { type: "string" } },
                  required: ["action", "path"],
                },
              },
            ]
          : { output: "[image: preview.png]", attachments },
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
  const files = hooks.tool!.files!;
  const result = await files.execute({ action: "read", path: "preview.png" }, {
    sessionID: "image-session",
    callID: "read-preview",
  } as unknown as Parameters<typeof files.execute>[1]);
  assert.deepEqual(result, { output: "[image: preview.png]", attachments });
  const largeAttachments = Array.from({ length: 3 }, () => ({
    type: "file",
    mime: "image/png",
    url: `data:image/png;base64,${"AAAA".repeat(1_500_000)}`,
  }));
  const output = {
    messages: [
      {
        info: { id: "user", role: "user", sessionID: "image-session" },
        parts: [{ type: "text", text: "Inspect images." }],
      },
      {
        info: { id: "assistant", role: "assistant", sessionID: "image-session" },
        parts: [{ type: "tool", state: { attachments: largeAttachments } }],
      },
    ],
  };
  await hooks["experimental.chat.messages.transform"]!(
    {},
    output as Parameters<NonNullable<Hooks["experimental.chat.messages.transform"]>>[1],
  );
  const imagePart = output.messages[1]!.parts[0]!;
  assert.ok("state" in imagePart);
  assert.equal(imagePart.state.attachments, largeAttachments);
  assert.ok(largeAttachments.every((attachment) => attachment.url.length > 6_000_000));
});

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
