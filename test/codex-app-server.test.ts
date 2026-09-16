import test from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CodexAppServer } from "../src/harness/codex-app-server.ts";

const cases = [
  { name: "U+2028 inside strings", text: "before\u2028after", ending: "\n", fragmented: false },
  { name: "U+2029 inside strings", text: "before\u2029after", ending: "\n", fragmented: false },
  { name: "split UTF-8 and CRLF frames", text: '界🙂\u2028\u2029\n\r\\quoted"', ending: "\r\n", fragmented: true },
  { name: "an unterminated final frame at EOF", text: "before\u2028after", ending: "", fragmented: true },
];

for (const { name, text, ending, fragmented } of cases) {
  test(`Codex JSON-RPC preserves ${name}`, async (t) => {
    const dir = mkdtempSync(join(tmpdir(), "qm-codex-framing-"));
    const binary = join(dir, "codex");
    writeFileSync(
      binary,
      `#!${process.execPath}
const readline = require("node:readline");
readline.createInterface({ input: process.stdin }).on("line", line => {
  const request = JSON.parse(line);
  const text = ${JSON.stringify(text)};
  const data = Buffer.from(
    JSON.stringify({ method: "rawResponseItem/completed", params: { output: text } }) + "\\n" +
    JSON.stringify({ id: request.id, result: { text } }) + ${JSON.stringify(ending)}
  );
  const split = ${fragmented} ? data.indexOf(Buffer.from(JSON.stringify(text).slice(1, -1))) + 1 : data.length;
  process.stdout.write(data.subarray(0, split));
  setTimeout(() => {
    process.stdout.write(data.subarray(split));
    if (${ending === ""}) process.stdout.end();
  }, 20);
});
`,
    );
    chmodSync(binary, 0o755);
    const notifications: unknown[] = [];
    const server: CodexAppServer = new CodexAppServer({
      binaryPath: binary,
      cwd: dir,
      onNotification: (_method, params) => {
        notifications.push(params);
      },
      onRequest: async () => ({}),
    });
    t.after(async () => {
      await server.close();
      rmSync(dir, { recursive: true, force: true });
    });
    assert.deepEqual(await server.request("test"), { text });
    assert.deepEqual(notifications, [{ output: text }]);
    if (ending) assert.deepEqual(await server.request("test"), { text });
    assert.equal(server.error(), null);
  });
}

test("a waiting tool cannot block another thread's RPC response or tool call", { timeout: 5000 }, async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "qm-codex-wait-"));
  const binary = join(dir, "codex");
  writeFileSync(
    binary,
    `#!${process.execPath}
const readline = require("node:readline");
const send = value => process.stdout.write(JSON.stringify(value) + "\\n");
readline.createInterface({ input: process.stdin }).on("line", line => {
  const message = JSON.parse(line);
  if (message.method === "start") {
    send({ id: message.id, result: {} });
    send({ id: "parent-wait", method: "item/tool/call", params: { threadId: "parent" } });
  } else if (message.method === "child/start") {
    send({ method: "child/started", params: {} });
    send({ id: message.id, result: { started: true } });
    send({ id: "child-message", method: "item/tool/call", params: { threadId: "child" } });
  } else if (message.id === "parent-wait") {
    send({ method: "parent/completed", params: message.result });
  }
});
`,
  );
  chmodSync(binary, 0o755);
  const childMessage = Promise.withResolvers<void>();
  const parentCompleted = Promise.withResolvers<unknown>();
  const notifications: string[] = [];
  const server: CodexAppServer = new CodexAppServer({
    binaryPath: binary,
    cwd: dir,
    onNotification: (method, params) => {
      notifications.push(method);
      if (method === "parent/completed") parentCompleted.resolve(params);
    },
    onRequest: async (_method, params) => {
      if ((params as { threadId: string }).threadId === "child") {
        childMessage.resolve();
        return {};
      }
      const started = await server.request("child/start");
      await childMessage.promise;
      return started;
    },
  });
  t.after(async () => {
    await server.close();
    rmSync(dir, { recursive: true, force: true });
  });
  await server.request("start");
  assert.deepEqual(await parentCompleted.promise, { started: true });
  assert.deepEqual(notifications, ["child/started", "parent/completed"]);
});
