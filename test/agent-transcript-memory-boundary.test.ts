import "./support/auto-fake-sprites.ts";
import { test } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { createServer } from "../src/api/server.ts";
import { buildApp } from "../src/wiring.ts";
import { testConfig } from "./support/test-config.ts";
import { mintCapabilityToken, CONTROL_PLANE_AUD } from "../src/auth/capability-token.ts";
import { signedRequestHeaders } from "../src/auth/source-auth-sign.ts";
import { buildMemoryContextSnapshot, memoryContextFingerprint } from "../src/memory/context-boundary.ts";
import type { MemoryRecords } from "../src/memory/records.ts";
import type { MemoryService } from "../src/memory/memory-service.ts";
import type { Principal } from "../src/types.ts";

const SECRET = "synthetic-transcript-boundary-secret";
const HOME = "personal:alice";
const ROOM = "group:room";

async function fixture() {
  const built = buildApp(testConfig({ signingSecret: SECRET }));
  let audience: Principal[] = [
    { id: "alice", type: "internal" },
    { id: "bob", type: "internal" },
  ];
  let records: MemoryRecords = {
    version: 1,
    records: [
      {
        id: "fact",
        text: "- PRIVATE_SENTINEL",
        sensitivity: "ordinary",
        sources: [{ scopeId: HOME }],
        sourceUnknown: false,
      },
    ],
  };
  const head = () => ({ content: records.records.map((record) => record.text).join("\n"), revision: "r", records });
  const memory: MemoryService = {
    readHead: async () => head(),
    read: async () => head().content,
    query: async () => [],
    recall: async () => "",
    capture: async () => 0,
    replace: async () => {},
  };
  await built.app.upsertGroups([
    { groupId: "room", principalId: "alice" },
    { groupId: "room", principalId: "bob" },
  ]);
  await built.config.setSharingPosture("org:default-org", "open");
  await built.config.setSharingPosture(HOME, "open");
  await built.config.setSharingPosture(ROOM, "open");
  const session = await built.sessions.getOrCreateByThread("synthetic-room", "group", ROOM);
  await built.sessions.addParticipant(session.id, "alice");
  const { lease } = await built.sessions.acquireLease(session.id, "turn");
  assert.ok(lease);
  const append = (type: "user" | "assistant" | "system", payload: unknown) =>
    built.sessions.append(lease, {
      type,
      payload,
      scopeLabel: ROOM,
    });
  const snapshot = () =>
    buildMemoryContextSnapshot({ actorId: "alice", audience, posture: "open", heads: [{ scope: HOME, head: head() }] });
  const checkpoint = async (throughSeq = -1) => {
    const current = snapshot();
    return append("system", {
      kind: "memory_context",
      snapshot: current,
      fingerprint: memoryContextFingerprint(current),
      throughSeq,
    });
  };
  const server = createServer(
    {
      ...built.app,
      currentScopeMembers: async () => audience,
      isCurrentSharedScopeMember: async (id, scope) => scope === ROOM && audience.some((person) => person.id === id),
    },
    {
      signingSecret: SECRET,
      sessions: built.sessions,
      memory,
      config: built.config,
    },
  );
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const base = `http://localhost:${(server.address() as AddressInfo).port}`;
  const token = await mintCapabilityToken(
    {
      actorId: "alice",
      scopeId: ROOM,
      sessionId: session.id,
      members: audience,
      liveActor: true,
      aud: CONTROL_PLANE_AUD,
      exp: Date.now() + 60_000,
      memory: { read: [HOME], write: HOME },
    },
    SECRET,
  );
  return {
    built,
    session,
    append,
    checkpoint,
    setRecords: (next: MemoryRecords) => {
      records = next;
    },
    records: () => records,
    setAudience: (next: Principal[]) => {
      audience = next;
    },
    get: (query = "") =>
      fetch(`${base}/v1/conversations/${session.id}${query}`, { headers: { "x-agent-capability": token } }),
    list: () => fetch(`${base}/v1/conversations`, { headers: { "x-agent-capability": token } }),
    post: (suffix: string, body: unknown = {}) =>
      fetch(`${base}/v1/conversations/${session.id}${suffix}`, {
        method: "POST",
        headers: { "x-agent-capability": token, "content-type": "application/json" },
        body: JSON.stringify(body),
      }),
    memoryRead: () => fetch(`${base}/v1/memory/self`, { headers: { "x-agent-capability": token } }),
    human: () => {
      const path = `/v1/sessions/${session.id}?viewer=alice`;
      return fetch(`${base}${path}`, { headers: signedRequestHeaders(SECRET, "GET", path, "") });
    },
    close: async () => {
      await built.sessions.releaseLease(lease);
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

for (const change of ["remove", "reclassify", "posture", "audience"] as const) {
  test(`agent transcript rejects an idle target after ${change}, while human transcript remains available`, async () => {
    const f = await fixture();
    try {
      await f.checkpoint();
      await f.append("assistant", { text: "PRIVATE_SENTINEL" });
      assert.equal((await f.get()).status, 200);
      if (change === "remove") f.setRecords({ version: 1, records: [] });
      if (change === "reclassify")
        f.setRecords({ version: 1, records: f.records().records.map((r) => ({ ...r, sensitivity: "restricted" })) });
      if (change === "posture") await f.built.config.setSharingPosture(HOME, "isolated");
      if (change === "audience")
        f.setAudience([
          { id: "alice", type: "internal" },
          { id: "eve", type: "internal" },
        ]);
      const response = await f.get();
      assert.equal(response.status, 403);
      assert.deepEqual(await response.json(), { error: "forbidden" });
      const human = await f.human();
      assert.equal(human.status, 200);
      assert.match(await human.text(), /PRIVATE_SENTINEL/);
    } finally {
      await f.close();
    }
  });
}

test("agent transcript fails closed for an unknown checkpoint", async () => {
  const f = await fixture();
  try {
    await f.append("assistant", { text: "PRIVATE_SENTINEL" });
    const response = await f.get();
    assert.equal(response.status, 403);
    assert.deepEqual(await response.json(), { error: "forbidden" });
  } finally {
    await f.close();
  }
});

test("agent transcript enforces durable cutoff through old pages, pins and metadata", async () => {
  const f = await fixture();
  try {
    await f.checkpoint();
    const old = await f.append("assistant", { text: "PRIVATE_SENTINEL" });
    await f.built.sessions.addPin(f.session.id, { addedBy: "alice", text: "PRIVATE_SENTINEL" });
    await f.built.sessions.updateTitle(f.session.id, "PRIVATE_SENTINEL");
    await f.built.sessions.updateStatus(f.session.id, { emoji: "✅", text: "PRIVATE_SENTINEL" });
    f.setRecords({ version: 1, records: [] });
    await f.checkpoint(old.seq);
    await f.append("user", { text: "new question" });
    await f.append("assistant", { text: "SAFE_REPLY" });
    const response = await f.get();
    assert.equal(response.status, 200);
    const text = await response.text();
    assert.match(text, /SAFE_REPLY/);
    assert.doesNotMatch(text, /PRIVATE_SENTINEL|memory_context|earlierEntries/);
    const oldPage = await f.get(`?beforeSeq=${old.seq + 1}`);
    assert.equal(oldPage.status, 200);
    assert.deepEqual(((await oldPage.json()) as { entries: unknown[] }).entries, []);
    assert.match(await (await f.human()).text(), /PRIVATE_SENTINEL/);
  } finally {
    await f.close();
  }
});

test("explicit memory reads invalidate the target checkpoint but validation reads do not", async () => {
  const f = await fixture();
  try {
    await f.checkpoint();
    await f.append("assistant", { text: "SAFE_REPLY" });
    assert.equal((await f.get()).status, 200);
    assert.equal((await f.get()).status, 200);
    assert.equal(await f.built.sessions.memoryReadEpoch(f.session.id), 0);
    const memory = await f.memoryRead();
    assert.equal(memory.status, 200);
    assert.match(await memory.text(), /PRIVATE_SENTINEL/);
    assert.equal(await f.built.sessions.memoryReadEpoch(f.session.id), 1);
    assert.equal((await f.get()).status, 403);
  } finally {
    await f.close();
  }
});

test("adding an authorized fact preserves an otherwise compatible checkpoint", async () => {
  const f = await fixture();
  try {
    await f.checkpoint();
    await f.append("assistant", { text: "SAFE_REPLY" });
    f.setRecords({
      version: 1,
      records: [...f.records().records, { ...f.records().records[0]!, id: "added", text: "- NEW_FACT" }],
    });
    assert.equal((await f.get()).status, 200);
  } finally {
    await f.close();
  }
});

test("agent list and patch responses do not disclose retained titles or statuses", async () => {
  const f = await fixture();
  try {
    await f.built.sessions.updateTitle(f.session.id, "PRIVATE_TITLE");
    await f.built.sessions.updateStatus(f.session.id, { emoji: "✅", text: "PRIVATE_STATUS" });
    const listed = await f.list();
    assert.equal(listed.status, 200);
    const listing = await listed.text();
    assert.match(listing, new RegExp(f.session.id));
    assert.doesNotMatch(listing, /PRIVATE_TITLE|PRIVATE_STATUS/);
    const patch = await f.post("", { archived: true });
    assert.equal(patch.status, 200);
    assert.doesNotMatch(await patch.text(), /PRIVATE_TITLE|PRIVATE_STATUS/);
    const renamed = await f.post("", { title: "safe title" });
    assert.equal(renamed.status, 200);
    const renamedBody = await renamed.text();
    assert.match(renamedBody, /safe title/);
    assert.doesNotMatch(renamedBody, /PRIVATE_STATUS/);
    const cleared = await f.post("", { status: null });
    assert.equal(cleared.status, 200);
    assert.equal(((await cleared.json()) as { conversation: { status: null } }).conversation.status, null);
  } finally {
    await f.close();
  }
});

for (const state of ["unknown", "revoked", "cutoff"] as const) {
  test(`agent fork refuses ${state} source before creating any conversation`, async () => {
    const f = await fixture();
    try {
      const old = await f.append("assistant", { text: "PRIVATE_SENTINEL" });
      if (state !== "unknown") await f.checkpoint(state === "cutoff" ? old.seq : -1);
      if (state === "revoked") f.setRecords({ version: 1, records: [] });
      const before = (await f.built.app.listSessions("alice")).map((session) => session.id);
      const response = await f.post("/fork");
      assert.equal(response.status, 403);
      assert.deepEqual(await response.json(), { error: "forbidden" });
      assert.deepEqual(
        (await f.built.app.listSessions("alice")).map((session) => session.id),
        before,
      );
      assert.match(await (await f.human()).text(), /PRIVATE_SENTINEL/);
    } finally {
      await f.close();
    }
  });
}

test("compatible agent fork returns authorized entries without retained metadata", async () => {
  const f = await fixture();
  try {
    await f.checkpoint();
    await f.append("user", { text: "safe question" });
    await f.append("assistant", { text: "SAFE_REPLY" });
    await f.built.sessions.updateTitle(f.session.id, "PRIVATE_TITLE");
    await f.built.sessions.updateStatus(f.session.id, { emoji: "✅", text: "PRIVATE_STATUS" });
    const response = await f.post("/fork");
    assert.equal(response.status, 200);
    const text = await response.text();
    assert.match(text, /SAFE_REPLY/);
    assert.doesNotMatch(text, /PRIVATE_TITLE|PRIVATE_STATUS|memory_context/);
  } finally {
    await f.close();
  }
});
