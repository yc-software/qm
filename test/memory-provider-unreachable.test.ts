import "./support/auto-fake-sprites.ts";
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:net";
import type { AddressInfo } from "node:net";
import { buildApp } from "../src/wiring.ts";
import type { TurnRequest } from "../src/types.ts";
import { parseMemoryProviderConfig } from "../src/memory/provider-config.ts";
import { testConfig } from "./support/test-config.ts";

async function closedPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address() as AddressInfo;
  await new Promise<void>((r) => server.close(() => r()));
  return port;
}

test("wiring: an unreachable fail-open MCP memory provider still serves turns via the notebook floor", async () => {
  const url = `http://127.0.0.1:${await closedPort()}`;
  const memoryProviderConfig = parseMemoryProviderConfig(
    JSON.stringify({
      providers: [
        {
          id: "knowledge",
          type: "mcp",
          url,
          timeoutMs: 3000,
          read: { tool: "search_knowledge", clientIdEnv: "KNOWLEDGE_ID", clientSecretEnv: "KNOWLEDGE_SECRET" },
        },
      ],
      routes: [
        { provider: "default", scopes: ["personal"], capture: "automatic" },
        { provider: "knowledge", scopes: ["personal"], capture: "off", manage: false, label: "Knowledge" },
      ],
    }),
    { KNOWLEDGE_ID: "id", KNOWLEDGE_SECRET: "secret" },
  );
  assert.ok(memoryProviderConfig);
  const { app, runtime } = buildApp(
    testConfig({ dataDir: mkdtempSync(join(tmpdir(), "mem-unreachable-")), memoryProviderConfig }),
  );
  try {
    const actor = { externalId: "U1" };
    const dm = (text: string, thread: string): TurnRequest => ({
      surface: "test",
      actor,
      conversation: { kind: "dm", threadRef: thread },
      text,
    });
    assert.equal((await app.turn(dm("remember my X handle is be17832773", "dm:U1:tA"))).status, "ok");
    let reply = "";
    for (let i = 0; i < 100; i++) {
      const b = await app.turn(dm("!sysprompt", "dm:U1:tB"));
      assert.equal(b.status, "ok");
      reply = b.reply ?? "";
      if (/be17832773/.test(reply)) break;
      await new Promise((r) => setTimeout(r, 20));
    }
    assert.match(reply, /be17832773/);
  } finally {
    await runtime.stop();
  }
});
