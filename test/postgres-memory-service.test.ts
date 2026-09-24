import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createPostgresMemoryService } from "../src/memory/postgres-memory-service.ts";
import { ccCaptureToPersonal } from "../src/memory/memory-service.ts";
import { scopeId } from "../src/types.ts";

const URL = process.env.DATABASE_URL;
const skip = URL ? false : "set DATABASE_URL (a Postgres) to run the Postgres memory tests";

const at = Date.UTC(2026, 4, 31);

beforeEach(async () => {
  if (!URL) return;
  const pg = (await import("pg")).default;
  const p = new pg.Pool({ connectionString: URL });
  await p.query("DROP TABLE IF EXISTS qm_schema_migrations CASCADE");
  await p.query("DROP TABLE IF EXISTS memory_revisions CASCADE");
  await p.end();
});

async function revisions(
  sid: string,
): Promise<Array<{ seq: number; op: string; body: string; author: string | null }>> {
  const pg = (await import("pg")).default;
  const p = new pg.Pool({ connectionString: URL });
  try {
    const r = await p.query("SELECT seq, op, body, author FROM memory_revisions WHERE scope_id = $1 ORDER BY seq", [
      sid,
    ]);
    return r.rows.map((x) => ({ seq: Number(x.seq), op: x.op, body: x.body, author: x.author }));
  } finally {
    await p.end();
  }
}

test(
  "pg memory: capture dedupes + dates, and a SEPARATE instance recalls it (durable, fleet-shared)",
  { skip },
  async () => {
    const a = createPostgresMemoryService(URL!);
    const sid = scopeId("personal", "U1");

    assert.equal(await a.capture(sid, ["Prefers terse replies"], at), 1);
    assert.equal(await a.capture(sid, ["Prefers terse replies"], at), 0, "exact duplicate is not re-added");
    assert.equal(await a.capture(sid, ["Owns the billing service"], at), 1);

    const b = createPostgresMemoryService(URL!);
    const recalled = await b.recall(sid);
    assert.match(recalled, /Prefers terse replies/);
    assert.match(recalled, /billing service/);
    assert.match(recalled, /\(2026-05-31\)/);
  },
);

test("pg memory: read() returns the full notebook; replace() round-trips and clears", { skip }, async () => {
  const mem = createPostgresMemoryService(URL!);
  const sid = scopeId("personal", "U2");

  assert.equal(await mem.read(sid), "", "no notebook yet → empty");

  await mem.replace(sid, "# Memory\n\n- I work in PT");
  assert.equal(await mem.read(sid), "# Memory\n\n- I work in PT\n", "stored with one trailing newline");

  await mem.replace(sid, "   \n");
  assert.equal(await mem.read(sid), "", "blank content clears the notebook");
  assert.equal(await mem.recall(sid), "");
});

