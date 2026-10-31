import "./support/auto-fake-sprites.ts";

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { createInsecureTestServer } from "../src/api/server.ts";
import { buildApp } from "../src/wiring.ts";
import type { Principal, Session } from "../src/types.ts";
import type { OrchestratorInput } from "../src/core/orchestrator.ts";
import { testConfig } from "./support/test-config.ts";

type Page = { sessions: Session[]; pinned?: Session[]; nextCursor: string | null; hasArchived?: boolean };

async function withServer<T>(
  fn: (
    built: ReturnType<typeof buildApp>,
    get: (path: string) => Promise<{ status: number; body: unknown }>,
  ) => Promise<T>,
): Promise<T> {
  const built = buildApp(testConfig({ dataDir: mkdtempSync(join(tmpdir(), "paging-")) }));
  const server = createInsecureTestServer(built.app);
  server.listen(0);
  const base = `http://localhost:${(server.address() as AddressInfo).port}`;
  try {
    return await fn(built, async (path) => {
      const res = await fetch(base + path);
      return { status: res.status, body: await res.json() };
    });
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await built.runtime.stop();
  }
}

async function chat(built: ReturnType<typeof buildApp>, threadRef: string, title: string, owner = "U1") {
  const session = await built.sessions.getOrCreateByThread(threadRef, "dm", `personal:${owner}`, undefined, "web");
  await built.sessions.addParticipant(session.id, owner, title);
  return session;
}

function enqueueRequest(threadRef: string): OrchestratorInput {
  const principal: Principal = { id: "internal:U1", type: "internal" };
  return {
    actor: principal,
    conversation: { kind: "dm", threadRef, audience: [principal] },
    origin: { kind: "direct" },
    text: "working",
  };
}

test("the session list pages top-level chats newest first and keeps pinned, archived, children and automation runs out", async () => {
  await withServer(async (built, get) => {
    const chats = [];
    for (let i = 0; i < 5; i++) chats.push(await chat(built, `web:U1:c${i}`, `Chat ${i}`));
    const pinned = await chat(built, "web:U1:pinned", "Pinned");
    await built.sessions.updateParticipantView(pinned.id, "U1", { pinned: true });
    const archived = await chat(built, "web:U1:archived", "Archived");
    await built.sessions.updateParticipantView(archived.id, "U1", { archived: true });
    const child = await chat(built, "subagent:c0:1", "Child");
    await built.sessions.setParentSession(child.id, chats[0]!.id);
    const cron = await built.sessions.getOrCreateByThread("cron:job:1", "dm", "personal:U1", undefined, "cron");
    await built.sessions.addParticipant(cron.id, "U1", "Cron run");
    await chat(built, "web:U2:theirs", "Someone else's", "U2");

    const seen: Session[] = [];
    let page = (await get("/v1/sessions?principalId=U1&limit=2")).body as Page;
    assert.deepEqual(
      page.pinned?.map((s) => s.id),
      [pinned.id],
    );
    assert.equal(page.hasArchived, true);
    seen.push(...page.sessions);
    for (let guard = 0; page.nextCursor && guard < 5; guard++) {
      page = (await get(`/v1/sessions?principalId=U1&limit=2&before=${encodeURIComponent(page.nextCursor)}`))
        .body as Page;
      assert.equal(page.pinned, undefined, "only the first page carries pinned chats");
      seen.push(...page.sessions);
    }
    assert.equal(page.nextCursor, null);
    assert.deepEqual(
      seen.map((s) => s.id).sort(),
      chats.map((s) => s.id).sort(),
      "every top-level chat once; no pinned, archived, child, automation or foreign rows",
    );
    const activity = seen.map((s) => s.lastActivityAt ?? s.createdAt);
    assert.deepEqual(
      activity,
      [...activity].sort((a, b) => b - a),
    );
    for (const row of seen) assert.equal("hasEntries" in row, false);

    const archivedPage = (await get("/v1/sessions?principalId=U1&status=archived")).body as Page;
    assert.deepEqual(
      archivedPage.sessions.map((s) => s.id),
      [archived.id],
    );
    assert.equal((await get("/v1/sessions?principalId=U1&before=nonsense")).status, 400);
    assert.equal((await get("/v1/sessions?principalId=U1&status=deleted")).status, 400);
  });
});

test("a parent row counts its running subagents and its children load on demand", async () => {
  await withServer(async (built, get) => {
    const parent = await chat(built, "web:U1:parent", "Parent");
    const child = await chat(built, "subagent:parent:1", "Researcher");
    await built.sessions.setParentSession(child.id, parent.id);
    const grandchild = await chat(built, "subagent:child:1", "Helper");
    await built.sessions.setParentSession(grandchild.id, child.id);
    await built.runs.enqueue({ sessionId: grandchild.threadRef, request: enqueueRequest(grandchild.threadRef) });

    const page = (await get("/v1/sessions?principalId=U1")).body as Page;
    const row = page.sessions.find((s) => s.id === parent.id);
    assert.equal(row?.working, true);
    assert.deepEqual(row?.subagents, { running: 2, waiting: 0 }, "the child is working on behalf of its child");

    const children = (await get(`/v1/sessions/${parent.id}/children?principalId=U1`)).body as { sessions: Session[] };
    assert.deepEqual(children.sessions.map((s) => s.id).sort(), [child.id, grandchild.id].sort());
    assert.equal(children.sessions.find((s) => s.id === grandchild.id)?.working, true);
    assert.deepEqual(
      children.sessions.find((s) => s.id === child.id)?.subagents,
      { running: 1, waiting: 0 },
      "a subagent row counts its own subagents",
    );
    const childRow = (await get(`/v1/sessions/row?id=${child.id}&principalId=U1`)).body as { session: Session };
    assert.deepEqual(childRow.session.subagents, { running: 1, waiting: 0 });
    assert.equal((await get(`/v1/sessions/${parent.id}/children?principalId=U2`)).status, 404);
  });
});

test("one row can be looked up by id or thread, and only by someone who can see it", async () => {
  await withServer(async (built, get) => {
    const session = await chat(built, "web:U1:inbox", "Inbox");
    const byThread = (await get("/v1/sessions/row?principalId=U1&threadRef=web%3AU1%3Ainbox")).body as {
      session: Session;
    };
    assert.equal(byThread.session.id, session.id);
    assert.equal(byThread.session.canContinue, true);
    const byId = (await get(`/v1/sessions/row?principalId=U1&id=${session.id}`)).body as { session: Session };
    assert.equal(byId.session.threadRef, "web:U1:inbox");
    assert.equal("spawnMeta" in byId.session, false);
    assert.equal((await get(`/v1/sessions/row?principalId=U2&id=${session.id}`)).status, 404);
    assert.equal((await get("/v1/sessions/row?principalId=U1")).status, 400);
  });
});
