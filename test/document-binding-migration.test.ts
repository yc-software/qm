import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import pg from "pg";
import { DOCUMENT_BINDING_KEYS_MIGRATION } from "../src/documents/migrations.ts";
import { testBareDatabaseUrl } from "./support/test-database.ts";

const key = (...parts: string[]) => createHash("sha256").update(JSON.stringify(parts)).digest("hex");

test("binding-key migration preserves historical and private associations without crossing tenants", async () => {
  const client = new pg.Client({ connectionString: testBareDatabaseUrl() });
  await client.connect();
  try {
    await client.query("CREATE TABLE sessions(tenant_id uuid, id text, thread_ref text)");
    await client.query("CREATE TABLE document_conversations(tenant_id uuid, id text, json jsonb)");
    await client.query("CREATE TABLE durable_map_versions(tbl text, v bigint)");
    const expected: Record<string, string> = {};
    for (const tenant of ["00000000-0000-4000-8000-000000000001", "00000000-0000-4000-8000-000000000002"]) {
      for (const mode of ["shared", "private"]) {
        const scopeId = mode === "private" ? "personal:alice" : "group:team";
        const bindingKey = key(tenant, mode);
        await client.query("INSERT INTO document_conversations VALUES ($1,$2,$3)", [
          tenant,
          bindingKey,
          {
            kind: "conversation",
            scopeId,
            threadRef: mode + ":current",
          },
        ]);
        for (const id of [mode + ":old", mode + ":current", mode + ":child"]) {
          await client.query("INSERT INTO sessions VALUES ($1,$2,$3)", [tenant, id, id]);
          const association = {
            kind: "session",
            documentKey: "document-a",
            projectId: "team",
            scopeId,
            mode,
            ...(mode === "private" ? { principalId: "alice" } : {}),
          };
          await client.query("INSERT INTO document_conversations VALUES ($1,$2,$3)", [
            tenant,
            key("session", id),
            association,
          ]);
          expected[tenant + ":" + key("session", id)] = bindingKey;
        }
        await client.query("INSERT INTO document_conversations VALUES ($1,$2,$3)", [
          tenant,
          key("session", mode + ":deleted"),
          {
            kind: "session",
            documentKey: "document-a",
            projectId: "team",
            scopeId,
            mode,
          },
        ]);
      }
    }
    const originalSessions = (await client.query("SELECT * FROM sessions ORDER BY tenant_id,id")).rows;
    const originalBindings = (
      await client.query(
        "SELECT * FROM document_conversations WHERE json->>'kind'='conversation' ORDER BY tenant_id,id",
      )
    ).rows;
    await client.query("BEGIN");
    for (const sql of DOCUMENT_BINDING_KEYS_MIGRATION.statements) await client.query(sql);
    await client.query("COMMIT");
    const associations = (await client.query("SELECT * FROM document_conversations WHERE json->>'kind'='session'"))
      .rows;
    assert.equal(associations.length, Object.keys(expected).length);
    for (const row of associations) assert.equal(row.json.bindingKey, expected[row.tenant_id + ":" + row.id]);
    assert.deepEqual((await client.query("SELECT * FROM sessions ORDER BY tenant_id,id")).rows, originalSessions);
    assert.deepEqual(
      (
        await client.query(
          "SELECT * FROM document_conversations WHERE json->>'kind'='conversation' ORDER BY tenant_id,id",
        )
      ).rows,
      originalBindings,
    );
    await assert.rejects(
      client.query("INSERT INTO document_conversations VALUES ($1,$2,$3)", [
        "00000000-0000-4000-8000-000000000001",
        "invalid",
        { kind: "session" },
      ]),
      /document_conversations_session_binding_key/,
    );
  } finally {
    await client.end();
  }
});

test("an association without a recoverable binding rolls migration changes back", async () => {
  const client = new pg.Client({ connectionString: testBareDatabaseUrl() });
  await client.connect();
  try {
    await client.query("CREATE TABLE sessions(tenant_id uuid, id text, thread_ref text)");
    await client.query("CREATE TABLE document_conversations(tenant_id uuid, id text, json jsonb)");
    await client.query("CREATE TABLE durable_map_versions(tbl text, v bigint)");
    const tenant = "00000000-0000-4000-8000-000000000001";
    const association = {
      kind: "session",
      documentKey: "document-a",
      projectId: "team",
      scopeId: "group:team",
      mode: "shared",
    };
    await client.query("INSERT INTO sessions VALUES ($1,'unbound','web:unbound')", [tenant]);
    await client.query("INSERT INTO document_conversations VALUES ($1,$2,$3)", [
      tenant,
      key("session", "unbound"),
      association,
    ]);
    await assert.rejects(async () => {
      await client.query("BEGIN");
      try {
        for (const sql of DOCUMENT_BINDING_KEYS_MIGRATION.statements) await client.query(sql);
        await client.query("COMMIT");
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      }
    }, /document_conversations_session_binding_key/);
    assert.deepEqual(
      (await client.query("SELECT json FROM document_conversations")).rows.map((row) => row.json),
      [association],
    );
    assert.equal(Number((await client.query("SELECT count(*) AS n FROM sessions")).rows[0].n), 1);
  } finally {
    await client.end();
  }
});
