import { createHmac, randomUUID } from "node:crypto";
import { z } from "zod";
import { readBoundedText } from "../util/bytes.ts";
import type { PgMigrationDefinition, PgPool } from "../persistence/pg-pool.ts";
import { APP_HANDLE_MAX } from "../../plugins/chassis/src/dns-label.ts";
import { signedRequestHeaders } from "../../plugins/chassis/src/source-auth-sign.ts";
import { tenantSettingsSchema } from "./settings.ts";

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
  serving: boolean;
  handle: string | null;
}

const definer = `CREATE OR REPLACE FUNCTION qm_self_serve_tenant(issuer text, org text, brand text, handle text)
  RETURNS TABLE(tenant uuid, created boolean, provisioned boolean, serving boolean, tenant_handle text)
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER
  SET search_path = %1$I, pg_temp AS $f$
  DECLARE found uuid; fresh boolean := false;
  BEGIN
    PERFORM pg_advisory_xact_lock(hashtextextended('qm-self-serve:' || $1 || chr(10) || $2, 0));
    SELECT o.tenant INTO found FROM tenant_external_orgs o WHERE o.issuer = $1 AND o.org_id = $2;
    IF found IS NULL THEN
      IF NOT EXISTS (SELECT 1 FROM tenants) THEN
        RETURN;
      END IF;
      INSERT INTO tenants(settings) VALUES (jsonb_build_object('brandName', $3, 'serving', false))
        RETURNING id INTO found;
      IF $4 <> '' AND qm_tenant_handle(jsonb_build_object('handle', $4)) IS NOT DISTINCT FROM $4 THEN
        BEGIN
          UPDATE tenants SET settings = settings || jsonb_build_object('handle', $4) WHERE id = found;
        EXCEPTION WHEN unique_violation THEN NULL;
        END;
      END IF;
      INSERT INTO tenant_external_orgs(issuer, org_id, tenant) VALUES ($1, $2, found);
      fresh := true;
    END IF;
    RETURN QUERY SELECT found, fresh, t.settings ? 'modelGatewayKey', t.settings->>'serving' IS DISTINCT FROM 'false', t.settings->>'handle'
      FROM tenants t WHERE t.id = found;
  END $f$`;

const provisionedDefiner = `CREATE OR REPLACE FUNCTION qm_self_serve_provisioned(tenant uuid, key text)
  RETURNS void LANGUAGE sql VOLATILE SECURITY DEFINER
  SET search_path = %1$I, pg_temp AS $f$
    UPDATE tenants t SET settings = (t.settings || jsonb_build_object('modelGatewayKey', $2)) - 'serving'
    WHERE t.id = $1 AND NOT t.settings ? 'modelGatewayKey'
      AND EXISTS (SELECT 1 FROM tenant_external_orgs o WHERE o.tenant = $1)
  $f$`;

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
    `DO $self_serve$ BEGIN EXECUTE format($sql$${provisionedDefiner}$sql$, current_schema()); END $self_serve$`,
    `REVOKE ALL ON FUNCTION qm_self_serve_tenant(text, text, text, text), qm_self_serve_provisioned(uuid, text) FROM PUBLIC`,
  ],
};

const PROVISION_TIMEOUT_MS = 30_000;
const PROVISION_REPLY_BYTES_MAX = 65_536;

const handleChar = (c: string): boolean => (c >= "a" && c <= "z") || (c >= "0" && c <= "9");

function handleBase(handle: string | undefined): string {
  return [...(handle ?? "").toLowerCase()].filter(handleChar).join("").slice(0, APP_HANDLE_MAX);
}

export async function selfServeTenant(
  pg: Pick<PgPool, "q">,
  issuer: string,
  org: ExternalOrg,
): Promise<ExternalOrgTenant | undefined> {
  const rows = await pg.q(
    "SELECT tenant::text AS tenant, created, provisioned, serving, tenant_handle FROM qm_self_serve_tenant($1, $2, $3, $4)",
    [issuer, org.id, org.name, handleBase(org.handle)],
  );
  const row = rows[0];
  if (row === undefined) return undefined;
  return {
    tenant: String(row.tenant),
    created: row.created === true,
    provisioned: row.provisioned === true,
    serving: row.serving === true,
    handle: typeof row.tenant_handle === "string" ? row.tenant_handle : null,
  };
}

export async function markSelfServeProvisioned(
  pg: Pick<PgPool, "q">,
  tenant: string,
  modelGatewayKey: string,
): Promise<void> {
  await pg.q("SELECT qm_self_serve_provisioned($1, $2)", [tenant, modelGatewayKey]);
}

const provisionedSettings = z.object({
  settings: tenantSettingsSchema.pick({ modelGatewayKey: true }).required(),
});

export interface WorkspaceProvisionRequest {
  tenant: string;
  brandName: string;
  handle: string | null;
  issuer: string;
  externalOrg: ExternalOrg;
}

export function provisionerSigningKey(coreSigningSecret: string): string {
  return createHmac("sha256", coreSigningSecret).update("workspace-provisioner").digest("hex");
}

export async function provisionWorkspace(
  url: string,
  signingKey: string,
  request: WorkspaceProvisionRequest,
): Promise<string> {
  const target = new URL(url);
  const body = JSON.stringify({ ...request, nonce: randomUUID() });
  const res = await fetch(target, {
    method: "POST",
    body,
    redirect: "error",
    signal: AbortSignal.timeout(PROVISION_TIMEOUT_MS),
    headers: signedRequestHeaders(signingKey, "POST", `${target.pathname}${target.search}`, body, {
      "content-type": "application/json",
    }),
  });
  if (!res.ok) throw new Error(`workspace provisioner returned HTTP ${res.status}`);
  const text = await readBoundedText(
    res,
    PROVISION_REPLY_BYTES_MAX,
    () => new Error(`workspace provisioner reply exceeds ${PROVISION_REPLY_BYTES_MAX} bytes`),
  );
  const parsed = provisionedSettings.safeParse(JSON.parse(text));
  if (!parsed.success)
    throw new Error(
      `workspace provisioner returned invalid settings: ${parsed.error.issues[0]?.message ?? "rejected"}`,
    );
  return parsed.data.settings.modelGatewayKey;
}
