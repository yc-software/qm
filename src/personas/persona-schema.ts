import type { PgMigrationDefinition } from "../persistence/pg-pool.ts";
import { parseScopeId, type ScopeId } from "../types.ts";

export const PERSONA_ROLES = ["read", "write", "owner"] as const;
export type PersonaRole = (typeof PERSONA_ROLES)[number];

const roleRank = (role: PersonaRole | null | undefined): number => (role ? PERSONA_ROLES.indexOf(role) + 1 : 0);
export const atLeast = (role: PersonaRole | null | undefined, floor: PersonaRole): boolean =>
  roleRank(role) >= roleRank(floor);
export const activeHolder = (holder: ScopeId, isActive: (principalId: string) => boolean): boolean => {
  const { kind, ref } = parseScopeId(holder);
  return kind !== "channel" && (kind !== "personal" || isActive(ref!));
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
  {
    id: "users/v2/0005-persona-versions",
    statements: [
      `CREATE TABLE IF NOT EXISTS persona_versions(
        persona_id    TEXT        NOT NULL REFERENCES personas(id) ON DELETE CASCADE,
        version       INT         NOT NULL CHECK (version > 0),
        name          TEXT        NOT NULL,
        description   TEXT        NOT NULL,
        instructions  TEXT        NOT NULL,
        icon          JSONB,
        restored_from INT,
        edited_by     UUID        NOT NULL REFERENCES users(id),
        edited_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
        PRIMARY KEY (persona_id, version)
      )`,
      `INSERT INTO persona_versions (persona_id, version, name, description, instructions, icon, edited_by, edited_at)
       SELECT id, 1, name, description, instructions, icon, created_by, updated_at FROM personas
       ON CONFLICT DO NOTHING`,
      `INSERT INTO persona_access (persona_id, grantee_scope_id, role, granted_by)
       SELECT p.id, 'personal:' || u.primary_alias, 'owner', p.created_by
         FROM personas p JOIN users u ON u.id = p.created_by
        WHERE NOT EXISTS (SELECT 1 FROM persona_access o
                           WHERE o.persona_id = p.id AND o.role = 'owner' AND o.grantee_scope_id NOT LIKE 'channel:%')
       ON CONFLICT (persona_id, grantee_scope_id) DO UPDATE SET role = 'owner'`,
      `UPDATE persona_access SET role = 'read' WHERE grantee_scope_id LIKE 'channel:%' AND role <> 'read'`,
    ],
  },
  {
    id: "users/v2/0006-persona-channel-pins",
    statements: [
      `ALTER TABLE persona_access ADD COLUMN IF NOT EXISTS pinned BOOLEAN NOT NULL DEFAULT false`,
      `CREATE UNIQUE INDEX IF NOT EXISTS persona_access_one_pin ON persona_access(grantee_scope_id) WHERE pinned`,
      `DO $$ BEGIN
         IF to_regclass('persona_channel_defaults') IS NOT NULL THEN
           INSERT INTO persona_access (persona_id, grantee_scope_id, role, granted_by, pinned)
           SELECT p.id, d.id, 'read',
                  COALESCE(
                    (SELECT l.user_id FROM user_links l WHERE l.alias_id = d.json->>'setBy'),
                    p.created_by),
                  true
             FROM persona_channel_defaults d
             JOIN personas p ON p.id = d.json->>'personaId'
            WHERE d.id LIKE 'channel:%'
           ON CONFLICT (persona_id, grantee_scope_id) DO UPDATE SET pinned = true;
           DROP TABLE persona_channel_defaults;
         END IF;
       END $$`,
    ],
  },
];
