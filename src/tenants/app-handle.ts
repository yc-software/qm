import { z } from "zod";
import {
  APP_HANDLE_CHARS,
  APP_HANDLE_MAX,
  APP_HANDLE_MIN,
  DNS_LABEL_MAX,
  isAppHandleShape,
} from "../../plugins/chassis/src/dns-label.ts";
import type { PgMigrationDefinition } from "../persistence/pg-pool.ts";

const RESERVED_APP_HANDLES = ["auth", "slack", "mt", "www", "api", "docs", "apps", "admin"] as const;

export const appHandleSchema = z
  .string()
  .refine(isAppHandleShape, `use ${APP_HANDLE_CHARS}`)
  .refine((handle) => !(RESERVED_APP_HANDLES as readonly string[]).includes(handle), "that handle is reserved");

const reserved = RESERVED_APP_HANDLES.map((handle) => `'${handle}'`).join(", ");

const definers = [
  `CREATE OR REPLACE FUNCTION qm_tenant_for_app_handle(handle text) RETURNS uuid LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = %1$I, pg_temp AS $f$
  SELECT id FROM tenants WHERE qm_tenant_handle(settings) = lower(handle)
$f$`,
  `CREATE OR REPLACE FUNCTION qm_tenant_for_app_host(label text) RETURNS uuid LANGUAGE plpgsql STABLE SECURITY DEFINER
  SET search_path = %1$I, pg_temp AS $f$
  DECLARE found uuid;
  BEGIN
    IF strpos(label, '-') > 1 THEN
      found := qm_tenant_for_app_handle(split_part(label, '-', 1));
      IF found IS NOT NULL THEN RETURN found; END IF;
    END IF;
    RETURN qm_tenant_for_deployment(label);
  END $f$`,
  `CREATE OR REPLACE FUNCTION qm_set_tenant_handle(handle text) RETURNS void LANGUAGE plpgsql VOLATILE SECURITY DEFINER
  SET search_path = %1$I, pg_temp AS $f$
  BEGIN
    IF qm_tenant_handle(jsonb_build_object('handle', handle)) IS DISTINCT FROM handle THEN
      RAISE invalid_parameter_value USING MESSAGE = 'invalid app handle';
    END IF;
    UPDATE tenants SET settings = jsonb_set(settings, '{handle}', to_jsonb(handle)) WHERE id = qm_bound_tenant();
  END $f$`,
];

export const TENANT_APP_HANDLES: PgMigrationDefinition = {
  id: "0000-tenancy/settings/app-handles",
  statements: [
    `SET LOCAL lock_timeout = '5s'`,
    `CREATE OR REPLACE FUNCTION qm_tenant_handle(settings jsonb) RETURNS text LANGUAGE sql IMMUTABLE PARALLEL SAFE
      AS $qm_tenant_handle$
      SELECT CASE WHEN h ~ '^[a-z0-9]{2,30}$' AND h <> ALL (ARRAY[${reserved}]) THEN h END
        FROM (SELECT coalesce(settings->>'handle',
          regexp_replace(lower(coalesce(settings->>'orgSlug', '')), '[^a-z0-9]', '', 'g')) AS h) picked
    $qm_tenant_handle$`,
    `CREATE UNIQUE INDEX IF NOT EXISTS tenants_app_handle ON tenants (qm_tenant_handle(settings))`,
    ...definers.map(
      (definer) => `DO $app_handles$ BEGIN EXECUTE format($sql$${definer}$sql$, current_schema()); END $app_handles$`,
    ),
  ],
};

export const TENANT_APP_HANDLE_DNS_BOUND: PgMigrationDefinition = {
  id: "0000-tenancy/tenant-app-handles-dns-bound",
  statements: [
    `SET LOCAL lock_timeout = '5s'`,
    `CREATE OR REPLACE FUNCTION qm_tenant_handle(settings jsonb) RETURNS text LANGUAGE sql IMMUTABLE PARALLEL SAFE
      AS $qm_tenant_handle$
      SELECT CASE WHEN h ~ '^[a-z0-9]{${APP_HANDLE_MIN},${APP_HANDLE_MAX}}$' AND h <> ALL (ARRAY[${reserved}]) THEN h END
        FROM (SELECT coalesce(settings->>'handle',
          regexp_replace(lower(coalesce(settings->>'orgSlug', '')), '[^a-z0-9]', '', 'g')) AS h) picked
    $qm_tenant_handle$`,
    `REINDEX INDEX tenants_app_handle`,
  ],
};

