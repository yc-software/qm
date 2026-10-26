import "./support/auto-fake-sprites.ts";

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { createInsecureTestServer } from "../src/api/server.ts";
import { type BuiltApp } from "../src/wiring.ts";
import { buildApp } from "./support/build-app.ts";
import { ENTRY_STRING_BUDGET, windowedTranscript } from "../src/sessions/session-store.ts";
import { storedItem, type Item, type ItemKind, type NewItem } from "../src/sessions/items.ts";
import { testConfig } from "./support/test-config.ts";

function entry(seq: number, kind: ItemKind): Item {
  const callId = kind === "ToolCall" || kind === "ToolResult" ? `c${seq}` : undefined;
  return storedItem({ kind, text: `e${seq}`, callId } as NewItem, { sessionId: "s1", seq, createdAt: seq });
}

const LOG: Item[] = [
  entry(0, "UserMessage"),
  entry(1, "ToolCall"),
  entry(2, "ToolResult"),
  entry(3, "AgentMessage"),
  entry(4, "UserMessage"),
  entry(5, "AgentMessage"),
  entry(6, "UserMessage"),
  entry(7, "ToolCall"),
  entry(8, "AgentMessage"),
];

test("windowedTranscript: tailTurns cuts on a turn boundary (a user entry), never mid-turn", () => {
  const one = windowedTranscript(LOG, { tailTurns: 1 });
  assert.deepEqual(
    one.items.map((e) => e.seq),
    [6, 7, 8],
    "the last turn starts at its user entry",
  );
  assert.equal(one.earlier, 6);

  const two = windowedTranscript(LOG, { tailTurns: 2 });
  assert.deepEqual(
    two.items.map((e) => e.seq),
    [4, 5, 6, 7, 8],
  );
  assert.equal(two.earlier, 4);
});

test("windowedTranscript: asking for more turns than exist returns everything", () => {
  const all = windowedTranscript(LOG, { tailTurns: 99 });
  assert.equal(all.items.length, LOG.length);
  assert.equal(all.earlier, 0);
});

test("windowedTranscript: no window returns everything", () => {
  const all = windowedTranscript(LOG);
  assert.equal(all.items.length, LOG.length);
  assert.equal(all.earlier, 0);
});

test("windowedTranscript: sinceSeq re-reads from an anchor, counting what it skipped", () => {
  const w = windowedTranscript(LOG, { sinceSeq: 4 });
  assert.deepEqual(
    w.items.map((e) => e.seq),
    [4, 5, 6, 7, 8],
  );
  assert.equal(w.earlier, 4);

  const none = windowedTranscript(LOG, { sinceSeq: 0 });
  assert.equal(none.items.length, LOG.length);
  assert.equal(none.earlier, 0);

  const past = windowedTranscript(LOG, { sinceSeq: 999 });
  assert.equal(past.items.length, 0, "an anchor past the end yields an empty window");
  assert.equal(past.earlier, LOG.length);
});

test("windowedTranscript: beforeSeq pages history backward on turn boundaries", () => {
  const page = windowedTranscript(LOG, { beforeSeq: 6, tailTurns: 1 });
  assert.deepEqual(
    page.items.map((e) => e.seq),
    [4, 5],
    "the turn immediately before the anchor",
  );
  assert.equal(page.earlier, 4, "what remains before THIS page, not before the original tail");

  const next = windowedTranscript(LOG, { beforeSeq: 4, tailTurns: 1 });
  assert.deepEqual(
    next.items.map((e) => e.seq),
    [0, 1, 2, 3],
  );
  assert.equal(next.earlier, 0, "the log is exhausted — the button disappears");
});

test("windowedTranscript: beforeSeq alone truncates; wider-than-history pages return everything left", () => {
  const prefix = windowedTranscript(LOG, { beforeSeq: 4 });
  assert.deepEqual(
    prefix.items.map((e) => e.seq),
    [0, 1, 2, 3],
  );
  assert.equal(prefix.earlier, 0);

  const wide = windowedTranscript(LOG, { beforeSeq: 6, tailTurns: 99 });
  assert.deepEqual(
    wide.items.map((e) => e.seq),
    [0, 1, 2, 3, 4, 5],
  );
  assert.equal(wide.earlier, 0);

  const past = windowedTranscript(LOG, { beforeSeq: 999, tailTurns: 1 });
  assert.deepEqual(
    past.items.map((e) => e.seq),
    [6, 7, 8],
    "an anchor past the end behaves like a plain tail read",
  );
});

