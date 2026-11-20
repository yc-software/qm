import { createHmac, randomUUID } from "node:crypto";
import { z } from "zod";
import { readBoundedText } from "../util/bytes.ts";
import type { PgPool } from "../persistence/pg-pool.ts";
import { signedRequestHeaders } from "../../plugins/chassis/src/source-auth-sign.ts";
import { tenantSettingsSchema } from "./settings.ts";
import { bootTenant } from "./boot.ts";
import { AdminError, trustedSubjectPrincipal } from "../admin/admin-service.ts";
import { reportFailure } from "../util/errors.ts";

export const externalOrgSchema = z
  .object({
    id: z.string().min(1),
    name: z.string().trim().min(1),
    partnerChatAccount: z.string().min(1).optional(),
  })
  .strip();

type ExternalOrg = z.infer<typeof externalOrgSchema>;

interface ExternalOrgTenant {
  tenant: string;
  created: boolean;
  provisioned: boolean;
  serving: boolean;
}

const PROVISION_TIMEOUT_MS = 30_000;
const PROVISION_REPLY_BYTES_MAX = 65_536;

async function selfServeTenant(
  pg: Pick<PgPool, "q">,
  issuer: string,
  org: ExternalOrg,
): Promise<ExternalOrgTenant | undefined> {
  const rows = await pg.q(
    "SELECT tenant::text AS tenant, created, provisioned, serving FROM qm_self_serve_tenant($1, $2, $3)",
    [issuer, org.id, org.name],
  );
  const row = rows[0];
  if (row === undefined) return undefined;
  return {
    tenant: String(row.tenant),
    created: row.created === true,
    provisioned: row.provisioned === true,
    serving: row.serving === true,
  };
}

async function markSelfServeProvisioned(pg: Pick<PgPool, "q">, tenant: string, modelGatewayKey: string): Promise<void> {
  await pg.q("SELECT qm_self_serve_provisioned($1, $2)", [tenant, modelGatewayKey]);
}

const provisionedSettings = z.object({
  settings: tenantSettingsSchema.pick({ modelGatewayKey: true }).required(),
});

export interface WorkspaceProvisionRequest {
  tenant: string;
  brandName: string;
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
  const text = await readBoundedText(
    res,
    PROVISION_REPLY_BYTES_MAX,
    () => new Error(`workspace provisioner reply exceeds ${PROVISION_REPLY_BYTES_MAX} bytes`),
  );
  if (!res.ok) throw new Error(`workspace provisioner returned HTTP ${res.status}: ${text}`);
  const parsed = provisionedSettings.safeParse(JSON.parse(text));
  if (!parsed.success)
    throw new Error(
      `workspace provisioner returned invalid settings: ${parsed.error.issues[0]?.message ?? "rejected"}`,
    );
  return parsed.data.settings.modelGatewayKey;
}

export interface SelfServe {
  workspace(issuer: string, subject: string, org: ExternalOrg): Promise<{ tenant: string; created: boolean }>;
}

export function createSelfServe(
  pg: Pick<PgPool, "q">,
  provision: (request: WorkspaceProvisionRequest) => Promise<string>,
): SelfServe {
  return {
    async workspace(issuer, subject, org) {
      if (bootTenant() !== undefined) throw new AdminError(403, "self-serve workspaces need a multitenant deployment");
      trustedSubjectPrincipal(issuer, subject);
      const workspace = await selfServeTenant(pg, issuer, org);
      if (!workspace) throw new AdminError(403, "self-serve workspaces need a multitenant deployment");
      if (workspace.provisioned && !workspace.serving) throw new AdminError(503, "this workspace is switched off");
      if (!workspace.provisioned) {
        const request = {
          tenant: workspace.tenant,
          brandName: org.name,
          issuer,
          externalOrg: org,
        };
        const key = await provision(request).catch((error: unknown) => {
          reportFailure("self-serve workspace provisioning", error, workspace.tenant);
          throw new AdminError(502, "the new workspace could not be set up; try signing in again", { cause: error });
        });
        await markSelfServeProvisioned(pg, workspace.tenant, key);
      }
      return { tenant: workspace.tenant, created: workspace.created };
    },
  };
}
