import type { Pool, PoolClient } from "pg";
import {
  openTenantSecret,
  sealTenantSecrets,
  settingsFromEnv,
  TENANT_TEXT_SETTINGS,
} from "../../plugins/chassis/src/tenant-settings.ts";

export const TENANT_BYPASS_OPTION = "-c qm.tenant_bypass=on";

export const TENANCY_EXCLUDED_TABLES = ["qm_tenant", "tenants", "qm_schema_migrations"];

const EXCLUDED = TENANCY_EXCLUDED_TABLES.map((t) => `'${t}'`).join(", ");

const TENANCY_FUNCTIONS: readonly string[] = [
  `CREATE TABLE IF NOT EXISTS qm_tenant(id UUID PRIMARY KEY)`,
  `CREATE UNIQUE INDEX IF NOT EXISTS qm_tenant_singleton ON qm_tenant((true))`,
  `INSERT INTO qm_tenant(id) SELECT gen_random_uuid() WHERE NOT EXISTS (SELECT 1 FROM qm_tenant)`,
  `CREATE TABLE IF NOT EXISTS tenants(
     id UUID PRIMARY KEY,
     slug TEXT NOT NULL UNIQUE,
     org_id TEXT NOT NULL,
     hosts TEXT[] NOT NULL DEFAULT '{}',
     status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'suspended')),
     created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
     updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
   )`,
  `ALTER TABLE tenants
     ADD COLUMN IF NOT EXISTS apps_domain TEXT,
     ADD COLUMN IF NOT EXISTS s3_bucket TEXT,
     ADD COLUMN IF NOT EXISTS sandbox_name_prefix TEXT,
     ADD COLUMN IF NOT EXISTS modal_app_name TEXT,
     ADD COLUMN IF NOT EXISTS modal_environment TEXT,
     ADD COLUMN IF NOT EXISTS modal_snapshot_bucket TEXT,
     ADD COLUMN IF NOT EXISTS aws_sandbox_bucket TEXT,
     ADD COLUMN IF NOT EXISTS sentry_deployment TEXT,
     ADD COLUMN IF NOT EXISTS favicon_svg TEXT,
     ADD COLUMN IF NOT EXISTS oidc_client_id TEXT,
     ADD COLUMN IF NOT EXISTS oidc_label TEXT,
     ADD COLUMN IF NOT EXISTS oidc_admin BOOLEAN NOT NULL DEFAULT false,
     ADD COLUMN IF NOT EXISTS secrets BYTEA`,
  `CREATE OR REPLACE FUNCTION qm_tenants_changed() RETURNS trigger LANGUAGE plpgsql
   AS $qm_tenants_changed$ BEGIN PERFORM pg_notify('qm_tenants', TG_OP); RETURN NULL; END $qm_tenants_changed$`,
  `CREATE OR REPLACE TRIGGER tenants_changed AFTER INSERT OR UPDATE OR DELETE OR TRUNCATE ON tenants
   FOR EACH STATEMENT EXECUTE FUNCTION qm_tenants_changed()`,
  `CREATE OR REPLACE FUNCTION qm_tenant_id() RETURNS uuid LANGUAGE sql STABLE PARALLEL SAFE
   AS $qm_tenant_id$
     SELECT COALESCE(NULLIF(current_setting('qm.tenant_id', true), '')::uuid, (SELECT id FROM qm_tenant))
   $qm_tenant_id$`,
  `CREATE OR REPLACE FUNCTION qm_tenant_bypass() RETURNS boolean LANGUAGE sql STABLE PARALLEL SAFE
   AS $qm_tenant_bypass$ SELECT COALESCE(current_setting('qm.tenant_bypass', true), '') = 'on' $qm_tenant_bypass$`,
  `CREATE OR REPLACE FUNCTION qm_tenant_columns(rel oid, attnums smallint[]) RETURNS text LANGUAGE sql STABLE
   AS $qm_tenant_columns$
     SELECT string_agg(quote_ident(a.attname), ', ' ORDER BY k.ord)
     FROM unnest(attnums) WITH ORDINALITY k(attnum, ord)
     JOIN pg_attribute a ON a.attrelid = rel AND a.attnum = k.attnum
   $qm_tenant_columns$`,
  `CREATE OR REPLACE FUNCTION qm_tenant_fk_def(con oid) RETURNS text LANGUAGE sql STABLE AS $qm_tenant_fk_def$
     SELECT format('FOREIGN KEY (tenant_id, %s) REFERENCES %s(tenant_id, %s)%s%s%s%s%s%s',
       qm_tenant_columns(c.conrelid, c.conkey),
       c.confrelid::regclass,
       qm_tenant_columns(c.confrelid, c.confkey),
       CASE c.confmatchtype WHEN 'f' THEN ' MATCH FULL' WHEN 'p' THEN ' MATCH PARTIAL' ELSE '' END,
       CASE c.confupdtype
         WHEN 'r' THEN ' ON UPDATE RESTRICT' WHEN 'c' THEN ' ON UPDATE CASCADE'
         WHEN 'n' THEN ' ON UPDATE SET NULL' WHEN 'd' THEN ' ON UPDATE SET DEFAULT' ELSE '' END,
       CASE c.confdeltype
         WHEN 'r' THEN ' ON DELETE RESTRICT' WHEN 'c' THEN ' ON DELETE CASCADE'
         WHEN 'n' THEN ' ON DELETE SET NULL' WHEN 'd' THEN ' ON DELETE SET DEFAULT' ELSE '' END,
       CASE WHEN c.confdeltype IN ('n', 'd')
         THEN format(' (%s)', qm_tenant_columns(c.conrelid, COALESCE(c.confdelsetcols, c.conkey))) ELSE '' END,
       CASE WHEN c.condeferrable THEN ' DEFERRABLE' ELSE '' END
         || CASE WHEN c.condeferred THEN ' INITIALLY DEFERRED' ELSE '' END,
       CASE WHEN c.convalidated THEN '' ELSE ' NOT VALID' END)
     FROM pg_constraint c WHERE c.oid = con
   $qm_tenant_fk_def$`,
  `CREATE OR REPLACE FUNCTION qm_tenant_index_def(index_oid oid, index_name text) RETURNS text LANGUAGE sql STABLE
   AS $qm_tenant_index_def$
     WITH col AS (
       SELECT n, n <= i.indnkeyatts AS is_key, pg_get_indexdef(i.indexrelid, n, true) AS plain,
         pg_get_indexdef(i.indexrelid, n, true)
           || CASE WHEN i.indcollation[n - 1] <> 0 THEN ' COLLATE ' || i.indcollation[n - 1]::regcollation::text ELSE '' END
           || CASE WHEN oc.opcdefault = false THEN format(' %I.%I', ons.nspname, oc.opcname) ELSE '' END
           || CASE WHEN i.indoption[n - 1] & 1 = 1 THEN ' DESC' ELSE '' END
           || CASE WHEN i.indoption[n - 1] & 2 = 2 THEN ' NULLS FIRST'
                   WHEN i.indoption[n - 1] & 1 = 1 THEN ' NULLS LAST' ELSE '' END AS key
       FROM pg_index i
       CROSS JOIN generate_series(1, i.indnatts) n
       LEFT JOIN pg_opclass oc ON oc.oid = i.indclass[n - 1]
       LEFT JOIN pg_namespace ons ON ons.oid = oc.opcnamespace
       WHERE i.indexrelid = index_oid
     )
     SELECT format('CREATE UNIQUE INDEX %I ON %I USING %I (tenant_id, %s)%s%s%s%s',
       index_name, tc.relname, am.amname,
       (SELECT string_agg(key, ', ' ORDER BY n) FROM col WHERE is_key),
       COALESCE(' INCLUDE (' || (SELECT string_agg(plain, ', ' ORDER BY n) FROM col WHERE NOT is_key) || ')', ''),
       CASE WHEN i.indnullsnotdistinct THEN ' NULLS NOT DISTINCT' ELSE '' END,
       COALESCE(' WITH (' || array_to_string(ic.reloptions, ', ') || ')', ''),
       COALESCE(' WHERE ' || pg_get_expr(i.indpred, i.indrelid, true), ''))
     FROM pg_index i
     JOIN pg_class ic ON ic.oid = i.indexrelid
     JOIN pg_class tc ON tc.oid = i.indrelid
     JOIN pg_am am ON am.oid = ic.relam
     WHERE i.indexrelid = index_oid
   $qm_tenant_index_def$`,
  `CREATE OR REPLACE FUNCTION acl_grants_bump_version() RETURNS trigger LANGUAGE plpgsql AS $acl_grants_bump_version$
   BEGIN
     INSERT INTO acl_grants_version(only_row, v) VALUES (TRUE, 1)
     ON CONFLICT (tenant_id, only_row) DO UPDATE SET v = acl_grants_version.v + 1;
     RETURN NULL;
   END
   $acl_grants_bump_version$`,
  `CREATE OR REPLACE FUNCTION qm_tenantize() RETURNS integer LANGUAGE plpgsql AS $qm_tenantize$
DECLARE
  t record;
  ix record;
  fk record;
  fks text[] := '{}';
  tmp text;
  changed integer := 0;
BEGIN
  FOR t IN
    SELECT c.oid, c.relname FROM pg_class c
    WHERE c.relnamespace = current_schema()::regnamespace AND c.relkind = 'r'
      AND c.relname NOT IN (${EXCLUDED}) AND c.relname NOT LIKE 'pg\\_%'
      AND NOT EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid = c.oid AND a.attname = 'tenant_id' AND NOT a.attisdropped)
  LOOP
    EXECUTE format('ALTER TABLE %I ADD COLUMN tenant_id uuid NOT NULL DEFAULT qm_tenant_id()', t.relname);
    changed := changed + 1;
  END LOOP;

  FOR fk IN
    SELECT con.oid, con.conname, con.conrelid::regclass::text AS tbl
    FROM pg_constraint con
    JOIN pg_class src ON src.oid = con.conrelid
    JOIN pg_class dst ON dst.oid = con.confrelid
    WHERE con.contype = 'f'
      AND src.relnamespace = current_schema()::regnamespace AND dst.relnamespace = current_schema()::regnamespace
      AND src.relname NOT IN (${EXCLUDED}) AND dst.relname NOT IN (${EXCLUDED})
      AND (SELECT attname FROM pg_attribute WHERE attrelid = con.conrelid AND attnum = con.conkey[1]) <> 'tenant_id'
  LOOP
    fks := fks || format('ALTER TABLE %s ADD CONSTRAINT %I %s', fk.tbl, fk.conname, qm_tenant_fk_def(fk.oid));
    EXECUTE format('ALTER TABLE %s DROP CONSTRAINT %I', fk.tbl, fk.conname);
    changed := changed + 1;
  END LOOP;

  FOR ix IN
    SELECT i.indexrelid, ic.relname AS index_name, tc.relname AS table_name, con.conname, con.contype
    FROM pg_index i
    JOIN pg_class ic ON ic.oid = i.indexrelid
    JOIN pg_class tc ON tc.oid = i.indrelid
    LEFT JOIN pg_constraint con ON con.conindid = i.indexrelid AND con.contype IN ('p', 'u')
    WHERE i.indisunique AND tc.relnamespace = current_schema()::regnamespace AND tc.relkind = 'r'
      AND tc.relname NOT IN (${EXCLUDED})
      AND COALESCE((SELECT attname FROM pg_attribute WHERE attrelid = i.indrelid AND attnum = i.indkey[0]), '') <> 'tenant_id'
  LOOP
    IF ix.conname IS NULL THEN
      tmp := qm_tenant_index_def(ix.indexrelid, ix.index_name);
      EXECUTE format('DROP INDEX %I', ix.index_name);
      EXECUTE tmp;
    ELSE
      tmp := left('qm_tnt_' || md5(ix.index_name), 60);
      EXECUTE qm_tenant_index_def(ix.indexrelid, tmp);
      EXECUTE format('ALTER TABLE %I DROP CONSTRAINT %I', ix.table_name, ix.conname);
      EXECUTE format('ALTER TABLE %I ADD CONSTRAINT %I %s USING INDEX %I', ix.table_name, ix.conname,
        CASE ix.contype WHEN 'p' THEN 'PRIMARY KEY' ELSE 'UNIQUE' END, tmp);
    END IF;
    changed := changed + 1;
  END LOOP;

  FOREACH tmp IN ARRAY fks LOOP
    EXECUTE tmp;
  END LOOP;

  FOR t IN
    SELECT c.oid, c.relname FROM pg_class c
    WHERE c.relnamespace = current_schema()::regnamespace AND c.relkind = 'r'
      AND c.relname NOT IN (${EXCLUDED}) AND c.relname NOT LIKE 'pg\\_%'
      AND (NOT c.relrowsecurity OR NOT c.relforcerowsecurity
           OR NOT EXISTS (SELECT 1 FROM pg_policy p WHERE p.polrelid = c.oid AND p.polname = 'qm_tenant_isolation'))
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t.relname);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t.relname);
    IF NOT EXISTS (SELECT 1 FROM pg_policy p WHERE p.polrelid = t.oid AND p.polname = 'qm_tenant_isolation') THEN
      EXECUTE format('CREATE POLICY qm_tenant_isolation ON %I USING (tenant_id = qm_tenant_id() OR qm_tenant_bypass()) '
        'WITH CHECK (tenant_id = qm_tenant_id() OR qm_tenant_bypass())', t.relname);
    END IF;
    changed := changed + 1;
  END LOOP;
  RETURN changed;
END
$qm_tenantize$`,
];