function fat(seq: number, type: ItemKind, chars: number): Item {
  return { ...entry(seq, type), body: { tool: "execute", output: "x".repeat(chars) } };
}

test("windowedTranscript: a fat tool payload is previewed, and the entry says so", () => {
  const log = [
    entry(0, "UserMessage"),
    fat(1, "ToolCall", 50_000),
    fat(2, "ToolResult", 50_000),
    entry(3, "AgentMessage"),
  ];
  const w = windowedTranscript(log, { tailTurns: 1 });
  assert.equal(w.items.length, 4);
  for (const e of w.items.filter((x) => x.kind === "ToolCall" || x.kind === "ToolResult")) {
    assert.equal((e.body as { output: string }).output.length, ENTRY_STRING_BUDGET);
    assert.equal(e.truncated, true);
  }
  assert.equal(w.items[0]!.truncated, undefined, "a small entry is shipped whole and unmarked");
});

test("windowedTranscript: conversation text is never truncated — only tool payloads are", () => {
  const said = "y".repeat(50_000);
  const log = [
    { ...entry(0, "UserMessage"), text: said },
    { ...entry(1, "AgentMessage"), text: said },
    { ...entry(2, "Reasoning"), text: said },
  ];
  for (const e of windowedTranscript(log).items) {
    assert.equal(e.text!.length, said.length);
    assert.equal(e.truncated, undefined);
  }
});

function start(): { base: string; built: BuiltApp; close: () => Promise<void> } {
  const built = buildApp(testConfig({ dataDir: mkdtempSync(join(tmpdir(), "transcript-window-")) }));
  const server = createInsecureTestServer(built.app, {
    config: built.config,
    admin: built.admin,
    auditLog: built.auditLog,
  });
  server.listen(0);
  const base = `http://localhost:${(server.address() as AddressInfo).port}`;
  return { base, built, close: () => new Promise<void>((r) => server.close(() => r())) };
}

