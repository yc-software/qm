import "./support/auto-fake-sprites.ts";

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { createInsecureTestServer } from "../src/api/server.ts";
import { buildApp } from "../src/wiring.ts";
import { scopeId, type Session } from "../src/types.ts";
import { testConfig } from "./support/test-config.ts";

type Built = ReturnType<typeof buildApp>;

async function withServer(fn: (built: Built, get: (path: string) => Promise<unknown>) => Promise<void>): Promise<void> {
  const built = buildApp(testConfig({ dataDir: mkdtempSync(join(tmpdir(), "last-message-titles-")) }));
  const server = createInsecureTestServer(built.app, { sessions: built.sessions, featureFlags: built.featureFlags });
  server.listen(0);
  const base = `http://localhost:${(server.address() as AddressInfo).port}`;
  try {
    await fn(built, async (path) => {
      const res = await fetch(base + path);
      assert.equal(res.status, 200, path);
      return res.json();
    });
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await built.runtime.stop();
  }
}

async function chat(built: Built, threadRef: string, title: string, messages: string[]): Promise<Session> {
  const session = await built.sessions.getOrCreateByThread(threadRef, "dm", "personal:U1", undefined, "web");
  await built.sessions.addParticipant(session.id, "U1", title);
  for (const text of messages) {
    await built.sessions.append({ sessionId: session.id }, { kind: "UserMessage", text });
    await built.sessions.append({ sessionId: session.id }, { kind: "AgentMessage", text: "ok" });
  }
  return session;
}

type Page = { sessions: Session[]; pinned?: Session[] };

test("session rows carry no last message preview while the flag is off", async () => {
  await withServer(async (built, get) => {
    const talked = await chat(built, "web:U1:a", "Quarterly plan", ["first", "second"]);
    const page = (await get("/v1/sessions?principalId=U1")) as Page;
    const row = page.sessions.find((s) => s.id === talked.id);
    assert.ok(row);
    assert.equal("lastUserPreview" in row, false);
    const single = (await get(`/v1/sessions/row?principalId=U1&id=${talked.id}`)) as { session: Session };
    assert.equal("lastUserPreview" in single.session, false);
  });
});

test("flagged principals get each row's last user message, null when there is none", async () => {
  await withServer(async (built, get) => {
    await built.featureFlags.setEnabled("sidebar_last_message_titles", scopeId("personal", "U1"), true, "test");
    const talked = await chat(built, "web:U1:a", "Quarterly plan", [
      "draft the plan",
      "now   tighten\n\nthe intro please",
    ]);
    const pinned = await chat(built, "web:U1:p", "Pinned chat", ["pinned question"]);
    await built.sessions.updateParticipantView(pinned.id, "U1", { pinned: true });
    const empty = await chat(built, "web:U1:e", "Named but empty", []);
    const page = (await get("/v1/sessions?principalId=U1")) as Page;
    const byId = new Map([...page.sessions, ...(page.pinned ?? [])].map((s) => [s.id, s]));
    assert.equal(byId.get(talked.id)?.lastUserPreview, "now tighten the intro please");
    assert.equal(byId.get(talked.id)?.title, "Quarterly plan");
    assert.equal(byId.get(pinned.id)?.lastUserPreview, "pinned question");
    assert.equal(byId.get(empty.id)?.lastUserPreview, null);
    const single = (await get(`/v1/sessions/row?principalId=U1&id=${talked.id}`)) as { session: Session };
    assert.equal(single.session.lastUserPreview, "now tighten the intro please");
  });
});

test("the flag is per person", async () => {
  await withServer(async (built, get) => {
    await built.featureFlags.setEnabled("sidebar_last_message_titles", scopeId("personal", "U2"), true, "test");
    const talked = await chat(built, "web:U1:a", "Quarterly plan", ["draft the plan"]);
    const page = (await get("/v1/sessions?principalId=U1")) as Page;
    assert.equal("lastUserPreview" in (page.sessions.find((s) => s.id === talked.id) ?? {}), false);
  });
});
