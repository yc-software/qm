import { z } from "zod";
import type { PgMigrationDefinition, PgPool } from "../persistence/pg-pool.ts";
import { APP_HANDLE_MAX } from "../../plugins/chassis/src/dns-label.ts";
import { signedRequestHeaders } from "../../plugins/chassis/src/source-auth-sign.ts";
import { tenantSettingsSchema, type TenantSettings } from "./settings.ts";

export const externalOrgSchema = z
  .object({
    id: z.string().min(1),
    name: z.string().trim().min(1),
    handle: z.string().optional(),
  })
  .strip();

export type ExternalOrg = z.infer<typeof externalOrgSchema>;

export interface ExternalOrgTenant {
  tenant: string;
  created: boolean;
  provisioned: boolean;
  handle: string | null;
}

const definer = `CREATE OR REPLACE FUNCTION qm_self_serve_tenant(issuer text, org text, brand text, handle text, gated boolean)
  RETURNS TABLE(tenant uuid, created boolean, provisioned boolean, tenant_handle text) LANGUAGE plpgsql VOLATILE SECURITY DEFINER
  SET search_path = %1$I, pg_temp AS $f$
  DECLARE found uuid; ready boolean; base text; candidate text; n int := 1;
  BEGIN
    PERFORM pg_advisory_xact_lock(hashtextextended('qm-self-serve:' || $1 || chr(10) || $2, 0));
    SELECT o.tenant, o.provisioned INTO found, ready FROM tenant_external_orgs o WHERE o.issuer = $1 AND o.org_id = $2;
    IF found IS NOT NULL THEN
      RETURN QUERY SELECT found, false, ready, t.settings->>'handle' FROM tenants t WHERE t.id = found;
      RETURN;
    END IF;
    INSERT INTO tenants(settings)
      VALUES (jsonb_build_object('brandName', $3) || CASE WHEN $5 THEN '{"serving":false}'::jsonb ELSE '{}'::jsonb END)
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
    INSERT INTO tenant_external_orgs(issuer, org_id, tenant, provisioned) VALUES ($1, $2, found, NOT $5);
    RETURN QUERY SELECT found, true, NOT $5, t.settings->>'handle' FROM tenants t WHERE t.id = found;
  END $f$`;

const provisionedDefiner = `CREATE OR REPLACE FUNCTION qm_self_serve_provisioned(tenant uuid, extra jsonb)
  RETURNS void LANGUAGE plpgsql VOLATILE SECURITY DEFINER
  SET search_path = %1$I, pg_temp AS $f$
  BEGIN
    UPDATE tenant_external_orgs o SET provisioned = true WHERE o.tenant = $1 AND NOT o.provisioned;
    IF FOUND THEN
      UPDATE tenants t SET settings = (t.settings || $2) - 'serving' WHERE t.id = $1;
    END IF;
  END $f$`;

export const TENANT_EXTERNAL_ORGS: PgMigrationDefinition = {
  id: "tenancy/self-serve/0001-external-orgs",
  statements: [
    `SET LOCAL lock_timeout = '5s'`,
    `CREATE TABLE IF NOT EXISTS tenant_external_orgs(
      issuer TEXT NOT NULL,
      org_id TEXT NOT NULL,
      tenant UUID NOT NULL UNIQUE REFERENCES tenants(id),
      provisioned BOOLEAN NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      PRIMARY KEY (issuer, org_id)
    )`,
    `ALTER TABLE tenant_external_orgs ENABLE ROW LEVEL SECURITY`,
    `DO $self_serve$ BEGIN EXECUTE format($sql$${definer}$sql$, current_schema()); END $self_serve$`,
    `DO $self_serve$ BEGIN EXECUTE format($sql$${provisionedDefiner}$sql$, current_schema()); END $self_serve$`,
  ],
};

const PROVISION_TIMEOUT_MS = 30_000;

const handleChar = (c: string): boolean => (c >= "a" && c <= "z") || (c >= "0" && c <= "9");

function handleBase(handle: string | undefined): string {
  return [...(handle ?? "").toLowerCase()].filter(handleChar).join("");
}

export async function selfServeTenant(
  pg: Pick<PgPool, "q">,
  issuer: string,
  org: ExternalOrg,
  gated: boolean,
): Promise<ExternalOrgTenant> {
  const rows = await pg.q(
    "SELECT tenant::text AS tenant, created, provisioned, tenant_handle FROM qm_self_serve_tenant($1, $2, $3, $4, $5)",
    [issuer, org.id, org.name, handleBase(org.handle), gated],
  );
  const row = rows[0];
  if (typeof row?.tenant !== "string") throw new Error("self-serve tenant was not created");
  return {
    tenant: row.tenant,
    created: row.created === true,
    provisioned: row.provisioned === true,
    handle: typeof row.tenant_handle === "string" ? row.tenant_handle : null,
  };
}

export async function markSelfServeProvisioned(
  pg: Pick<PgPool, "q">,
  tenant: string,
  settings: TenantSettings,
): Promise<void> {
  await pg.q("SELECT qm_self_serve_provisioned($1, $2::jsonb)", [tenant, JSON.stringify(settings)]);
}

const provisionedSettings = z.object({ settings: tenantSettingsSchema.omit({ serving: true }) });

export interface WorkspaceProvisionRequest {
  tenant: string;
  brandName: string;
  handle: string | null;
  issuer: string;
  externalOrg: ExternalOrg;
}

export async function provisionWorkspace(
  url: string,
  signingSecret: string,
  request: WorkspaceProvisionRequest,
): Promise<TenantSettings> {
  const target = new URL(url);
  const body = JSON.stringify(request);
  const res = await fetch(target, {
    method: "POST",
    body,
    redirect: "error",
    signal: AbortSignal.timeout(PROVISION_TIMEOUT_MS),
    headers: signedRequestHeaders(signingSecret, "POST", `${target.pathname}${target.search}`, body, {
      "content-type": "application/json",
    }),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`workspace provisioner returned HTTP ${res.status}: ${text}`);
  const parsed = provisionedSettings.safeParse(JSON.parse(text));
  if (!parsed.success)
    throw new Error(
      `workspace provisioner returned invalid settings: ${parsed.error.issues[0]?.message ?? "rejected"}`,
    );
  return parsed.data.settings;
}