test("GET /v1/sessions/:id honors tailTurns/sinceSeq and reports earlierItems", async () => {
  const srv = start();
  try {
    const actor = { externalId: "U1" };
    const threadRef = "web:U1:window-test";
    let sessionId = "";
    for (const text of ["first turn", "second turn", "third turn"]) {
      const r = await fetch(`${srv.base}/v1/turns`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ surface: "test", actor, conversation: { kind: "dm", threadRef }, text }),
      });
      const body = (await r.json()) as { status: string; sessionId?: string };
      assert.equal(body.status, "ok");
      sessionId = body.sessionId!;
    }

    const full = await fetch(`${srv.base}/v1/sessions/${encodeURIComponent(sessionId)}?viewer=U1`);
    assert.equal(full.status, 200);
    const fullBody = (await full.json()) as { items: Item[]; earlierItems?: number };
    assert.equal(fullBody.earlierItems, undefined, "an unwindowed read never reports earlierItems");
    const userSeqs = fullBody.items.filter((e) => e.kind === "UserMessage").map((e) => e.seq);
    assert.equal(userSeqs.length, 3);

    const tail = await fetch(`${srv.base}/v1/sessions/${encodeURIComponent(sessionId)}?viewer=U1&tailTurns=1`);
    assert.equal(tail.status, 200);
    const tailBody = (await tail.json()) as { items: Item[]; earlierItems?: number };
    assert.equal(tailBody.items[0]!.seq, userSeqs[2], "the window opens on the last turn's user entry");
    assert.equal(tailBody.earlierItems, userSeqs[2], "everything before the anchor is counted, not shipped");
    assert.equal(tailBody.items.length + tailBody.earlierItems!, fullBody.items.length);

    const since = await fetch(
      `${srv.base}/v1/sessions/${encodeURIComponent(sessionId)}?viewer=U1&sinceSeq=${userSeqs[1]}`,
    );
    const sinceBody = (await since.json()) as { items: Item[]; earlierItems?: number };
    assert.equal(sinceBody.items[0]!.seq, userSeqs[1], "sinceSeq re-reads from the same boundary");

    const wide = await fetch(`${srv.base}/v1/sessions/${encodeURIComponent(sessionId)}?viewer=U1&tailTurns=999`);
    const wideBody = (await wide.json()) as { items: Item[]; earlierItems?: number };
    assert.equal(wideBody.items.length, fullBody.items.length);
    assert.equal(wideBody.earlierItems, undefined);

    const before = await fetch(
      `${srv.base}/v1/sessions/${encodeURIComponent(sessionId)}?viewer=U1&beforeSeq=${userSeqs[2]}&tailTurns=1`,
    );
    assert.equal(before.status, 200);
    const beforeBody = (await before.json()) as { items: Item[]; earlierItems?: number };
    assert.equal(beforeBody.items[0]!.seq, userSeqs[1], "the page opens on the previous turn's user entry");
    assert.ok(
      beforeBody.items.every((e) => e.seq < userSeqs[2]!),
      "nothing at or past the anchor is re-shipped",
    );
    assert.equal(beforeBody.earlierItems, userSeqs[1], "what remains before this page");

    const seq = fullBody.items[0]!.seq;
    const one = await fetch(`${srv.base}/v1/sessions/${encodeURIComponent(sessionId)}/items/${seq}?viewer=U1`);
    assert.equal(one.status, 200);
    const oneBody = (await one.json()) as { item: Item };
    const { truncated, ...shown } = fullBody.items[0] as Item & { truncated?: true };
    assert.equal(truncated, true, "the view marks a user entry whose model-only context it left out");
    assert.equal((shown.body as { environment?: unknown }).environment, undefined);
    assert.equal((shown.body as { memoryRecall?: unknown }).memoryRecall, undefined);
    assert.equal(typeof (oneBody.item.body as { environment?: unknown }).environment, "string");
    assert.deepEqual(
      {
        ...oneBody.item,
        body: { ...oneBody.item.body, environment: undefined, environmentSnapshot: undefined },
      },
      { ...shown, body: { ...shown.body, environment: undefined, environmentSnapshot: undefined } },
      "the whole entry, exactly as stored, is one fetch away",
    );

    const missing = await fetch(`${srv.base}/v1/sessions/${encodeURIComponent(sessionId)}/items/99999?viewer=U1`);
    assert.equal(missing.status, 404, "a seq that isn't in this session");
    const stranger = await fetch(`${srv.base}/v1/sessions/${encodeURIComponent(sessionId)}/items/${seq}?viewer=U2`);
    assert.equal(stranger.status, 404, "a viewer who cannot see the session cannot see its entries");
    const noViewer = await fetch(`${srv.base}/v1/sessions/${encodeURIComponent(sessionId)}/items/${seq}`);
    assert.equal(noViewer.status, 400, "viewer is required");

    const bad = await fetch(`${srv.base}/v1/sessions/${encodeURIComponent(sessionId)}?viewer=U1&tailTurns=0`);
    assert.equal(bad.status, 400, "tailTurns must be a positive integer");
    const badSince = await fetch(`${srv.base}/v1/sessions/${encodeURIComponent(sessionId)}?viewer=U1&sinceSeq=-1`);
    assert.equal(badSince.status, 400, "sinceSeq must be non-negative");
    const badBefore = await fetch(`${srv.base}/v1/sessions/${encodeURIComponent(sessionId)}?viewer=U1&beforeSeq=0`);
    assert.equal(badBefore.status, 400, "beforeSeq must be a positive integer");
  } finally {
    await srv.close();
  }
});

test("windowedTranscript: an unwindowed read is still whole — fork cutoffs count on it", () => {
  const log = [entry(0, "UserMessage")];
  for (let seq = 1; seq <= 400; seq++) log.push(fat(seq, "ToolResult", ENTRY_STRING_BUDGET * 3));
  const all = windowedTranscript(log);
  assert.equal(all.items.length, log.length, "no window asked for, nothing dropped");
  assert.equal(all.earlier, 0);
  assert.equal(all.items[1]!.truncated, true, "though fat payloads are still previewed");
});

