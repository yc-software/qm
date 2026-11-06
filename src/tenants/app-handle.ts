import { z } from "zod";
import type { PgMigrationDefinition } from "../persistence/pg-pool.ts";

const RESERVED_APP_HANDLES = ["auth", "slack", "mt", "www", "api", "docs", "apps", "admin"] as const;

export const appHandleSchema = z
  .string()
  .regex(/^[a-z0-9]{2,30}$/, "use 2–30 lowercase letters or digits, with no hyphens")
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

export function appHostLabel(handle: string | undefined, name: string): string {
  return handle ? `${handle}-${name}` : name;
}

export function splitAppLabel(label: string): { handle: string; name: string } | undefined {
  const dash = label.indexOf("-");
  if (dash < 1 || dash === label.length - 1 || label.includes(".")) return undefined;
  return { handle: label.slice(0, dash), name: label.slice(dash + 1) };
}

export function appNameFromLabel(label: string, handle: string | undefined): string | undefined {
  if (!handle) return label;
  const split = splitAppLabel(label);
  return split?.handle === handle ? split.name : undefined;
}

export function labelOfAppHost(host: string | undefined, appsDomain: string | undefined): string | undefined {
  if (!appsDomain) return undefined;
  const bare = (host ?? "").split(":")[0]!.toLowerCase();
  const suffix = `.${appsDomain.toLowerCase()}`;
  return bare.endsWith(suffix) ? bare.slice(0, -suffix.length) : undefined;
}
