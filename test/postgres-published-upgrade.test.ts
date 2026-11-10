import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { promisify } from "node:util";
import test from "node:test";
import pg from "pg";
import { createPostgresSessionStore } from "../src/sessions/postgres-session-store.ts";
import { applyPgMigrations, definePgMigration } from "../src/persistence/pg-pool.ts";
import { PUBLISHED_SESSION_UPGRADE } from "../src/sessions/published-upgrade.ts";
import { testBareDatabaseUrl } from "./support/test-database.ts";
import { withTenant } from "../src/tenants/context.ts";

const exec = promisify(execFile);
const skip = !process.env.DATABASE_URL;
const turnId = "11111111-1111-4111-8111-111111111111";
const callId = "22222222-2222-4222-8222-222222222222";

async function migrate(url: string): Promise<void> {
  const result = await exec(process.execPath, ["src/migrate-main.ts"], {
    cwd: new URL("..", import.meta.url),
    timeout: 60_000,
    env: {
      PATH: process.env.PATH,
      NODE_ENV: "test",
      DATABASE_URL: url,
      SANDBOX_BACKEND: "local",
      ORG_ID: "upgrade-test",
      CONNECTOR_SECRET_KEY: "test-connector-secret-0123456789abcdef",
    },
  });
  assert.match(result.stdout, /database migrations applied/);
}

for (const interrupted of [false, true]) {
  test(
    `upgrade a populated published 0.1.15 database and restart; restart after history copy: ${interrupted}`,
    { skip },
    async () => {
      const url = testBareDatabaseUrl();
      const db = new pg.Pool({ connectionString: url });
      try {
        await db.query(await readFile(new URL("fixtures/upgrades/0.1.15.sql", import.meta.url), "utf8"));
        await db.query("SET search_path = public");
        await db.query(`INSERT INTO sessions(id, type, scope_id, thread_ref, created_at, title)
        VALUES ('conversation', 'dm', 'personal:alice', 'web:upgrade', 1000, 'Saved conversation'),
               ('scheduled', 'dm', 'personal:alice', 'cron:morning:run', 1000, 'Morning task')`);
        await db.query(`INSERT INTO participants(session_id, principal_id, valid_from, valid_from_seq, title, pinned)
        VALUES ('conversation', 'alice', 0, 0, 'My title', true)`);
        const entries = [
          ["user", { text: "Remember the grocery list", name: "Alice" }],
          ["tool_call", { tool: "execute", callId, arguments: { command: "printf apples" }, runId: turnId }],
          ["tool_result", { tool: "execute", callId, result: "apples", runId: turnId }],
          ["assistant", { text: "Apples are on the list.", runId: turnId }],
        ];
        for (const [seq, [type, payload]] of entries.entries()) {
          await db.query(
            `INSERT INTO session_entries(session_id, seq, type, payload, scope_label, created_at)
          VALUES ('conversation', $1, $2, $3, 'personal:alice', $4)`,
            [seq, type, JSON.stringify(payload), 2000 + seq],
          );
        }
        await db.query(
          `INSERT INTO runs(id, session_id, status, request, result, created_at)
        VALUES ($1, 'conversation', 'done', '{"triggered":true,"triggerDestination":{"kind":"slack","channel":"C-test","slackAccountId":"test-account","slackTeamId":"T-test"}}', '{}', 2000)`,
          [turnId],
        );
        await db.query(`INSERT INTO directory_members(org_id, principal_id, display_name, display_name_lc, type)
        VALUES ('upgrade-test', 'alice', 'Alice', 'alice', 'internal')`);
        if (interrupted) {
          await applyPgMigrations(
            db,
            PUBLISHED_SESSION_UPGRADE.filter((m) => m.id <= "sessions/store/0035-items").map(definePgMigration),
          );
          assert.equal((await db.query("SELECT count(*)::int AS n FROM items")).rows[0].n, 4);
        }
        await migrate(url);
        const tenant = (await db.query<{ id: string }>("SELECT id FROM tenants")).rows[0]!.id;
        const store = createPostgresSessionStore(url);
        const sessions = {
          getItems: (id: string) => withTenant(tenant, () => store.getItems(id)),
          get: (id: string) => withTenant(tenant, () => store.get(id)),
          append: (...args: Parameters<typeof store.append>) => withTenant(tenant, () => store.append(...args)),
        };
        const items = await sessions.getItems("conversation");
        assert.deepEqual(
          items.map((item) => [item.seq, item.kind, item.text]),
          [
            [0, "UserMessage", "Remember the grocery list"],
            [1, "ToolCall", null],
            [2, "ToolResult", "apples"],
            [3, "AgentMessage", "Apples are on the list."],
          ],
        );
        assert.equal(items[1]!.callId, callId);
        assert.equal(items[2]!.callId, callId);
        assert.equal(items[2]!.turnId, turnId);
        assert.equal(items[0]!.author, "alice");
        assert.equal((await sessions.get("conversation"))?.title, "Saved conversation");
        assert.equal(
          (await db.query("SELECT origin, origin_id FROM sessions WHERE id='scheduled'")).rows[0].origin_id,
          "morning",
        );
        assert.deepEqual((await db.query("SELECT principal_id, title, pinned FROM participants")).rows, [
          { principal_id: "alice", title: "My title", pinned: true },
        ]);
        assert.equal((await db.query("SELECT count(*)::int AS n FROM runs")).rows[0].n, 1);
        assert.equal(
          (await db.query("SELECT display_name FROM directory_members WHERE principal_id='alice'")).rows[0]
            .display_name,
          "Alice",
        );
        assert.equal((await db.query("SELECT to_regclass('session_entries') AS name")).rows[0].name, null);
        const request = JSON.parse((await db.query("SELECT request FROM runs")).rows[0].request);
        assert.equal(request.origin.kind, "automation");
        assert.deepEqual(request.origin.destination.account, { id: "test-account", workspace: "T-test" });
        const ledger = (await db.query("SELECT id, checksum FROM qm_schema_migrations ORDER BY id")).rows;
        await migrate(url);
        assert.deepEqual((await db.query("SELECT id, checksum FROM qm_schema_migrations ORDER BY id")).rows, ledger);
        assert.deepEqual(await sessions.getItems("conversation"), items);
        const added = await sessions.append(
          { sessionId: "conversation" },
          { kind: "AgentMessage", text: "After upgrade" },
        );
        assert.equal(added.seq, 4);
        assert.equal((await sessions.getItems("conversation")).at(-1)?.text, "After upgrade");
      } finally {
        await db.end();
      }
    },
  );
}

