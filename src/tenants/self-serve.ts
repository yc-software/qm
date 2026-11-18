import { z } from "zod";
import type { PgMigrationDefinition, PgPool } from "../persistence/pg-pool.ts";
import { APP_HANDLE_MAX } from "../../plugins/chassis/src/dns-label.ts";

export const externalOrgSchema = z
  .object({
    id: z.string().min(1),
    name: z.string().trim().min(1),
    handle: z.string().optional(),
  })
  .strip();

export type ExternalOrg = z.infer<typeof externalOrgSchema>;

const definer = `CREATE OR REPLACE FUNCTION qm_self_serve_tenant(issuer text, org text, brand text, handle text)
  RETURNS TABLE(tenant uuid, created boolean) LANGUAGE plpgsql VOLATILE SECURITY DEFINER
  SET search_path = %1$I, pg_temp AS $f$
  DECLARE found uuid; base text; candidate text; n int := 1;
  BEGIN
    PERFORM pg_advisory_xact_lock(hashtextextended('qm-self-serve:' || $1 || chr(10) || $2, 0));
    SELECT o.tenant INTO found FROM tenant_external_orgs o WHERE o.issuer = $1 AND o.org_id = $2;
    IF found IS NOT NULL THEN
      RETURN QUERY SELECT found, false;
      RETURN;
    END IF;
    INSERT INTO tenants(settings) VALUES (jsonb_build_object('brandName', $3))
      RETURNING id INTO found;
    base := left(coalesce($4, ''), ${APP_HANDLE_MAX});
    WHILE base <> '' LOOP
      candidate := CASE WHEN n = 1 THEN base ELSE left(base, ${APP_HANDLE_MAX} - length(n::text)) || n END;
      IF qm_tenant_handle(jsonb_build_object('handle', candidate)) IS NOT DISTINCT FROM candidate THEN
        BEGIN
          UPDATE tenants SET settings = settings || jsonb_build_object('handle', candidate) WHERE id = found;
          EXIT;
        EXCEPTION WHEN unique_violation THEN NULL;
        END;
      END IF;
      n := n + 1;
    END LOOP;
    INSERT INTO tenant_external_orgs(issuer, org_id, tenant) VALUES ($1, $2, found);
    RETURN QUERY SELECT found, true;
  END $f$`;

export const TENANT_EXTERNAL_ORGS: PgMigrationDefinition = {
  id: "tenancy/self-serve/0001-external-orgs",
  statements: [
    `SET LOCAL lock_timeout = '5s'`,
    `CREATE TABLE IF NOT EXISTS tenant_external_orgs(
      issuer TEXT NOT NULL,
      org_id TEXT NOT NULL,
      tenant UUID NOT NULL UNIQUE REFERENCES tenants(id),
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      PRIMARY KEY (issuer, org_id)
    )`,
    `ALTER TABLE tenant_external_orgs ENABLE ROW LEVEL SECURITY`,
    `DO $self_serve$ BEGIN EXECUTE format($sql$${definer}$sql$, current_schema()); END $self_serve$`,
  ],
};

const handleChar = (c: string): boolean => (c >= "a" && c <= "z") || (c >= "0" && c <= "9");

function handleBase(handle: string | undefined): string {
  return [...(handle ?? "").toLowerCase()].filter(handleChar).join("");
}

export async function selfServeTenant(
  pg: Pick<PgPool, "q">,
  issuer: string,
  org: ExternalOrg,
): Promise<{ tenant: string; created: boolean }> {
  const rows = await pg.q("SELECT tenant::text AS tenant, created FROM qm_self_serve_tenant($1, $2, $3, $4)", [
    issuer,
    org.id,
    org.name,
    handleBase(org.handle),
  ]);
  const row = rows[0];
  if (typeof row?.tenant !== "string") throw new Error("self-serve tenant was not created");
  return { tenant: row.tenant, created: row.created === true };
}
