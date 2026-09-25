import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { promisify } from "node:util";
import test from "node:test";
import pg from "pg";
import { legacyCronGrantsMigration } from "../src/credentials/legacy-cron-grants-migration.ts";
import { applyPgMigrations, definePgMigration } from "../src/persistence/pg-pool.ts";
import { hashId } from "../src/util/crypto.ts";

const databaseUrl = process.env.DATABASE_URL;
const exec = promisify(execFile);
const cutoff = Date.parse("2026-09-23T05:48:09Z");
const old = cutoff - 1;
const protectedPrincipals = [
  "protected-login@example.test",
  "protected-manual@example.test",
  "protected-expired@example.test",
];

test(
  "startup grants legacy personal crons existing credentials once without overriding consent",
  { skip: !databaseUrl },
  async () => {
    const parent = new pg.Pool({ connectionString: databaseUrl });
    const name = `cron_grants_${randomUUID().replaceAll("-", "")}`;
    await parent.query(`CREATE DATABASE ${name}`);
    const url = new URL(databaseUrl!);
    url.pathname = `/${name}`;
    const db = new pg.Pool({ connectionString: url.toString() });
    const put = async (table: string, id: string, json: object) => {
      await db.query(`INSERT INTO ${table}(id, json) VALUES ($1, $2)`, [id, json]);
    };
    const cron = async (owner: string, patch: object = {}) => {
      const id = randomUUID();
      await put("crons", id, {
        id,
        owner,
        ownerScopeId: `personal:${owner}`,
        action: "Summarize my work",
        schedule: { everyMs: 60_000 },
        enabled: true,
        createdAt: old,
        ...patch,
      });
    };
    const credential = async (id: string, ownerId: string, patch: object = {}) => {
      await put("keychain_credentials", id, {
        id,
        ownerId,
        kind: "env",
        service: "example",
        envKey: "EXAMPLE_TOKEN",
        createdAt: old,
        updatedAt: old,
        ...patch,
      });
    };
    const connector = async (
      owner: string,
      account: string = "",
      patch: object = {},
      host = "gmail.googleapis.com",
    ) => {
      const id = hashId([owner, host, `oauth:${account}`]);
      await credential(id, owner, {
        managed: "connector",
        host,
        refresh: { accountType: account || "default" },
        ...patch,
      });
      return id;
    };
    const migrate = (protectedOwners = protectedPrincipals) =>
      exec(process.execPath, ["src/migrate-main.ts"], {
        cwd: new URL("..", import.meta.url),
        timeout: 60_000,
        env: {
          PATH: process.env.PATH,
          NODE_ENV: "test",
          DATABASE_URL: url.toString(),
          SANDBOX_BACKEND: "local",
          SESSION_STORE: "postgres",
          ORG_ID: "migration-test",
          ...(protectedOwners.length ? { AUTH_ALLOWED_EMAILS: protectedOwners.join(",") } : {}),
          CONNECTOR_SECRET_KEY: "test-connector-secret-0123456789abcdef",
        },
      });
    const grants = async () => (await db.query("SELECT json FROM keychain_grants ORDER BY id")).rows.map((r) => r.json);
    try {
      for (const table of [
        "crons",
        "keychain_credentials",
        "keychain_grants",
        "keychain_asks",
        "principal_links",
        "deactivated_principals",
        "external_members",
        "internal_member_overrides",
      ]) {
        await db.query(`CREATE TABLE ${table}(id TEXT PRIMARY KEY, json JSONB NOT NULL)`);
      }
      await cron("U_OWNER", { unattendedGrants: ["existing-capability"] });
      await cron("U_OWNER");
      await credential("env", "U_OWNER");
      const oauth = await connector("U_OWNER");
      const refreshable = await connector(
        "U_OWNER",
        "",
        {
          expiresAt: old,
          refresh: { refreshTokenEnc: "synthetic-ciphertext" },
        },
        "api.github.com",
      );
      const expectedConnectors = [oauth, refreshable];
      for (const owner of ["U_ACCOUNTS", "U_DEFAULT", "U_COMPANY", "U_REFRESH", "U_RETRY", "U_REVOKED", "U_METADATA"])
        await cron(owner);
      expectedConnectors.push(await connector("U_ACCOUNTS", "personal"));
      await connector("U_ACCOUNTS");
      await connector("U_ACCOUNTS", "company");
      await connector("U_DEFAULT", "personal", {
        expiresAt: old,
        refresh: { accountType: "personal" },
      });
      expectedConnectors.push(await connector("U_DEFAULT"));
      await connector("U_DEFAULT", "company");
      await connector("U_COMPANY", "personal", { expiresAt: old });
      await connector("U_COMPANY", "", { expiresAt: old });
      expectedConnectors.push(await connector("U_COMPANY", "company"));
      expectedConnectors.push(
        await connector("U_REFRESH", "personal", { expiresAt: old, refresh: { refreshTokenEnc: "refreshable" } }),
      );
      await connector("U_REFRESH");
      expectedConnectors.push(
        await connector("U_RETRY", "personal", {
          expiresAt: old,
          refresh: { refreshTokenEnc: "retryable-token", refreshFailedAt: old },
        }),
      );
      await connector("U_RETRY", "company");
      const revokedConnector = await connector("U_REVOKED", "personal");
      await connector("U_REVOKED");
      await put("keychain_grants", "revoked-connector", {
        id: "revoked-connector",
        credentialId: revokedConnector,
        audienceScopeId: "personal:U_REVOKED",
        status: "revoked",
        mode: "once",
      });
      expectedConnectors.push(await connector("U_METADATA", "", { refresh: { accountType: "personal" } }));
      await connector("U_METADATA", "company");
      await cron("U_PAUSED", { enabled: false, runAs: "owner" });
      await credential("paused", "U_PAUSED");
      await cron("U_PAUSED_ONCE", {
        enabled: false,
        schedule: { firstFireAt: Date.now() + 60_000 },
        nextFireAt: Date.now() + 60_000,
      });
      await credential("paused-once", "U_PAUSED_ONCE");
      await put("principal_links", "U_ALIAS", { principalId: "U_ALIAS", canonicalId: "owner@example.test" });
      await cron("U_ALIAS");
      await credential("canonical", "owner@example.test");
      await credential("alias", "U_ALIAS");
      await connector("U_ALIAS");
      for (const [owner, patch] of [
        ["U_NEW", { createdAt: cutoff }],
        ["U_ARCHIVED", { archived: true }],
        ["U_MESSAGE", { message: "A static reminder" }],
        ["U_EMPTY", { action: " " }],
        ["U_COMPLETED", { enabled: false, schedule: { firstFireAt: old }, lastFiredAt: old }],
        ["U_CHANNEL", { ownerScopeId: "channel:C1" }],
        ["U_OTHER_HOME", { ownerScopeId: "personal:U_OWNER" }],
        ["U_FLOOR", { runAs: "scopeFloor" }],
        ["U_SHARED", { runAs: "scopeShared" }],
      ] as const) {
        await cron(owner, patch);
        await credential(owner, owner);
      }
      await credential("no-cron", "U_NO_CRON");
      for (const [id, patch] of [
        ["new", { createdAt: cutoff }],
        ["file", { kind: "file" }],
        ["broker", { kind: "broker" }],
        ["backend", { envKey: "COMPOSIO_API_KEY" }],
        ["backend-fields", { fields: [{ envKey: "COMPOSIO_API_KEY", secret: true }] }],
        ["expired", { expiresAt: old }],
        ["expired-oauth", { managed: "connector", host: "api.linear.app", expiresAt: old }],
        [
          "model-oauth",
          { managed: "connector", host: "auth.openai.com", refresh: { accountType: "individual-model" } },
        ],
      ] as const)
        await credential(id, "U_OWNER", patch);
      for (const status of ["active", "revoked", "used", "expired-standing", "revoked-standing"]) {
        await credential(status, "U_OWNER");
        let grantStatus = status;
        if (status === "expired-standing") grantStatus = "active";
        if (status === "revoked-standing") grantStatus = "revoked";
        await put("keychain_grants", status, {
          id: status,
          credentialId: status,
          ownerId: "U_OWNER",
          audienceScopeId: "personal:U_OWNER",
          status: grantStatus,
          mode: status.endsWith("standing") ? "standing" : "once",
          createdAt: old,
          ...(status === "expired-standing" ? { expiresAt: old } : {}),
        });
      }
      await credential("declined", "U_ALIAS");
      await put("keychain_asks", "declined", {
        id: "declined",
        credentialId: "declined",
        requesterScopeId: "personal:U_ALIAS",
        status: "declined",
      });
      await credential("alias-revoked", "owner@example.test");
      await put("keychain_grants", "alias-revoked", {
        id: "alias-revoked",
        credentialId: "alias-revoked",
        audienceScopeId: "personal:U_ALIAS",
        mode: "once",
        status: "revoked",
      });
      await cron("U_DELETED");
      await credential("deactivated", "U_DELETED");
      await put("principal_links", "U_DELETED_ALIAS", { principalId: "U_DELETED_ALIAS", canonicalId: "U_DELETED" });
      await put("deactivated_principals", "U_DELETED_ALIAS", { principalId: "U_DELETED_ALIAS", source: "manual" });
      await cron("former@example.test");
      await credential("expired-member", "former@example.test");
      await put("external_members", "former@example.test", { email: "former@example.test", expiresAt: old });
      const identityCredentials = [];
      for (const [owner, source, external, expected] of [
        ["reinstated@example.test", "directory-sync", { kind: "teammate", expiresAt: null }, true],
        ["manual-teammate@example.test", "manual", { kind: "teammate", expiresAt: null }, false],
        ["U_DIRECTORY_ONLY", "directory-sync", undefined, false],
        ["protected@example.test", "directory-sync", undefined, true],
        ["protected-manual@example.test", "manual", undefined, false],
        ["protected-expired@example.test", "directory-sync", { expiresAt: old }, false],
        ["U_OVERRIDE", "manual", undefined, true],
        ["override-expired@example.test", "directory-sync", { expiresAt: old }, true],
        ["U_FOREIGN_OVERRIDE", "manual", undefined, false],
      ] as const) {
        await cron(owner);
        await credential(owner, owner);
        await put("deactivated_principals", owner, { principalId: owner, source });
        if (external) await put("external_members", owner, { email: owner, ...external });
        if (expected) identityCredentials.push(owner);
      }
      await put("principal_links", "protected-login@example.test", {
        principalId: "protected-login@example.test",
        canonicalId: "protected@example.test",
      });
      await put("principal_links", "former-alias@example.test", {
        principalId: "former-alias@example.test",
        canonicalId: "reinstated@example.test",
      });
      await put("external_members", "former-alias@example.test", {
        email: "former-alias@example.test",
        expiresAt: old,
      });
      for (const [alias, canonical, expected] of [
        ["U_OVERRIDE_ALIAS", "override-alias@example.test", true],
        ["U_CANONICAL_OVERRIDE_ALIAS", "canonical-override@example.test", false],
      ] as const) {
        await put("principal_links", alias, { principalId: alias, canonicalId: canonical });
        await cron(alias);
        await credential(canonical, canonical);
        await put("deactivated_principals", canonical, { principalId: canonical, source: "manual" });
        if (expected) identityCredentials.push(canonical);
      }
      await put("internal_member_overrides", "org:migration-test", {
        members: ["u_override", "override-expired@example.test", "u_override_alias", "canonical-override@example.test"],
      });
      await put("internal_member_overrides", "org:other", { members: ["u_foreign_override"] });
      const originalCrons = (await db.query("SELECT id, json FROM crons ORDER BY id")).rows;
      const originalGrants = await grants();
      await migrate();
      const migrated = (await grants()).filter((g) => !originalGrants.some((original) => original.id === g.id));
      assert.deepEqual(
        migrated.map((g) => g.credentialId).sort(),
        ["alias", "canonical", "env", "paused", "paused-once", ...expectedConnectors, ...identityCredentials].sort(),
      );
      for (const grant of migrated) {
        assert.equal(grant.status, "active");
        assert.equal(
          grant.audienceScopeId,
          ["alias", "canonical"].includes(grant.credentialId)
            ? "personal:owner@example.test"
            : `personal:${grant.ownerId}`,
        );
        assert.match(grant.purpose, /legacy.*cron/i);
      }
      assert.deepEqual(
        (await grants()).filter((g) => originalGrants.some((original) => original.id === g.id)),
        originalGrants,
      );
      assert.deepEqual((await db.query("SELECT id, json FROM crons ORDER BY id")).rows, originalCrons);
      await db.query("DELETE FROM keychain_grants WHERE id = ANY($1::text[])", [migrated.map((grant) => grant.id)]);
      await db.query("DELETE FROM qm_schema_migrations WHERE id = $1", [legacyCronGrantsMigration.id]);
      const other = new pg.Pool({ connectionString: url.toString() });
      try {
        const migration = definePgMigration(
          legacyCronGrantsMigration.id,
          legacyCronGrantsMigration.statements,
          undefined,
          undefined,
          [[], [protectedPrincipals, "org:migration-test"]],
        );
        const concurrent = await Promise.allSettled([
          applyPgMigrations(db, [migration]),
          applyPgMigrations(other, [migration]),
        ]);
        for (const result of concurrent) if (result.status === "rejected") throw result.reason;
        assert.deepEqual(
          (await grants()).map((grant) => grant.id),
          [...originalGrants, ...migrated].map((grant) => grant.id).sort(),
        );
      } finally {
        await other.end();
      }
      const version = (await db.query("SELECT v FROM durable_map_versions WHERE tbl = 'keychain_grants'")).rows[0]?.v;
      assert.ok(Number(version) > 0);
      await db.query(
        "UPDATE keychain_grants SET json = jsonb_set(json, '{status}', '\"revoked\"') WHERE json->>'credentialId' = 'env'",
      );
      const revoked = await grants();
      await credential("added-after-migration", "U_OWNER");
      await cron("U_AFTER_MIGRATION");
      await credential("later-cron", "U_AFTER_MIGRATION");
      await migrate([]);
      assert.deepEqual(await grants(), revoked);
      assert.equal(
        (await db.query("SELECT v FROM durable_map_versions WHERE tbl = 'keychain_grants'")).rows[0]?.v,
        version,
      );
    } finally {
      await db.end();
      await parent.query(`DROP DATABASE ${name} WITH (FORCE)`);
      await parent.end();
    }
  },
);