export const TENANT_APP_HOSTS_BY_HANDLE: PgMigrationDefinition = {
  id: "0000-tenancy/tenant-app-hosts-by-handle",
  statements: [
    `SET LOCAL lock_timeout = '5s'`,
    `DO $app_hosts$ BEGIN EXECUTE format($sql$CREATE OR REPLACE FUNCTION qm_tenant_for_app_host(label text) RETURNS uuid LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = %1$I, pg_temp AS $f$
  SELECT CASE WHEN strpos(label, '-') > 1 THEN qm_tenant_for_app_handle(split_part(label, '-', 1)) END
$f$$sql$, current_schema()); END $app_hosts$`,
  ],
};

export const TENANT_APP_HANDLE_HYPHENS: PgMigrationDefinition = {
  id: "0000-tenancy/tenant-app-handles-hyphens",
  statements: [
    `SET LOCAL lock_timeout = '5s'`,
    `CREATE OR REPLACE FUNCTION qm_tenant_handle(settings jsonb) RETURNS text LANGUAGE sql IMMUTABLE PARALLEL SAFE
      AS $qm_tenant_handle$
      SELECT CASE WHEN h ~ '^[a-z0-9][a-z0-9-]{${APP_HANDLE_MIN - 2},${APP_HANDLE_MAX - 2}}[a-z0-9]$' AND h <> ALL (ARRAY[${reserved}]) THEN h END
        FROM (SELECT coalesce(settings->>'handle',
          regexp_replace(lower(coalesce(settings->>'orgSlug', '')), '[^a-z0-9-]', '', 'g')) AS h) picked
    $qm_tenant_handle$`,
    `REINDEX INDEX tenants_app_handle`,
  ],
};

const APP_HOSTS_TABLE = "app_hosts";
export const APP_HOSTS_KEY = "app_hosts_pkey";

const appHostDefiners = [
  `CREATE OR REPLACE FUNCTION qm_app_host_label(settings jsonb, name text) RETURNS text LANGUAGE sql IMMUTABLE
  SET search_path = %1$I, pg_temp AS $f$
  SELECT qm_tenant_handle(settings) || '-' || name
$f$`,
  `CREATE OR REPLACE FUNCTION qm_sync_app_host() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = %1$I, pg_temp AS $f$
  BEGIN
    IF TG_OP = 'UPDATE' AND OLD.json->>'name' IS NOT DISTINCT FROM NEW.json->>'name' THEN RETURN NULL; END IF;
    DELETE FROM app_hosts h WHERE h.tenant = NEW.tenant_id AND h.deployment_id = NEW.id;
    INSERT INTO app_hosts(label, tenant, deployment_id)
      SELECT label, NEW.tenant_id, NEW.id
        FROM (SELECT qm_app_host_label(t.settings, coalesce(NEW.json->>'name', NEW.id)) AS label
                FROM tenants t WHERE t.id = NEW.tenant_id) found
       WHERE label IS NOT NULL;
    RETURN NULL;
  END $f$`,
  `CREATE OR REPLACE FUNCTION qm_sync_tenant_app_hosts(tenant uuid) RETURNS void LANGUAGE sql SECURITY DEFINER
  SET search_path = %1$I, pg_temp AS $f$
  DELETE FROM app_hosts h WHERE h.tenant = $1;
  INSERT INTO app_hosts(label, tenant, deployment_id)
    SELECT label, $1, id
      FROM (SELECT qm_app_host_label(t.settings, coalesce(d.json->>'name', d.id)) AS label, d.id
              FROM deployments d JOIN tenants t ON t.id = d.tenant_id WHERE d.tenant_id = $1) found
     WHERE label IS NOT NULL;
$f$`,
  `CREATE OR REPLACE FUNCTION qm_sync_tenant_app_hosts() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = %1$I, pg_temp AS $f$
  BEGIN
    IF qm_tenant_handle(NEW.settings) IS DISTINCT FROM qm_tenant_handle(OLD.settings) THEN
      PERFORM qm_sync_tenant_app_hosts(NEW.id);
    END IF;
    RETURN NULL;
  END $f$`,
  `CREATE OR REPLACE FUNCTION qm_tenant_for_app_host(label text) RETURNS uuid LANGUAGE plpgsql STABLE SECURITY DEFINER
  SET search_path = %1$I, pg_temp AS $f$
  DECLARE found uuid;
  BEGIN
    SELECT h.tenant INTO found FROM app_hosts h WHERE h.label = lower($1);
    IF found IS NOT NULL THEN RETURN found; END IF;
    RETURN qm_tenant_for_deployment($1);
  END $f$`,
];

