import assert from "node:assert/strict";
import { test } from "node:test";
import pg from "pg";
import { ATTACHMENT_STAGING_MIGRATION } from "../src/sessions/attachment-migrations.ts";
import { testBareDatabaseUrl } from "./support/test-database.ts";

test("only reconstructable in-flight attachment selections are migrated", async () => {
  const client = new pg.Client({ connectionString: testBareDatabaseUrl() });
  await client.connect();
  try {
    await client.query("CREATE TABLE sessions(tenant_id uuid,id text,thread_ref text)");
    await client.query("CREATE TABLE runs(tenant_id uuid,id text,session_id text,status text)");
    await client.query(
      "CREATE TABLE items(tenant_id uuid,session_id text,turn_id uuid,seq bigint,kind text,tool text,call_id text,variant text,is_error boolean,body jsonb)",
    );
    const tenant = "00000000-0000-4000-8000-000000000001";
    const ids = [
      "11111111-1111-4111-8111-111111111111",
      "22222222-2222-4222-8222-222222222222",
      "33333333-3333-4333-8333-333333333333",
      "44444444-4444-4444-8444-444444444444",
    ];
    for (const selectedTenant of [tenant, "00000000-0000-4000-8000-000000000002"]) {
      const suffix = selectedTenant === tenant ? "" : "-foreign";
      for (const [index, id] of ids.entries()) {
        await client.query("INSERT INTO sessions VALUES($1,$2,'web:'||$2)", [selectedTenant, id]);
        await client.query("INSERT INTO runs VALUES($1,$2,'web:'||$2,$3)", [
          selectedTenant,
          id,
          index === 1 ? "done" : "pending",
        ]);
        const append = async (seq: number, kind: string, callId: string, body: unknown) =>
          client.query("INSERT INTO items VALUES($1,$2::text,$2::uuid,$3,$4,'attach',$5,NULL,false,$6)", [
            selectedTenant,
            id,
            seq,
            kind,
            callId,
            body,
          ]);
        await append(0, "ToolCall", "a", {
          files: index === 3 ? ["report.txt", "untracked.txt"] : [" \u00a0report.txt\u00a0 ", "report.txt"],
        });
        if (index === 2) await append(1, "ToolCall", "b", { files: ["report.txt"] });
        await append(2, "ToolResult", "a", {
          ok: true,
          files: [
            { artifactId: "old" + suffix, name: "report.txt", mimetype: "text/plain", sizeBytes: 3 },
            ...(index === 3 ? [{ name: "untracked.txt", mimetype: "text/plain", sizeBytes: 3 }] : []),
          ],
        });
        if (index !== 2) await append(3, "ToolCall", "b", { files: ["report.txt"] });
        await append(4, "ToolResult", "b", {
          ok: true,
          files: [{ artifactId: "new" + suffix, name: "report.txt", mimetype: "text/plain", sizeBytes: 3 }],
        });
      }
    }
    for (const sql of ATTACHMENT_STAGING_MIGRATION.statements) await client.query(sql);
    const rows = (
      await client.query(
        "SELECT tenant_id,turn_id,seq,body FROM items WHERE kind='ToolResult' ORDER BY tenant_id,turn_id,seq",
      )
    ).rows;
    const migrated = rows.filter((row) => row.turn_id === ids[0] && row.tenant_id === tenant);
    assert.deepEqual(
      migrated.map((row) => row.body.stagedRevision),
      [1, 2],
    );
    assert.deepEqual(
      migrated.map((row) => row.body.stagedFiles.map((file: { artifactId: string }) => file.artifactId)),
      [["old"], ["new"]],
    );
    assert.deepEqual(migrated[1]!.body.stagedFiles[0].key, ["path", null, "report.txt"]);
    assert.equal(migrated[1]!.body.stagedFiles[0].created, false);
    assert.ok(rows.filter((row) => row.turn_id !== ids[0]).every((row) => row.body.stagedFiles === undefined));
    assert.ok(rows.filter((row) => row.turn_id === ids[1]).every((row) => row.body.stagingRecoveryError === undefined));
    assert.ok(
      rows
        .filter((row) => row.turn_id === ids[2] || row.turn_id === ids[3])
        .every((row) => row.body.stagingRecoveryError === true),
    );
    const foreign = rows.filter((row) => row.turn_id === ids[0] && row.tenant_id !== tenant);
    assert.deepEqual(
      foreign[1]!.body.stagedFiles.map((file: { artifactId: string }) => file.artifactId),
      ["new-foreign"],
    );
    for (const sql of ATTACHMENT_STAGING_MIGRATION.statements) await client.query(sql);
    assert.deepEqual(
      (
        await client.query(
          "SELECT tenant_id,turn_id,seq,body FROM items WHERE kind='ToolResult' ORDER BY tenant_id,turn_id,seq",
        )
      ).rows,
      rows,
    );
  } finally {
    await client.end();
  }
});
