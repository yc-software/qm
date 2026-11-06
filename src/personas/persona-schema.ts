import type { PgMigrationDefinition } from "../persistence/pg-pool.ts";
import { parseScopeId, type ScopeId } from "../types.ts";

export const PERSONA_ROLES = ["read", "write", "owner"] as const;
export type PersonaRole = (typeof PERSONA_ROLES)[number];

const roleRank = (role: PersonaRole | null | undefined): number => (role ? PERSONA_ROLES.indexOf(role) + 1 : 0);
export const atLeast = (role: PersonaRole | null | undefined, floor: PersonaRole): boolean =>
  roleRank(role) >= roleRank(floor);
export const activeHolder = (holder: ScopeId, isActive: (principalId: string) => boolean): boolean => {
  const { kind, ref } = parseScopeId(holder);
  return kind !== "personal" || isActive(ref!);
};

export const PERSONA_MIGRATIONS: PgMigrationDefinition[] = [
  {
    id: "users/v2/0004-personas",
    statements: [
      `CREATE TABLE IF NOT EXISTS personas(
        id           TEXT        PRIMARY KEY,
        name         TEXT        NOT NULL CHECK (btrim(name) <> ''),
        description  TEXT        NOT NULL DEFAULT '',
        instructions TEXT        NOT NULL DEFAULT '',
        icon         JSONB,
        created_by   UUID        NOT NULL REFERENCES users(id),
        created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
      )`,
      `CREATE TABLE IF NOT EXISTS persona_access(
        persona_id       TEXT        NOT NULL REFERENCES personas(id) ON DELETE CASCADE,
        grantee_scope_id TEXT        NOT NULL CHECK (split_part(grantee_scope_id, ':', 1) IN ('personal', 'team', 'org', 'channel')),
        role             TEXT        NOT NULL CHECK (role IN ('owner', 'write', 'read')),
        granted_by       UUID        NOT NULL REFERENCES users(id),
        granted_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
        PRIMARY KEY (persona_id, grantee_scope_id)
      )`,
      `CREATE INDEX IF NOT EXISTS persona_access_grantee ON persona_access(grantee_scope_id)`,
    ],
  },
];
