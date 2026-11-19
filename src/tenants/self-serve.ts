import { createHmac, randomUUID } from "node:crypto";
import { z } from "zod";
import { readBoundedText } from "../util/bytes.ts";
import type { PgPool } from "../persistence/pg-pool.ts";
import { signedRequestHeaders } from "../../plugins/chassis/src/source-auth-sign.ts";
import { tenantSettingsSchema } from "./settings.ts";
import { bootTenant } from "./boot.ts";
import {
  AdminError,
  trustedSubjectPrincipal,
  type AdminService,
  type SelfServePerson,
} from "../admin/admin-service.ts";
import { reportFailure } from "../util/errors.ts";
import { orgScope } from "../config.ts";
import { withTenant, type Tenant } from "./context.ts";
import type { AuditLog } from "../audit/audit-log.ts";
import { validEmail } from "../identity/external-members.ts";

export const externalOrgSchema = z
  .object({
    id: z.string().min(1),
    name: z.string().trim().min(1),
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
  members: z.array(z.unknown()).default([]),
});

const provisionedMember = z
  .object({
    subject: z.string().min(1),
    email: z.string().refine(validEmail, "expected an email address").optional(),
    name: z.string().optional(),
  })
  .strip();

type ProvisionedWorkspace = z.infer<typeof provisionedSettings>;

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
): Promise<ProvisionedWorkspace> {
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
  return parsed.data;
}

export interface SelfServe {
  workspace(
    issuer: string,
    subject: string,
    email: string | null,
    org: ExternalOrg,
  ): Promise<{ tenant: string; created: boolean }>;
  chatAccountWorkspace(account: string, name: string | undefined): Promise<string | undefined>;
}

export function createSelfServe(
  pg: Pick<PgPool, "q" | "forTenant">,
  provision: (request: WorkspaceProvisionRequest) => Promise<ProvisionedWorkspace>,
  admin: Pick<AdminService, "provisionSelfServe">,
  auditLog: Pick<AuditLog, "record">,
  trustedIssuer?: string,
): SelfServe {
  const enroll = async (bound: Tenant, issuer: string, people: readonly SelfServePerson[]) => {
    const { granted, removed } = await admin.provisionSelfServe(bound, issuer, people);
    for (const grant of granted)
      auditLog.record(bound, {
        at: Date.now(),
        principalId: grant.grantedBy!,
        scopeLabel: grant.scopeId,
        action: "grant.create",
        resource: `${grant.principalId}/org_admin`,
      });
    return removed;
  };

  const enrollMembers = async (bound: Tenant, issuer: string, members: readonly unknown[]) => {
    const failed = (index: number, error: unknown) =>
      reportFailure("self-serve member setup", error, `${bound.id} member ${index}`);
    const people: { index: number; person: SelfServePerson }[] = [];
    for (const [index, raw] of members.entries()) {
      const member = provisionedMember.safeParse(raw);
      if (!member.success) {
        failed(index, new Error(`invalid member: ${z.prettifyError(member.error)}`));
        continue;
      }
      try {
        trustedSubjectPrincipal(issuer, member.data.subject);
        people.push({ index, person: { ...member.data, email: member.data.email ?? null } });
      } catch (error) {
        failed(index, error);
      }
    }
    const removed = await enroll(
      bound,
      issuer,
      people.map(({ person }) => person),
    );
    for (const { index, person } of people)
      if (removed.includes(person)) failed(index, new AdminError(403, "this person was removed from the workspace"));
  };

  async function open<T>(
    issuer: string,
    org: ExternalOrg,
    join: (bound: Tenant) => Promise<T>,
  ): Promise<{ workspace: ExternalOrgTenant; joined?: T } | undefined> {
    if (bootTenant() !== undefined) return undefined;
    const workspace = await selfServeTenant(pg, issuer, org);
    if (!workspace) return undefined;
    if (workspace.provisioned && !workspace.serving) return { workspace };
    const joined = await withTenant(workspace.tenant, async (bound) => {
      if (workspace.created)
        auditLog.record(bound, {
          at: Date.now(),
          principalId: `trusted-oidc-self-serve:${issuer}`,
          scopeLabel: orgScope(),
          action: "tenant.self_serve.create",
          resource: workspace.tenant,
        });
      if (!workspace.provisioned) {
        const request = {
          tenant: workspace.tenant,
          brandName: org.name,
          issuer,
          externalOrg: org,
        };
        const provisioned = await provision(request).catch((error: unknown) => {
          reportFailure("self-serve workspace provisioning", error, workspace.tenant);
          throw new AdminError(502, "the new workspace could not be set up; try signing in again", {
            cause: error,
          });
        });
        await enrollMembers(bound, issuer, provisioned.members);
        await markSelfServeProvisioned(pg, workspace.tenant, provisioned.settings.modelGatewayKey);
      }
      return join(bound);
    });
    return { workspace: { ...workspace, serving: true }, joined };
  }

  return {
    async workspace(issuer, subject, email, org) {
      trustedSubjectPrincipal(issuer, subject);
      const opened = await open(issuer, org, async (bound) => {
        if ((await enroll(bound, issuer, [{ subject, email }])).length)
          throw new AdminError(403, "this person was removed from the workspace");
      });
      if (!opened) throw new AdminError(403, "self-serve workspaces need a multitenant deployment");
      if (!opened.workspace.serving) throw new AdminError(503, "this workspace is switched off");
      return { tenant: opened.workspace.tenant, created: opened.workspace.created };
    },
    async chatAccountWorkspace(account, name) {
      if (!trustedIssuer) return undefined;
      const opened = await open(trustedIssuer, { id: account, name: name ?? account }, async (bound) => {
        const [row] = await pg
          .forTenant(bound)
          .q("SELECT qm_self_serve_chat_account($1, $2) AS account", [bound.id, account]);
        return row?.account;
      });
      if (!opened?.workspace.serving) return undefined;
      if (opened.joined === account) return opened.workspace.tenant;
      console.warn(
        `[self-serve] chat account ${account} is bound elsewhere, so workspace ${opened.workspace.tenant} is not`,
      );
      return undefined;
    },
  };
}