test("pg memory: capture preserves hand-written prose written via replace()", { skip }, async () => {
  const mem = createPostgresMemoryService(URL!);
  const sid = scopeId("personal", "U3");

  const note = "# Memory\n\nI prefer terse replies and I work in PT.\n\n## Quirks\n* uses vim\n- already a fact\n";
  await mem.replace(sid, note);
  assert.equal(await mem.capture(sid, ["Lives in Seattle"], at), 1);

  const after = await mem.read(sid);
  assert.match(after, /I prefer terse replies and I work in PT\./, "prose survives capture");
  assert.match(after, /## Quirks/, "headers survive capture");
  assert.match(after, /\* uses vim/, "star-bullets survive capture");
  assert.match(after, /- \(2026-05-31\) Lives in Seattle/, "the new fact is appended");
  assert.equal(await mem.capture(sid, ["already a fact"], at), 0, "an existing bullet fact is not re-added");
});

test("pg memory: query() is term-AND filtered and scope-keyed (boundary-safe)", { skip }, async () => {
  const mem = createPostgresMemoryService(URL!);
  const personal = scopeId("personal", "U4");
  const channel = scopeId("channel", "C4");
  await mem.capture(personal, ["Owns the billing service", "Prefers terse replies"], at);

  assert.deepEqual(await mem.query(personal, "billing"), ["(2026-05-31) Owns the billing service"]);
  assert.deepEqual(await mem.query(personal, "kubernetes"), []);
  assert.deepEqual(await mem.query(channel, "handle"), [], "another scope sees nothing");
});

test("pg memory: every mutation appends a revision; the edit history survives a rewrite", { skip }, async () => {
  const mem = createPostgresMemoryService(URL!);
  const sid = scopeId("personal", "U5");

  await mem.capture(sid, ["Lives in Seattle"], at);
  await mem.capture(sid, ["Moved to Boston"], at);
  await mem.replace(sid, "# Memory\n\n- (2026-05-31) Moved to Boston", "system");

  assert.doesNotMatch(await mem.read(sid), /Seattle/, "current notebook reflects the rewrite");

  const log = await revisions(sid);
  assert.deepEqual(
    log.map((r) => r.seq),
    [1, 2, 3],
    "revisions are gap-free + monotonic",
  );
  assert.deepEqual(
    log.map((r) => r.op),
    ["capture", "capture", "replace"],
  );
  assert.match(log[0]!.body, /Seattle/, "the dropped fact is still recoverable from an earlier revision");
  assert.equal(log[2]!.author, "system", "the rewrite is attributed");
  assert.equal(log[0]!.author, null, "an unattributed capture records no author");
});

test("pg memory: no-op capture/replace append no revision", { skip }, async () => {
  const mem = createPostgresMemoryService(URL!);
  const sid = scopeId("personal", "U6");

  await mem.capture(sid, ["Prefers terse replies"], at);
  assert.equal(await mem.capture(sid, ["Prefers terse replies"], at), 0, "duplicate adds nothing");
  await mem.replace(sid, await mem.read(sid));
  await mem.replace(scopeId("personal", "U6b"), "   ");

  assert.deepEqual(
    (await revisions(sid)).map((r) => r.seq),
    [1],
    "only the one real write is logged",
  );
  assert.deepEqual(await revisions(scopeId("personal", "U6b")), [], "clearing an empty notebook logs nothing");
});

test("pg memory: metadata sizes every notebook from head revisions (matches read())", { skip }, async () => {
  const m = createPostgresMemoryService(URL!);
  const u1 = scopeId("personal", "U1");
  const u2 = scopeId("personal", "U2");
  await m.replace(u1, "one line", "admin");
  await m.replace(u1, "two lines\nof memory", "admin");
  await m.replace(u2, "temporary note", "admin");
  await m.replace(u2, "", "admin");

  const meta = await m.metadata!();
  const head1 = await m.read(u1);
  assert.equal(meta.get(u1)!.bytes, Buffer.byteLength(head1), "bytes match the current head body");
  assert.ok(head1.includes("two lines"), "sized against the head, not an older revision");
  assert.equal(meta.get(u1)!.updatedAt, await m.updatedAt!(u1), "updatedAt matches the head write time");
  assert.equal(meta.get(u2)!.bytes, 0, "a cleared notebook sizes to zero");
  assert.equal(meta.get(scopeId("personal", "absent")), undefined, "never-written scopes are absent");
});

test("pg memory: structured provenance and labels survive a separate instance and personal CC", { skip }, async () => {
  const a = createPostgresMemoryService(URL!);
  const source = scopeId("channel", "source");
  await ccCaptureToPersonal(a, source, "alice", ["sensitive synthetic fact"], at, "Source", {
    mode: "automatic",
    conversationScopeId: "channel:wrong",
    sessionId: "synthetic-session",
    sensitivity: "sensitive",
    inheritedRecords: [],
  });
  const b = createPostgresMemoryService(URL!);
  const head = await b.readHead!(scopeId("personal", "alice"));
  const record = head.records!.records.find((record) => record.text.includes("synthetic fact"))!;
  assert.equal(record.sensitivity, "sensitive");
  assert.equal(record.sourceUnknown, false);
  assert.deepEqual(record.sources, [{ scopeId: source, sessionId: "synthetic-session" }]);
  assert.deepEqual((await b.history!(scopeId("personal", "alice")))[0]!.records, head.records);
});

test("pg memory: rewrites and CAS persist metadata atomically without losing restrictions", { skip }, async () => {
  const mem = createPostgresMemoryService(URL!);
  const sid = scopeId("personal", "alice");
  await mem.capture(sid, ["restricted synthetic fact"], at, "alice", {
    mode: "explicit",
    conversationScopeId: "group:private",
    sensitivity: "restricted",
    inheritedRecords: [],
  });
  const before = await mem.readHead!(sid);
  const results = await Promise.all([
    mem.replaceIfRevision!(sid, "- summary A", before.revision),
    mem.replaceIfRevision!(sid, "- summary B", before.revision),
  ]);
  assert.deepEqual(results.sort(), [false, true]);
  const after = await mem.readHead!(sid);
  assert.equal(after.records!.records.length, 1);
  assert.equal(after.records!.records[0]!.text + "\n", after.content);
  assert.equal(after.records!.records[0]!.sensitivity, "restricted");
  assert.deepEqual(after.records!.records[0]!.sources, [{ scopeId: "group:private" }]);
});

test(
  "pg memory: legacy migration retains text and marks unknown provenance without guessing from labels",
  { skip },
  async () => {
    const pg = (await import("pg")).default;
    const pool = new pg.Pool({ connectionString: URL });
    const sid = scopeId("personal", "legacy");
    const body = "# Memory\n\n- old note (said in private channel)\n";
    try {
      await pool.query(
        "CREATE TABLE memory_revisions(id BIGSERIAL PRIMARY KEY, scope_id TEXT NOT NULL, seq BIGINT NOT NULL, op TEXT NOT NULL, body TEXT NOT NULL, author TEXT, at BIGINT NOT NULL, UNIQUE(scope_id, seq))",
      );
      await pool.query("INSERT INTO memory_revisions(scope_id,seq,op,body,at) VALUES ($1,1,'capture',$2,$3)", [
        sid,
        body,
        at,
      ]);
      const mem = createPostgresMemoryService(URL!);
      const head = await mem.readHead!(sid);
      assert.equal(head.content, body);
      assert.ok(
        head.records!.records.every(
          (record) => record.sourceUnknown && record.sensitivity === "unknown" && !record.sources.length,
        ),
      );
      await mem.capture(sid, ["new fact"], at, "legacy", { mode: "explicit", sessionId: "new-session" });
      const next = await mem.readHead!(sid);
      assert.deepEqual(next.records!.records.slice(0, head.records!.records.length), head.records!.records);
      assert.equal(next.records!.records.at(-1)!.sources[0]!.sessionId, "new-session");
      assert.equal((await mem.history!(sid)).length, 2);
    } finally {
      await pool.end();
    }
  },
);

test(
  "pg memory: restoring an earlier notebook preserves its source and the later restriction floor",
  { skip },
  async () => {
    const mem = createPostgresMemoryService(URL!);
    const sid = scopeId("personal", "restore");
    await mem.capture(sid, ["ordinary synthetic fact"], at, "restore", {
      mode: "explicit",
      sensitivity: "ordinary",
      inheritedRecords: [],
    });
    const original = await mem.readHead!(sid);
    await mem.capture(sid, ["restricted synthetic fact"], at, "restore", {
      mode: "explicit",
      sensitivity: "restricted",
      conversationScopeId: "group:private",
      inheritedRecords: [],
    });
    const latest = await mem.readHead!(sid);
    assert.equal(await mem.restore!(sid, original.revision, latest.revision), true);
    const restored = await mem.readHead!(sid);
    assert.equal(restored.content, original.content);
    assert.ok(restored.records!.records.every((record) => record.sensitivity === "restricted"));
    assert.ok(
      restored.records!.records.every((record) => record.sources.some((source) => source.scopeId === "group:private")),
    );
    assert.equal(await mem.restore!(sid, original.revision, latest.revision), false);
  },
);

test(
  "pg memory: duplicate captures tighten metadata without duplicating text or adding unchanged revisions",
  { skip },
  async () => {
    const mem = createPostgresMemoryService(URL!);
    const sid = scopeId("personal", "duplicate");
    const context = { mode: "explicit" as const, sensitivity: "ordinary" as const, inheritedRecords: [] };
    await mem.capture(sid, ["same fact", "unrelated fact"], at, "duplicate", context);
    const first = await mem.readHead!(sid);
    assert.equal(
      await mem.capture(sid, ["same fact"], at + 86400000, "duplicate", {
        ...context,
        sensitivity: "restricted",
        conversationScopeId: "group:private",
      }),
      0,
    );
    const tightened = await mem.readHead!(sid);
    assert.equal(tightened.content, first.content);
    const match = tightened.records!.records.find((record) => record.text.includes("same fact"))!;
    assert.equal(match.sensitivity, "restricted");
    assert.equal(match.id, first.records!.records.find((record) => record.text.includes("same fact"))!.id);
    assert.deepEqual(new Set(match.sources.map((source) => source.scopeId)), new Set([sid, "group:private"]));
    assert.equal(
      tightened.records!.records.find((record) => record.text.includes("unrelated fact"))!.sensitivity,
      "ordinary",
    );
    await mem.capture(sid, ["same fact"], at, "duplicate", context);
    assert.equal((await mem.readHead!(sid)).revision, tightened.revision);
    assert.equal(await mem.replaceIfRevision!(sid, tightened.content, tightened.revision), true);
    assert.equal((await mem.readHead!(sid)).revision, tightened.revision);
  },
);

test("pg memory: an intermediate empty restore cannot erase later restrictions", { skip }, async () => {
  const mem = createPostgresMemoryService(URL!);
  const sid = scopeId("personal", "empty-restore");
  await mem.capture(sid, ["seed"], at);
  await mem.replace(sid, "");
  const empty = await mem.readHead!(sid);
  await mem.capture(sid, ["same fact"], at, "actor", {
    mode: "explicit",
    sensitivity: "ordinary",
    inheritedRecords: [],
  });
  const ordinary = await mem.readHead!(sid);
  await mem.capture(sid, ["same fact"], at, "actor", {
    mode: "explicit",
    sensitivity: "restricted",
    conversationScopeId: "group:private",
    inheritedRecords: [],
  });
  const restricted = await mem.readHead!(sid);
  assert.equal(await mem.restore!(sid, empty.revision, restricted.revision), true);
  const cleared = await mem.readHead!(sid);
  assert.equal(cleared.content, "");
  assert.equal(await mem.restore!(sid, ordinary.revision, cleared.revision), true);
  const restored = await mem.readHead!(sid);
  const fact = restored.records!.records.find((record) => record.text.includes("same fact"))!;
  assert.equal(fact.sensitivity, "restricted");
  assert.ok(fact.sources.some((source) => source.scopeId === "group:private"));
});
