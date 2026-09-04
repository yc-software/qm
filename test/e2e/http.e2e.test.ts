import "../support/auto-fake-sprites.ts";

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildApp } from "../../src/wiring.ts";
import { createInsecureTestServer } from "../../src/api/server.ts";
import { scopeId } from "../../src/types.ts";
import { testConfig } from "../support/test-config.ts";

const NO_KEY = !process.env.ANTHROPIC_API_KEY;

describe("HTTP e2e (live Pi over the API)", { skip: NO_KEY ? "set ANTHROPIC_API_KEY" : false }, () => {
  let server: Server;
  let base: string;

  before(async () => {
    const built = buildApp(
      testConfig({
        dataDir: mkdtempSync(join(tmpdir(), "http-e2e-")),
        harness: "pi",
        ...(process.env.PI_MODEL ? { modelId: process.env.PI_MODEL } : {}),
        ...(process.env.ANTHROPIC_API_KEY ? { anthropicApiKey: process.env.ANTHROPIC_API_KEY } : {}),
      }),
    );
    built.config.setSoul(scopeId("personal", "U1"), "CRITICAL: end every reply with the exact token ZZQ9.");
    server = createInsecureTestServer(built.app);
    await new Promise<void>((resolve) => server.listen(0, resolve));
    base = `http://localhost:${(server.address() as AddressInfo).port}`;
  });

  after(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  async function turn(body: unknown): Promise<{ http: number; json: any }> {
    const res = await fetch(`${base}/v1/turns`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    return { http: res.status, json: await res.json() };
  }

  const actor = { externalId: "U1" };
  const dm = (text: string, threadRef = "t1") => ({
    surface: "http-e2e",
    actor,
    conversation: { kind: "dm", threadRef },
    text,
  });

  it("generation over HTTP", { timeout: 120_000 }, async () => {
    const r = await turn(dm("Reply with exactly the single word: PONG"));
    assert.equal(r.http, 200);
    assert.equal(r.json.status, "ok");
    assert.match(r.json.reply, /PONG/i);
  });

  it("execute tool over HTTP (real sandbox)", { timeout: 120_000 }, async () => {
    const r = await turn(
      dm("Use your execute tool to run `echo hello-over-http`, then tell me exactly what it printed."),
    );
    assert.equal(r.http, 200);
    assert.match(r.json.reply, /hello-over-http/);
  });

  it("write+read tools over HTTP (workspace)", { timeout: 120_000 }, async () => {
    const r = await turn(
      dm(
        "Use the write tool to create note.txt containing exactly: pi over http works. " +
          "Then read it back with the read tool and tell me the contents.",
      ),
    );
    assert.equal(r.http, 200);
    assert.match(r.json.reply, /pi over http works/i);
  });

  it("multi-turn memory over HTTP", { timeout: 120_000 }, async () => {
    const a = await turn(dm("My favorite color is teal. Remember it.", "mem"));
    assert.equal(a.json.status, "ok");
    const b = await turn(dm("What is my favorite color? One word.", "mem"));
    assert.match(b.json.reply, /teal/i);
  });

  it("session log is readable over HTTP (GET /v1/sessions/:id)", { timeout: 120_000 }, async () => {
    const t = await turn(dm("Say hi in one word.", "log"));
    const sid = t.json.sessionId as string;
    const res = await fetch(`${base}/v1/sessions/${encodeURIComponent(sid)}?viewer=U1`, {
      headers: { "X-Actor": "U1@default-org" },
    });
    assert.equal(res.status, 200);
    const body = (await res.json()) as { entries: Array<{ type: string }> };
    const types = body.entries.map((e) => e.type);
    assert.ok(types.includes("user"));
    assert.ok(types.includes("assistant"));
  });

  it("the composed SOUL is the real system prompt (model obeys personal SOUL)", { timeout: 120_000 }, async () => {
    const r = await turn(dm("What is 2 + 2? Answer briefly.", "soul"));
    assert.equal(r.json.status, "ok");
    assert.match(r.json.reply, /4/);
    assert.match(r.json.reply, /ZZQ9/);
  });

  it("internal-only refuses a guest over HTTP (403)", { timeout: 30_000 }, async () => {
    const r = await turn({
      surface: "http-e2e",
      actor: { externalId: "G1", isExternalGuest: true },
      conversation: { kind: "dm", threadRef: "g1" },
      text: "hello",
    });
    assert.equal(r.http, 403);
    assert.equal(r.json.status, "refused");
  });
});