test("published surface upgrade preserves request carriers, Slack access and destinations", { skip }, async () => {
  const url = testBareDatabaseUrl();
  let db = new pg.Pool({ connectionString: url });
  try {
    await migrate(url);
    const tenant = (await db.query<{ id: string }>("SELECT id FROM tenants")).rows[0]!.id;
    await db.end();
    db = new pg.Pool({ connectionString: url, options: `-c qm.tenant_id=${tenant}` });
    const { PUBLISHED_ORIGIN_UPGRADE } = await import("../src/surfaces/published-upgrade.ts");
    await db.query(
      "INSERT INTO qm_schema_migrations(id, checksum) VALUES ('sessions/store/0033-client-tools', 'fixture')",
    );
    const source = {
      accountId: "partner",
      teamId: "T-test",
      userId: "U-test",
      replyThreadTs: "1.0",
      externalPolicyNamespace: "policy",
    };
    const access = {
      companyDomains: ["example.test"],
      companyTeamIds: ["T-test"],
      serviceCredentials: ["service:test"],
    };
    const destination = {
      type: "slack",
      target: "C-test",
      slackAccountId: "partner",
      slackTeamId: "T-test",
      slackPolicyNamespace: "policy",
    };
    const request = {
      text: "keep me",
      slackSource: source,
      externalSlack: access,
      liveActor: true,
      triggerTs: "1.0",
      origin: { kind: "human", messageTs: "1.0" },
    };
    await db.query(
      "INSERT INTO runs(id,session_id,status,request,created_at) VALUES ('pending','session','pending',$1,1)",
      [JSON.stringify(request)],
    );
    await db.query("INSERT INTO approvals(id,json) VALUES ('approval',$1)", [
      JSON.stringify({ request, command: "keep this command" }),
    ]);
    await db.query("INSERT INTO run_signals(run_id,kind,payload,created_at) VALUES ('pending','steer',$1,1)", [
      JSON.stringify({ request, sessionRequest: request, other: "keep" }),
    ]);
    await db.query(
      "INSERT INTO sessions(id,type,scope_id,thread_ref,created_at,spawn_meta,slack_binding) VALUES ('session','dm','personal:alice','web:surface',1,$1,$2)",
      [JSON.stringify({ externalSlack: access, text: "child" }), JSON.stringify(source)],
    );
    const typedBinding = {
      author: { surface: "slack", account: "partner", id: "U-test" },
      workspace: "T-test",
      policyNamespace: "policy",
      replyThread: "1.0",
      audience: "internal",
    };
    await db.query(
      "INSERT INTO sessions(id,type,scope_id,thread_ref,created_at,spawn_meta,slack_binding) VALUES ('typed-session','dm','personal:alice','web:typed-surface',1,$1,$2)",
      [JSON.stringify({ externalSlack: access, text: "child" }), JSON.stringify(typedBinding)],
    );
    await db.query(
      "INSERT INTO deliveries(id,idempotency_key,destination,text,created_at) VALUES ('delivery','delivery',$1,'keep delivery',1)",
      [JSON.stringify(destination)],
    );
    for (const table of ["crons", "loops", "webhooks", "monitors", "secret_drops", "keychain_asks"]) {
      const key = table === "keychain_asks" ? "requesterDestination" : "destination";
      await db.query(`INSERT INTO ${table}(id,json) VALUES ('saved',$1)`, [
        JSON.stringify({ [key]: destination, other: "keep" }),
      ]);
    }
    await applyPgMigrations(db, [definePgMigration(PUBLISHED_ORIGIN_UPGRADE)]);
    const converted = JSON.parse((await db.query("SELECT request FROM runs WHERE id='pending'")).rows[0].request);
    assert.deepEqual(converted.origin, { kind: "human", messageTs: "1.0" });
    assert.deepEqual(converted.surfaceOrigin, {
      author: { surface: "slack", account: "partner", id: "U-test" },
      workspace: "T-test",
      policyNamespace: "policy",
      replyThread: "1.0",
      audience: "external",
      access,
    });
    assert.equal(converted.text, "keep me");
    assert.equal(converted.slackSource, undefined);
    const approval = (await db.query("SELECT json FROM approvals WHERE id='approval'")).rows[0].json;
    assert.deepEqual(approval, { request: converted, command: "keep this command" });
    assert.deepEqual((await db.query("SELECT payload FROM run_signals")).rows[0].payload, {
      request: converted,
      sessionRequest: converted,
      other: "keep",
    });
    const session = (await db.query("SELECT spawn_meta,slack_binding FROM sessions WHERE id='session'")).rows[0];
    for (const id of ["session", "typed-session"]) {
      const row = (await db.query("SELECT spawn_meta FROM sessions WHERE id=$1", [id])).rows[0];
      assert.deepEqual(JSON.parse(row.spawn_meta).surfaceOrigin, { ...typedBinding, audience: "external", access });
    }
    assert.equal(JSON.parse(session.spawn_meta).surfaceOrigin.author.id, "U-test");
    assert.deepEqual(JSON.parse(session.spawn_meta).surfaceOrigin.access, access);
    assert.deepEqual(session.slack_binding.author, { surface: "slack", account: "partner", id: "U-test" });
    const expectedDestination = {
      type: "slack",
      target: "C-test",
      account: { id: "partner", workspace: "T-test", policyNamespace: "policy" },
    };
    assert.deepEqual((await db.query("SELECT destination FROM deliveries")).rows[0].destination, expectedDestination);
    for (const table of ["crons", "loops", "webhooks", "monitors", "secret_drops", "keychain_asks"]) {
      const key = table === "keychain_asks" ? "requesterDestination" : "destination";
      assert.deepEqual((await db.query(`SELECT json FROM ${table} WHERE id='saved'`)).rows[0].json, {
        [key]: expectedDestination,
        other: "keep",
      });
    }
    await db.query("DELETE FROM qm_schema_migrations WHERE id=$1", [PUBLISHED_ORIGIN_UPGRADE.id]);
    await applyPgMigrations(db, [definePgMigration(PUBLISHED_ORIGIN_UPGRADE)]);
    assert.deepEqual(
      JSON.parse((await db.query("SELECT request FROM runs WHERE id='pending'")).rows[0].request),
      converted,
    );
  } finally {
    await db.end();
  }
});
