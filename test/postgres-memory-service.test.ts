import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { MemoryOperationConflictError, MemoryOperationErasedError } from "../src/memory/memory-service.ts";
import { createPostgresMemoryService } from "../src/memory/postgres-memory-service.ts";
import { memoryOperationToken } from "../src/memory/privacy-tokens.ts";
import { scopeId } from "../src/types.ts";

const URL = process.env.DATABASE_URL;
const skip = URL ? false : "set DATABASE_URL (a Postgres) to run the Postgres memory tests";

const at = Date.UTC(2026, 4, 31);
const TOMBSTONE_KEY = "e".repeat(32);

beforeEach(async () => {
  if (!URL) return;
  const pg = (await import("pg")).default;
  const p = new pg.Pool({ connectionString: URL });
  await p.query("DROP TABLE IF EXISTS memory_erasure_receipts CASCADE");
  await p.query("DROP TABLE IF EXISTS memory_erased_scopes CASCADE");
  await p.query("DROP TABLE IF EXISTS memory_tombstone_key_guard CASCADE");
  await p.query("DROP TABLE IF EXISTS memory_integration_operations CASCADE");
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

async function erasureReceipt(operationId: string): Promise<{
  requestHash: string;
  scopeHash: string;
  erasedRevisions: number;
  tombstonedOperations: number;
  completedAt: number;
}> {
  const pg = (await import("pg")).default;
  const p = new pg.Pool({ connectionString: URL });
  try {
    const result = await p.query(
      `SELECT request_hash, scope_hash, erased_revisions, tombstoned_operations, completed_at
         FROM memory_erasure_receipts
        WHERE integration_id = 'wulo-work' AND operation_id = $1`,
      [memoryOperationToken(TOMBSTONE_KEY, "wulo-work", operationId)],
    );
    const row = result.rows[0];
    assert.ok(row);
    return {
      requestHash: String(row.request_hash),
      scopeHash: String(row.scope_hash),
      erasedRevisions: Number(row.erased_revisions),
      tombstonedOperations: Number(row.tombstoned_operations),
      completedAt: Number(row.completed_at),
    };
  } finally {
    await p.end();
  }
}

async function integrationOperation(
  operationId: string,
): Promise<{ requestHash: string; scopeId: string; added: number; revision: number; erasedAt: number | null } | null> {
  const pg = (await import("pg")).default;
  const p = new pg.Pool({ connectionString: URL });
  try {
    const result = await p.query(
      `SELECT request_hash, scope_id, added, revision, erased_at
         FROM memory_integration_operations
        WHERE integration_id = 'wulo-work' AND operation_id = $1`,
      [memoryOperationToken(TOMBSTONE_KEY, "wulo-work", operationId)],
    );
    const row = result.rows[0];
    return row
      ? {
          requestHash: String(row.request_hash),
          scopeId: String(row.scope_id),
          added: Number(row.added),
          revision: Number(row.revision),
          erasedAt: row.erased_at == null ? null : Number(row.erased_at),
        }
      : null;
  } finally {
    await p.end();
  }
}

async function storedOperationIds(): Promise<string[]> {
  const pg = (await import("pg")).default;
  const p = new pg.Pool({ connectionString: URL });
  try {
    const result = await p.query(
      `SELECT operation_id FROM memory_integration_operations
       UNION ALL
       SELECT operation_id FROM memory_erasure_receipts`,
    );
    return result.rows.map((row) => String(row.operation_id));
  } finally {
    await p.end();
  }
}

test("pg memory: a changed tombstone key fails closed", { skip }, async () => {
  const original = createPostgresMemoryService(URL!, TOMBSTONE_KEY);
  await original.read(scopeId("personal", "key-guard"));

  const changed = createPostgresMemoryService(URL!, "f".repeat(32));
  await assert.rejects(
    changed.read(scopeId("personal", "key-guard")),
    /tombstone key does not match the key registered for this database/,
  );
});

test(
  "pg memory: capture dedupes + dates, and a SEPARATE instance recalls it (durable, fleet-shared)",
  { skip },
  async () => {
    const a = createPostgresMemoryService(URL!, TOMBSTONE_KEY);
    const sid = scopeId("personal", "U1");

    assert.equal(await a.capture(sid, ["Prefers terse replies"], at), 1);
    assert.equal(await a.capture(sid, ["Prefers terse replies"], at), 0, "exact duplicate is not re-added");
    assert.equal(await a.capture(sid, ["Owns the billing service"], at), 1);

    const b = createPostgresMemoryService(URL!, TOMBSTONE_KEY);
    const recalled = await b.recall(sid);
    assert.match(recalled, /Prefers terse replies/);
    assert.match(recalled, /billing service/);
    assert.match(recalled, /\(2026-05-31\)/);
  },
);

test("pg memory: read() returns the full notebook; replace() round-trips and clears", { skip }, async () => {
  const mem = createPostgresMemoryService(URL!, TOMBSTONE_KEY);
  const sid = scopeId("personal", "U2");

  assert.equal(await mem.read(sid), "", "no notebook yet → empty");

  await mem.replace(sid, "# Memory\n\n- I work in PT");
  assert.equal(await mem.read(sid), "# Memory\n\n- I work in PT\n", "stored with one trailing newline");

  await mem.replace(sid, "   \n");
  assert.equal(await mem.read(sid), "", "blank content clears the notebook");
  assert.equal(await mem.recall(sid), "");
});

test("pg memory: capture preserves hand-written prose written via replace()", { skip }, async () => {
  const mem = createPostgresMemoryService(URL!, TOMBSTONE_KEY);
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
  const mem = createPostgresMemoryService(URL!, TOMBSTONE_KEY);
  const personal = scopeId("personal", "U4");
  const channel = scopeId("channel", "C4");
  await mem.capture(personal, ["Owns the billing service", "Prefers terse replies"], at);

  assert.deepEqual(await mem.query(personal, "billing"), ["(2026-05-31) Owns the billing service"]);
  assert.deepEqual(await mem.query(personal, "kubernetes"), []);
  assert.deepEqual(await mem.query(channel, "handle"), [], "another scope sees nothing");
});

test("pg memory: every mutation appends a revision; the edit history survives a rewrite", { skip }, async () => {
  const mem = createPostgresMemoryService(URL!, TOMBSTONE_KEY);
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
  const mem = createPostgresMemoryService(URL!, TOMBSTONE_KEY);
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

test("pg memory: purge deletes the current notebook and every recoverable revision", { skip }, async () => {
  const mem = createPostgresMemoryService(URL!, TOMBSTONE_KEY);
  const sid = scopeId("personal", "U7");
  await mem.capture(sid, ["Lives in Seattle"], at);
  const first = await mem.readHead!(sid);
  await mem.capture(sid, ["Moved to Boston"], at);

  await mem.purge(sid);

  assert.equal(await mem.read(sid), "");
  assert.deepEqual(await mem.history!(sid), []);
  assert.deepEqual(await revisions(sid), []);
  assert.equal(await mem.restore!(sid, first.revision, "0", "system:erase"), false);
  await assert.rejects(mem.capture(sid, ["Attempted ordinary capture"], at + 1), MemoryOperationErasedError);
  await assert.rejects(mem.replace(sid, "# Memory\n\n- Attempted replacement"), MemoryOperationErasedError);
  await assert.rejects(
    mem.replaceIfRevision!(sid, "# Memory\n\n- Attempted CAS replacement", "0"),
    MemoryOperationErasedError,
  );
});

test("pg memory: captureOnce retries return one revision and reject operation-key reuse", { skip }, async () => {
  const mem = createPostgresMemoryService(URL!, TOMBSTONE_KEY);
  const input = {
    integrationId: "wulo-work",
    operationId: "turn-123",
    scopeId: scopeId("personal", "U8"),
    facts: ["Prefers terse replies"],
    at,
    author: "service:wulo-work",
  };

  const first = await mem.captureOnce(input);
  const retry = await mem.captureOnce(input);

  assert.deepEqual(retry, first);
  assert.equal(first.added, 1);
  assert.deepEqual(
    (await revisions(input.scopeId)).map((row) => row.seq),
    [1],
  );
  await assert.rejects(
    mem.captureOnce({ ...input, facts: ["Owns the billing service"] }),
    MemoryOperationConflictError,
  );
});

test("pg memory: purge tombstones capture operations so delayed retries cannot resurrect data", { skip }, async () => {
  const mem = createPostgresMemoryService(URL!, TOMBSTONE_KEY);
  const input = {
    integrationId: "wulo-work",
    operationId: "turn-erased",
    scopeId: scopeId("personal", "U9"),
    facts: ["Prefers terse replies"],
    at,
    author: "service:wulo-work",
  };
  await mem.captureOnce(input);

  await mem.purge(input.scopeId);

  await assert.rejects(mem.captureOnce(input), MemoryOperationErasedError);
  assert.equal(await mem.read(input.scopeId), "");
  const operation = await integrationOperation(input.operationId);
  assert.deepEqual(operation && { ...operation, erasedAt: operation.erasedAt !== null }, {
    requestHash: "",
    scopeId: "",
    added: 0,
    revision: 0,
    erasedAt: true,
  });
});

test("pg memory: erased operation ids stay tombstoned across scopes", { skip }, async () => {
  const mem = createPostgresMemoryService(URL!, TOMBSTONE_KEY);
  const erasedScope = scopeId("personal", "U9-erased");
  const liveScope = scopeId("personal", "U9-live");
  await mem.captureOnce({
    integrationId: "wulo-work",
    operationId: "turn-global",
    scopeId: erasedScope,
    facts: ["Prefers terse replies"],
    at,
    author: "service:wulo-work",
  });
  await mem.purge(erasedScope);

  await assert.rejects(
    mem.captureOnce({
      integrationId: "wulo-work",
      operationId: "turn-global",
      scopeId: liveScope,
      facts: ["Owns the billing service"],
      at,
      author: "service:wulo-work",
    }),
    MemoryOperationErasedError,
  );
  assert.deepEqual(
    await mem.captureOnce({
      integrationId: "wulo-work",
      operationId: "turn-live",
      scopeId: liveScope,
      facts: ["Owns the billing service"],
      at,
      author: "service:wulo-work",
    }),
    { added: 1, revision: "1", updatedAt: at },
  );
});

test(
  "pg memory: purgeOnce is idempotent, non-identifying, and blocks every later integration capture",
  { skip },
  async () => {
    const mem = createPostgresMemoryService(URL!, TOMBSTONE_KEY);
    const sid = scopeId("personal", "alice@example.com");
    await mem.captureOnce({
      integrationId: "wulo-work",
      operationId: "capture-before-erasure",
      scopeId: sid,
      facts: ["Prefers terse replies"],
      at,
      author: "service:wulo-work",
    });
    await mem.replace(sid, "# Memory\n\n- Updated preference", "system");
    const input = {
      integrationId: "wulo-work",
      operationId: "erase-personal-memory",
      scopeId: sid,
      at: at + 1_000,
    };

    const first = await mem.purgeOnce(input);
    const retry = await mem.purgeOnce(input);

    assert.deepEqual(retry, first);
    assert.equal(first.erasedRevisions, 2);
    assert.equal(first.tombstonedOperations, 1);
    assert.equal(first.completedAt, input.at);
    assert.match(first.scopeHash, /^[a-f0-9]{64}$/);
    assert.notEqual(first.scopeHash, sid);
    assert.equal(await mem.read(sid), "");
    assert.deepEqual(await mem.history!(sid), []);
    await assert.rejects(
      mem.captureOnce({
        integrationId: "wulo-work",
        operationId: "brand-new-operation-after-erasure",
        scopeId: sid,
        facts: ["Attempted resurrection"],
        at: at + 2_000,
        author: "service:wulo-work",
      }),
      MemoryOperationErasedError,
    );
    await assert.rejects(mem.purgeOnce({ ...input, at: input.at + 1 }), MemoryOperationConflictError);

    const retained = await erasureReceipt(input.operationId);
    assert.deepEqual(retained, {
      requestHash: retained.requestHash,
      scopeHash: first.scopeHash,
      erasedRevisions: 2,
      tombstonedOperations: 1,
      completedAt: input.at,
    });
    assert.match(retained.requestHash, /^[a-f0-9]{64}$/);
    assert.doesNotMatch(JSON.stringify(retained), /alice@example\.com|personal:alice/);
    const operationIds = await storedOperationIds();
    assert.ok(operationIds.length >= 2);
    assert.ok(operationIds.every((operationId) => /^[a-f0-9]{64}$/.test(operationId)));
    assert.doesNotMatch(JSON.stringify(operationIds), /capture-before-erasure|erase-personal-memory|alice/);
  },
);

test("pg memory: concurrent captureOnce and purgeOnce serialize without resurrection", { skip }, async () => {
  const mem = createPostgresMemoryService(URL!, TOMBSTONE_KEY);
  const sid = scopeId("personal", "concurrent-erasure@example.com");
  const capture = {
    integrationId: "wulo-work",
    operationId: "concurrent-capture",
    scopeId: sid,
    facts: ["Must not survive erasure"],
    at,
    author: "service:wulo-work",
  };
  const erase = {
    integrationId: "wulo-work",
    operationId: "concurrent-erase",
    scopeId: sid,
    at: at + 1,
  };

  const [captureResult, eraseResult] = await Promise.allSettled([mem.captureOnce(capture), mem.purgeOnce(erase)]);

  assert.equal(eraseResult.status, "fulfilled");
  if (captureResult.status === "rejected") assert.ok(captureResult.reason instanceof MemoryOperationErasedError);
  assert.equal(await mem.read(sid), "");
  assert.deepEqual(await mem.history!(sid), []);
  await assert.rejects(
    mem.captureOnce({ ...capture, operationId: "capture-after-concurrent-erasure", at: at + 2 }),
    MemoryOperationErasedError,
  );
});

test("pg memory: concurrent ordinary capture and purge serialize without resurrection", { skip }, async () => {
  const mem = createPostgresMemoryService(URL!, TOMBSTONE_KEY);
  const sid = scopeId("personal", "concurrent-ordinary-erasure@example.com");

  const [captureResult, purgeResult] = await Promise.allSettled([
    mem.capture(sid, ["Must not survive erasure"], at),
    mem.purge(sid),
  ]);

  assert.equal(purgeResult.status, "fulfilled");
  if (captureResult.status === "rejected") assert.ok(captureResult.reason instanceof MemoryOperationErasedError);
  assert.equal(await mem.read(sid), "");
  assert.deepEqual(await mem.history!(sid), []);
  await assert.rejects(mem.capture(sid, ["Attempted resurrection"], at + 1), MemoryOperationErasedError);
});

test("pg memory: metadata sizes every notebook from head revisions (matches read())", { skip }, async () => {
  const m = createPostgresMemoryService(URL!, TOMBSTONE_KEY);
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
