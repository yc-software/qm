import { definePgMigration, type PgMigrationDefinition } from "../persistence/pg-pool.ts";
import { TENANCY, tenantRowSecurity, tenantTables } from "../tenants/migrations.ts";
import { claimFunction } from "../tenants/claim.ts";
import { PERSONA_MIGRATIONS } from "./persona-schema.ts";

const PERSONA_VERSION_TENANCY = tenantTables(
  "users/v2/0004-tenants/2-persona-versions",
  [{ table: "persona_versions", primaryKey: "persona_id, version" }],
  {
    references: [
      {
        table: "persona_versions",
        name: "persona_versions_persona_id_fkey",
        columns: "persona_id",
        references: "personas(tenant_id, id)",
        onDelete: "CASCADE",
      },
      {
        table: "persona_versions",
        name: "persona_versions_edited_by_fkey",
        columns: "edited_by",
        references: "users(tenant_id, id)",
      },
    ],
  },
).filter((migration) => !TENANCY.includes(migration));

const PIN_TENANCY: PgMigrationDefinition[] = [
  {
    id: "users/v2/0007-tenant-pin/1-index",
    statements: [
      `CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS persona_access_one_pin_tenant
         ON persona_access(tenant_id, grantee_scope_id) WHERE pinned`,
    ],
  },
  {
    id: "users/v2/0007-tenant-pin/2-swap",
    statements: [
      `SET LOCAL lock_timeout = '5s'`,
      `DROP INDEX persona_access_one_pin`,
      `ALTER INDEX persona_access_one_pin_tenant RENAME TO persona_access_one_pin`,
    ],
  },
];

const GROUP_GRANTEES: PgMigrationDefinition = {
  id: "users/v2/0009-persona-group-grantees",
  statements: [
    `SET LOCAL lock_timeout = '5s'`,
    `ALTER TABLE persona_access DROP CONSTRAINT persona_access_grantee_scope_id_check`,
    `ALTER TABLE persona_access ADD CONSTRAINT persona_access_grantee_scope_id_check
       CHECK (split_part(grantee_scope_id, ':', 1) IN ('personal', 'team', 'org', 'channel', 'group'))`,
  ],
};

const statements = (sql: readonly string[]): string => sql.map((statement) => `${statement};`).join("\n  ");

function catchUp(): PgMigrationDefinition {
  const settled = [...PERSONA_MIGRATIONS.slice(1), ...PERSONA_VERSION_TENANCY, ...PIN_TENANCY];
  const ledger = settled.map((migration) => `('${migration.id}', '${definePgMigration(migration).checksum}')`);
  return {
    id: "users/v2/0004-tenants/2-persona-catch-up",
    statements: [
      `DO $persona_catch_up$
BEGIN
  IF EXISTS (SELECT 1 FROM qm_schema_migrations WHERE id = '${PERSONA_MIGRATIONS[1]!.id}') THEN RETURN; END IF;
  CREATE TABLE persona_versions(
    persona_id    TEXT        NOT NULL,
    version       INT         NOT NULL CHECK (version > 0),
    name          TEXT        NOT NULL,
    description   TEXT        NOT NULL,
    instructions  TEXT        NOT NULL,
    icon          JSONB,
    restored_from INT,
    edited_by     UUID        NOT NULL,
    edited_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    tenant_id     UUID        NOT NULL,
    CONSTRAINT persona_versions_pkey PRIMARY KEY (tenant_id, persona_id, version),
    CONSTRAINT persona_versions_persona_id_fkey FOREIGN KEY (tenant_id, persona_id)
      REFERENCES personas(tenant_id, id) ON DELETE CASCADE,
    CONSTRAINT persona_versions_edited_by_fkey FOREIGN KEY (tenant_id, edited_by) REFERENCES users(tenant_id, id)
  );
  ${statements(tenantRowSecurity("persona_versions"))}
  INSERT INTO persona_versions (tenant_id, persona_id, version, name, description, instructions, icon, edited_by, edited_at)
  SELECT tenant_id, id, 1, name, description, instructions, icon, created_by, updated_at FROM personas
  ON CONFLICT DO NOTHING;
  INSERT INTO persona_access (tenant_id, persona_id, grantee_scope_id, role, granted_by)
  SELECT p.tenant_id, p.id, 'personal:' || u.primary_alias, 'owner', p.created_by
    FROM personas p JOIN users u ON u.tenant_id = p.tenant_id AND u.id = p.created_by
   WHERE NOT EXISTS (SELECT 1 FROM persona_access o
                      WHERE o.tenant_id = p.tenant_id AND o.persona_id = p.id AND o.role = 'owner'
                        AND o.grantee_scope_id NOT LIKE 'channel:%')
  ON CONFLICT (tenant_id, persona_id, grantee_scope_id) DO UPDATE SET role = 'owner';
  UPDATE persona_access SET role = 'read' WHERE grantee_scope_id LIKE 'channel:%' AND role <> 'read';
  ALTER TABLE persona_access ADD COLUMN IF NOT EXISTS pinned BOOLEAN NOT NULL DEFAULT false;
  CREATE UNIQUE INDEX persona_access_one_pin ON persona_access(tenant_id, grantee_scope_id) WHERE pinned;
  IF to_regclass('persona_channel_defaults') IS NOT NULL THEN
    INSERT INTO persona_access (tenant_id, persona_id, grantee_scope_id, role, granted_by, pinned)
    SELECT p.tenant_id, p.id, d.id, 'read',
           COALESCE(
             (SELECT l.user_id FROM user_links l WHERE l.tenant_id = d.tenant_id AND l.alias_id = d.json->>'setBy'),
             p.created_by),
           true
      FROM persona_channel_defaults d
      JOIN personas p ON p.tenant_id = d.tenant_id AND p.id = d.json->>'personaId'
     WHERE d.id LIKE 'channel:%'
    ON CONFLICT (tenant_id, persona_id, grantee_scope_id) DO UPDATE SET pinned = true;
    DROP TABLE persona_channel_defaults;
  END IF;
  INSERT INTO qm_schema_migrations(id, checksum) VALUES ${ledger.join(", ")} ON CONFLICT (id) DO NOTHING;
END $persona_catch_up$`,
    ],
  };
}

const PERSONA_CLAIMS: PgMigrationDefinition = {
  id: "users/v2/0007-persona-claims",
  statements: [
    claimFunction(
      "claim_persona_tenants",
      "",
      "SELECT DISTINCT tenant_id, 'personas'::text FROM personas ORDER BY tenant_id",
    ),
  ],
};

export const PERSONA_TENANCY: PgMigrationDefinition[] = [
  PERSONA_CLAIMS,
  catchUp(),
  ...PERSONA_VERSION_TENANCY,
  ...PIN_TENANCY,
  GROUP_GRANTEES,
];
