import { currentTenant } from "../tenants/context.ts";
import { createPgPool } from "../persistence/pg-pool.ts";
import { typedTableMigration } from "../persistence/typed-table-migration.ts";
import { TENANCY_BASE, TENANT } from "../tenants/migrations.ts";
import { foldPrincipalId } from "../directory/person.ts";

type ExternalRole = "member" | "org_admin";

export interface ExternalMember {
  email: string;
  role: ExternalRole;
  expiresAt: number | null;
  kind?: "teammate";
  inviteId?: string;
  invitedBy: string;
  createdAt: number;
  updatedAt: number;
}

export function externalMemberActive(m: ExternalMember, now = Date.now()): boolean {
  return (m.kind === "teammate" && m.expiresAt === null) || (typeof m.expiresAt === "number" && m.expiresAt > now);
}

export function validEmail(value: string): boolean {
  return value.length <= 254 && /^[^@\s,;<>"]+@[^@\s,;<>"]+\.[^@\s,;<>"]+$/.test(value);
}

export interface ExternalMemberStore {
  list(): Promise<ExternalMember[]>;
  put(member: ExternalMember): Promise<void>;
  remove(emails: readonly string[]): Promise<void>;
  close?(): Promise<void>;
}

const EXTERNAL_MEMBERS_MIGRATION = typedTableMigration({
  table: "external_members",
  columns: [
    "email TEXT NOT NULL",
    "role TEXT NOT NULL",
    "expires_at BIGINT",
    "kind TEXT",
    "invite_id TEXT",
    "invited_by TEXT NOT NULL",
    "created_at BIGINT NOT NULL",
    "updated_at BIGINT NOT NULL",
  ],
  constraints: ["CHECK (role IN ('member', 'org_admin'))", "CHECK (kind IS NULL OR kind = 'teammate')"],
  primaryKey: ["email"],
  backfill: {
    email: "id",
    role: "json->>'role'",
    expires_at: "(json->>'expiresAt')::bigint",
    kind: "json->>'kind'",
    invite_id: "json->>'inviteId'",
    invited_by: "json->>'invitedBy'",
    created_at: "(json->>'createdAt')::bigint",
    updated_at: "(json->>'updatedAt')::bigint",
  },
  where: `json->>'role' IN ('member', 'org_admin') AND (json->>'kind' IS NULL OR json->>'kind' = 'teammate')
    AND json->>'invitedBy' IS NOT NULL AND json->>'createdAt' IS NOT NULL AND json->>'updatedAt' IS NOT NULL`,
});

function externalMember(row: Record<string, unknown>): ExternalMember {
  return {
    email: String(row.email),
    role: row.role as ExternalRole,
    expiresAt: row.expires_at === null ? null : Number(row.expires_at),
    ...(row.kind === "teammate" ? { kind: "teammate" as const } : {}),
    ...(row.invite_id === null ? {} : { inviteId: String(row.invite_id) }),
    invitedBy: String(row.invited_by),
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  };
}

export function createExternalMemberStore(): ExternalMemberStore {
  const tenants = new Map<string, Map<string, ExternalMember>>();
  const rows = () => {
    const tenant = currentTenant();
    return tenants.get(tenant) ?? tenants.set(tenant, new Map()).get(tenant)!;
  };
  return {
    list: async () => [...rows().values()],
    put: async (member) =>
      void rows().set(foldPrincipalId(member.email), { ...member, email: foldPrincipalId(member.email) }),
    async remove(emails) {
      for (const email of emails) rows().delete(foldPrincipalId(email));
    },
  };
}

export function createPostgresExternalMemberStore(connectionString: string): ExternalMemberStore {
  const { q, close } = createPgPool(connectionString, [TENANCY_BASE, EXTERNAL_MEMBERS_MIGRATION]);
  return {
    async list() {
      const rows = await q(
        `SELECT email, role, expires_at, kind, invite_id, invited_by, created_at, updated_at
           FROM external_members WHERE tenant_id = ${TENANT} ORDER BY email`,
      );
      return rows.map(externalMember);
    },
    async put(member) {
      await q(
        `INSERT INTO external_members(email, role, expires_at, kind, invite_id, invited_by, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         ON CONFLICT (tenant_id, email) DO UPDATE SET role = EXCLUDED.role, expires_at = EXCLUDED.expires_at,
           kind = EXCLUDED.kind, invite_id = EXCLUDED.invite_id, invited_by = EXCLUDED.invited_by,
           created_at = EXCLUDED.created_at, updated_at = EXCLUDED.updated_at`,
        [
          foldPrincipalId(member.email),
          member.role,
          member.expiresAt,
          member.kind ?? null,
          member.inviteId ?? null,
          member.invitedBy,
          member.createdAt,
          member.updatedAt,
        ],
      );
    },
    async remove(emails) {
      await q(`DELETE FROM external_members WHERE tenant_id = ${TENANT} AND email = ANY($1)`, [
        emails.map(foldPrincipalId),
      ]);
    },
    close,
  };
}
