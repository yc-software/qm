import "../support/auto-fake-sprites.ts";

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildApp } from "../../src/wiring.ts";
import { createInsecureTestServer } from "../../src/api/server.ts";
import { parseMemoryProviderConfig } from "../../src/memory/provider-config.ts";
import { testConfig } from "../support/test-config.ts";

const NO_KEY = !process.env.ANTHROPIC_API_KEY;

interface WriteCall {
  content: string;
  acting_user?: string;
}

describe("memory provider e2e (live Pi + stub MCP brain)", { skip: NO_KEY ? "set ANTHROPIC_API_KEY" : false }, () => {
  const facts: string[] = ["Josh's secret project codename is BLACKBEARD-42."];
  const writes: WriteCall[] = [];
  let tokenMints = 0;
  let brain: Server;
  let server: Server;
  let base: string;

  before(async () => {
    brain = createServer((req, res) => {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        if (req.url === "/token") {
          const params = new URLSearchParams(body);
          if (params.get("client_id") !== "brain-id" || params.get("client_secret") !== "brain-secret") {
            res.writeHead(401).end();
            return;
          }
          tokenMints++;
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({ access_token: "stub-token", expires_in: 3600 }));
          return;
        }
        if (req.url === "/mcp") {
          if (req.headers.authorization !== "Bearer stub-token") {
            res.writeHead(401).end();
            return;
          }
          const rpc = JSON.parse(body) as { id: number; method: string; params?: any };
          const reply = (result: unknown) => {
            res.writeHead(200, { "content-type": "application/json" });
            res.end(JSON.stringify({ jsonrpc: "2.0", id: rpc.id, result }));
          };
          if (rpc.method === "tools/call") {
            const { name, arguments: args } = rpc.params;
            if (name === "read_brain") {
              const q = String(args.query ?? "").toLowerCase();
              const hits = q
                ? facts.filter((f) => q.split(/\W+/).some((w) => w.length > 2 && f.toLowerCase().includes(w)))
                : facts;
              reply({ content: [{ type: "text", text: (hits.length ? hits : facts).join("\n") }] });
              return;
            }
            if (name === "write_brain") {
              writes.push({ content: String(args.content), acting_user: args.acting_user });
              facts.push(String(args.content));
              reply({ content: [{ type: "text", text: "stored" }] });
              return;
            }
          }
          reply({});
          return;
        }
        res.writeHead(404).end();
      });
    });
    await new Promise<void>((r) => brain.listen(0, r));
    const brainUrl = `http://127.0.0.1:${(brain.address() as AddressInfo).port}`;

    const providerJson = JSON.stringify({
      providers: [
        {
          id: "stub-brain",
          type: "mcp",
          url: brainUrl,
          timeoutMs: 5000,
          read: {
            tool: "read_brain",
            clientIdEnv: "BRAIN_ID",
            clientSecretEnv: "BRAIN_SECRET",
            actorArg: "acting_user",
          },
          write: {
            tool: "write_brain",
            clientIdEnv: "BRAIN_ID",
            clientSecretEnv: "BRAIN_SECRET",
            actorArg: "acting_user",
          },
        },
      ],
      routes: [
        { provider: "stub-brain", scopes: ["personal"], capture: "explicit", label: "Stub brain", failOpen: false },
      ],
    });
    const memoryProviderConfig = parseMemoryProviderConfig(providerJson, {
      BRAIN_ID: "brain-id",
      BRAIN_SECRET: "brain-secret",
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
    await new Promise<void>((r) => brain.close(() => r()));
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
    assert.ok(tokenMints >= 1, "client-credentials token should have been minted");
  });

  it("explicit remember writes through to the external provider", { timeout: 180_000 }, async () => {
    const r = await turn(
      "Use your memory tool with action remember to save exactly this fact: Josh's favorite anchor is HMS-OSPREY-7. Then confirm.",
      "t-write",
    );
    assert.equal(r.http, 200);
    const hit = writes.find((w) => w.content.includes("HMS-OSPREY-7"));
    assert.ok(hit, `write_brain should have received the fact; got: ${JSON.stringify(writes)}`);
    assert.equal(hit!.acting_user, "U1");
  });
});