test("windowedTranscript: the text a post tool call puts in the conversation is never previewed", () => {
  const said = "z".repeat(50_000);
  const log = [
    entry(0, "UserMessage"),
    { ...entry(1, "ToolCall"), tool: "reach", callId: "c1", body: { action: "post", text: said } },
    { ...entry(2, "ToolResult"), tool: "reach", callId: "c1", body: { ok: true } },
  ];
  const posted = windowedTranscript(log, { tailTurns: 1 }).items[1]!;
  assert.equal((posted.body as { text: string }).text.length, said.length, "the agent's reply is conversation text");
  assert.equal(posted.truncated, undefined);
});

test("windowedTranscript: a deeply nested payload cannot smuggle bytes past the preview", () => {
  const deep = (depth: number, leaf: unknown): unknown => (depth === 0 ? leaf : { nest: deep(depth - 1, leaf) });
  const log = [entry(0, "UserMessage")];
  for (let seq = 1; seq <= 6; seq++) {
    log.push({ ...entry(seq, "ToolResult"), body: { tool: "execute", out: deep(12, "q".repeat(300_000)) } });
  }
  const w = windowedTranscript(log, { tailTurns: 1 });
  const shipped = JSON.stringify(w.items).length;
  assert.ok(
    shipped < 7 * 2 * ENTRY_STRING_BUDGET,
    `a nested subtree must be charged its real size, shipped ${shipped}`,
  );
});

test("windowedTranscript: a sinceSeq re-read is never trimmed — it refreshes what the client already holds", () => {
  const log = [entry(0, "UserMessage")];
  for (let seq = 1; seq <= 400; seq++) log.push(fat(seq, "ToolResult", ENTRY_STRING_BUDGET * 3));
  const w = windowedTranscript(log, { sinceSeq: 1 });
  assert.equal(w.items.length, log.length - 1, "a refresh that shrinks the window makes read messages vanish");
  assert.equal(w.earlier, 1);
});

test("a user entry carrying huge model-only context no longer hides the turns before it", () => {
  const context = "c".repeat(300_000);
  const log: Item[] = [];
  for (let turn = 0; turn < 4; turn++) {
    log.push({
      ...entry(turn * 2, "UserMessage"),
      text: `ask ${turn}`,
      body: {
        environment: context,
        environmentSnapshot: { hashes: { Skills: "abc" }, sessionId: "s" },
        memoryRecall: { body: context },
      },
    });
    log.push(entry(turn * 2 + 1, "AgentMessage"));
  }
  const w = windowedTranscript(log, { tailTurns: 25 });
  assert.equal(w.earlier, 0, "every turn is shipped; nothing is pushed behind the earlier button");
  assert.deepEqual(
    w.items.map((e) => e.seq),
    log.map((e) => e.seq),
  );
  for (const user of w.items.filter((e) => e.kind === "UserMessage")) {
    assert.deepEqual(user.body, {}, "model-only context stays out of the view");
    assert.equal(user.truncated, true, "the full entry is one lazy fetch away");
  }
  assert.ok(JSON.stringify(w.items).length < 10_000);
});

test("thinking entries keep their text but not the provider's signature", () => {
  const log = [
    entry(0, "UserMessage"),
    { ...entry(1, "Reasoning"), text: "weighing it", body: { thinkingSignature: "s".repeat(50_000) } },
  ];
  const thought = windowedTranscript(log, { tailTurns: 1 }).items[1]!;
  assert.equal(thought.text, "weighing it");
  assert.deepEqual(thought.body, {});
  assert.equal(thought.truncated, true);
});

test("paging is by turns alone, however large the turns are", () => {
  const log: Item[] = [];
  const said = (n: number): Item => ({ ...entry(n, "AgentMessage"), text: "s".repeat(50_000) });
  for (let turn = 0; turn < 40; turn++) {
    log.push(entry(turn * 2, "UserMessage"));
    log.push(said(turn * 2 + 1));
  }
  const w = windowedTranscript(log, { tailTurns: 25 });
  assert.equal(w.items.filter((e) => e.kind === "UserMessage").length, 25);
  assert.equal(w.earlier, 30);
});
