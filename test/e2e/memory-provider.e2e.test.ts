import "../support/auto-fake-sprites.ts";

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildApp } from "../../src/wiring.ts";
import { createInsecureTestServer } from "../../src/api/server.ts";
import { parseMemoryProviderConfig } from "../../src/memory/provider-config.ts";
import { testConfig } from "../support/test-config.ts";
import { startMcpTestServer, type McpTestServer } from "../support/mcp-test-server.ts";

const NO_KEY = !process.env.ANTHROPIC_API_KEY;

interface WriteCall {
  content: string;
  acting_user?: string;
}

describe("memory provider e2e (live Pi + stub MCP)", { skip: NO_KEY ? "set ANTHROPIC_API_KEY" : false }, () => {
  const facts: string[] = ["Josh's secret project codename is BLACKBEARD-42."];
  const writes: WriteCall[] = [];
  let knowledge: McpTestServer;
  const closeKnowledge: Array<() => Promise<void>> = [];
  let server: Server;
  let base: string;

  before(async () => {
    knowledge = await startMcpTestServer(
      { after: (fn) => void closeKnowledge.push(fn) },
      {
        tools: ["search_knowledge", "write_knowledge"].map((name) => ({
          name,
          inputSchema: { type: "object" as const },
        })),
        clients: { "knowledge-id": "knowledge-secret" },
        call: (name, args) => {
          if (name === "write_knowledge") {
            writes.push({ content: String(args.content), acting_user: args.acting_user as string | undefined });
            facts.push(String(args.content));
            return { content: [{ type: "text", text: "stored" }] };
          }
          const q = String(args.query ?? "").toLowerCase();
          const hits = q
            ? facts.filter((f) => q.split(/\W+/).some((w) => w.length > 2 && f.toLowerCase().includes(w)))
            : facts;
          return { content: [{ type: "text", text: (hits.length ? hits : facts).join("\n") }] };
        },
      },
    );
    const knowledgeUrl = knowledge.url;

    const providerJson = JSON.stringify({
      providers: [
        {
          id: "stub-knowledge",
          type: "mcp",
          url: knowledgeUrl,
          timeoutMs: 5000,
          read: {
            tool: "search_knowledge",
            clientIdEnv: "KNOWLEDGE_ID",
            clientSecretEnv: "KNOWLEDGE_SECRET",
            actorArg: "acting_user",
          },
          write: {
            tool: "write_knowledge",
            clientIdEnv: "KNOWLEDGE_ID",
            clientSecretEnv: "KNOWLEDGE_SECRET",
            actorArg: "acting_user",
          },
        },
      ],
      routes: [
        {
          provider: "stub-knowledge",
          scopes: ["personal"],
          capture: "explicit",
          label: "Stub knowledge",
          failOpen: false,
        },
      ],
    });
    const memoryProviderConfig = parseMemoryProviderConfig(providerJson, {
      KNOWLEDGE_ID: "knowledge-id",
      KNOWLEDGE_SECRET: "knowledge-secret",
    });
    assert.ok(memoryProviderConfig, "provider config should parse");

    const built = buildApp(
      testConfig({
        dataDir: mkdtempSync(join(tmpdir(), "mem-e2e-")),
        harness: "pi",
        memoryProviderConfig,
        ...(process.env.PI_MODEL ? { modelId: process.env.PI_MODEL } : {}),
        ...(process.env.ANTHROPIC_API_KEY ? { anthropicApiKey: process.env.ANTHROPIC_API_KEY } : {}),
      }),
    );
    server = createInsecureTestServer(built.app);
    await new Promise<void>((r) => server.listen(0, r));
    base = `http://localhost:${(server.address() as AddressInfo).port}`;
  });

  after(async () => {
    await new Promise<void>((r) => server.close(() => r()));
    await Promise.all(closeKnowledge.map((close) => close()));
  });

  async function turn(text: string, threadRef: string): Promise<{ http: number; json: any }> {
    const res = await fetch(`${base}/v1/turns`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        surface: "http-e2e",
        actor: { externalId: "U1" },
        conversation: { kind: "dm", threadRef },
        text,
      }),
    });
    return { http: res.status, json: await res.json() };
  }

  it("recalls a fact that only exists in the external provider", { timeout: 180_000 }, async () => {
    const r = await turn("What is my secret project codename? Answer with just the codename.", "t-recall");
    assert.equal(r.http, 200);
    assert.equal(r.json.status, "ok");
    assert.match(r.json.reply, /BLACKBEARD-42/i);
    assert.ok(knowledge.tokenRequests.length >= 1, "client-credentials token should have been minted");
  });

  it("explicit remember writes through to the external provider", { timeout: 180_000 }, async () => {
    const r = await turn(
      "Use your memory tool with action remember to save exactly this fact: Josh's favorite anchor is HMS-OSPREY-7. Then confirm.",
      "t-write",
    );
    assert.equal(r.http, 200);
    const hit = writes.find((w) => w.content.includes("HMS-OSPREY-7"));
    assert.ok(hit, `write_knowledge should have received the fact; got: ${JSON.stringify(writes)}`);
    assert.equal(hit!.acting_user, "U1");
  });
});