type ServiceBags = Record<string, Record<string, string>>;

async function foldTenantEnvBags(client: PoolClient, key: Buffer | undefined): Promise<void> {
  const settingColumns = TENANT_TEXT_SETTINGS.map(([, column]) => column).join(", ");
  await client.query("SET LOCAL bytea_output = 'hex'");
  const { rows } = await client.query<{ id: string; slug: string; env: ServiceBags | null; sealed: string | null }>(
    `SELECT id::text AS id, slug, to_jsonb(t) -> 'env' AS env, to_jsonb(t) ->> 'secret_env' AS sealed FROM tenants t
     WHERE num_nonnulls(secrets, ${settingColumns}) = 0 AND NOT oidc_admin`,
  );
  for (const row of rows.filter((r) => r.sealed || Object.keys(r.env ?? {}).length)) {
    const secretEnv = row.sealed
      ? (openTenantSecret(Buffer.from(row.sealed.slice(2), "hex"), key, row.slug) as ServiceBags)
      : {};
    const flat: Record<string, string> = {};
    for (const bags of [row.env ?? {}, secretEnv]) {
      for (const service of ["web-ui", "portal", "core"]) Object.assign(flat, bags[service] ?? {});
    }
    const settings = settingsFromEnv(flat);
    const sealed = sealTenantSecrets(settings.secrets, key);
    if (!sealed && !settings.oidcAdmin && TENANT_TEXT_SETTINGS.every(([field]) => !settings[field])) continue;
    await client.query(
      `UPDATE tenants SET oidc_admin = $2, secrets = $3,
         ${TENANT_TEXT_SETTINGS.map(([, column], i) => `${column} = $${i + 4}`).join(", ")}
       WHERE id = $1`,
      [row.id, settings.oidcAdmin, sealed, ...TENANT_TEXT_SETTINGS.map(([field]) => settings[field] ?? null)],
    );
    console.log(`[qm] tenant ${row.slug}: settings filled from its env bags`);
  }
}

export async function applyTenancy(pool: Pool, tenantSecretsKey?: Buffer): Promise<void> {
  const client = await pool.connect();
  let broken: Error | undefined;
  const discardOnFailure = (e: unknown) => {
    broken = e instanceof Error ? e : new Error(String(e));
  };
  try {
    await client.query("SELECT pg_advisory_lock(hashtext('qm:tenantize'))");
    try {
      await client.query("BEGIN");
      for (const statement of TENANCY_FUNCTIONS) await client.query(statement);
      await foldTenantEnvBags(client, tenantSecretsKey);
      await client.query("SELECT qm_tenantize()");
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK").catch(discardOnFailure);
      throw error;
    } finally {
      await client.query("SELECT pg_advisory_unlock(hashtext('qm:tenantize'))").catch(discardOnFailure);
    }
  } finally {
    client.release(broken);
  }
}