export const APP_HOSTS: PgMigrationDefinition = {
  id: "durable-map/deployments/0050-app-hosts",
  statements: [
    `SET LOCAL lock_timeout = '5s'`,
    `CREATE TABLE IF NOT EXISTS ${APP_HOSTS_TABLE}(
      label TEXT NOT NULL,
      tenant UUID NOT NULL,
      deployment_id TEXT NOT NULL,
      CONSTRAINT ${APP_HOSTS_KEY} PRIMARY KEY (label),
      CONSTRAINT app_hosts_deployment UNIQUE (tenant, deployment_id),
      CONSTRAINT app_hosts_deployment_fkey FOREIGN KEY (tenant, deployment_id)
        REFERENCES deployments(tenant_id, id) ON DELETE CASCADE
    )`,
    `ALTER TABLE ${APP_HOSTS_TABLE} ENABLE ROW LEVEL SECURITY`,
    ...appHostDefiners.map(
      (definer) => `DO $app_hosts$ BEGIN EXECUTE format($sql$${definer}$sql$, current_schema()); END $app_hosts$`,
    ),
    `SELECT qm_sync_tenant_app_hosts(id) FROM tenants`,
    `DROP TRIGGER IF EXISTS app_hosts_sync ON deployments`,
    `CREATE TRIGGER app_hosts_sync AFTER INSERT OR UPDATE OF json ON deployments
      FOR EACH ROW EXECUTE FUNCTION qm_sync_app_host()`,
    `DROP TRIGGER IF EXISTS app_hosts_sync ON tenants`,
    `CREATE TRIGGER app_hosts_sync AFTER UPDATE OF settings ON tenants
      FOR EACH ROW EXECUTE FUNCTION qm_sync_tenant_app_hosts()`,
  ],
};

export function appHostLabel(handle: string, name: string): string {
  return `${handle}-${name}`;
}

export function appLabelLimitError(handle: string | undefined, ref: string): string | undefined {
  if (!handle) return undefined;
  const label = appHostLabel(handle, ref);
  if (label.length <= DNS_LABEL_MAX) return undefined;
  return `app "${ref}" would be served at "${label}" (${label.length} characters), over the ${DNS_LABEL_MAX}-character DNS label limit; choose a shorter app name or app handle`;
}

export function appNameFromLabel(label: string, handle: string | undefined): string | undefined {
  const prefix = handle ? `${handle}-` : undefined;
  return prefix && label.startsWith(prefix) && label.length > prefix.length ? label.slice(prefix.length) : label;
}

export function appAddressTakenError(label: string): string {
  return `the app address "${label}" is already taken by another workspace's app; choose a different app name`;
}

export function labelOfAppHost(host: string | undefined, appsDomain: string | undefined): string | undefined {
  if (!appsDomain) return undefined;
  const bare = (host ?? "").split(":")[0]!.toLowerCase();
  const suffix = `.${appsDomain.toLowerCase()}`;
  return bare.endsWith(suffix) ? bare.slice(0, -suffix.length) : undefined;
}

export const TENANT_APP_HOSTS_LEGACY_NAMES: PgMigrationDefinition = {
  id: "0000-tenancy/tenant-app-hosts-legacy-names",
  statements: [
    `SET LOCAL lock_timeout = '5s'`,
    `DO $app_hosts$ BEGIN EXECUTE format($sql$CREATE OR REPLACE FUNCTION qm_tenant_for_app_host(label text) RETURNS uuid LANGUAGE plpgsql STABLE SECURITY DEFINER
  SET search_path = %1$I, pg_temp AS $f$
  DECLARE found uuid;
  BEGIN
    IF strpos(label, '-') > 1 THEN
      found := qm_tenant_for_app_handle(split_part(label, '-', 1));
      IF found IS NOT NULL THEN RETURN found; END IF;
    END IF;
    RETURN qm_tenant_for_deployment(label);
  END $f$$sql$, current_schema()); END $app_hosts$`,
  ],
};
