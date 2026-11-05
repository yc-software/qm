import { randomUUID } from "node:crypto";
import { createPgPool, withPgTransaction, type PgMigrationDefinition, type Rows } from "../persistence/pg-pool.ts";
import type { ScopeId } from "../types.ts";

export const PERSONA_ROLES = ["read", "write", "owner"] as const;
export type PersonaRole = (typeof PERSONA_ROLES)[number];

export const roleRank = (role: PersonaRole | null | undefined): number => (role ? PERSONA_ROLES.indexOf(role) + 1 : 0);
export const atLeast = (role: PersonaRole | null | undefined, floor: PersonaRole): boolean =>
  roleRank(role) >= roleRank(floor);

export interface PersonaIcon {
  kind: "emoji" | "custom";
  value: string;
}

export interface Persona {
  id: string;
  name: string;
  description: string;
  instructions: string;
  icon?: PersonaIcon;
  forkedFromId?: string;
  createdBy: string;
  createdAt: number;
  updatedAt: number;
}

export interface PersonaAccess {
  scopeId: ScopeId;
  role: PersonaRole;
  grantedBy: string;
  grantedAt: number;
}

export interface PersonaFields {
  name?: string;
  description?: string;
  instructions?: string;
  icon?: PersonaIcon | null;
}

export interface PersonaStore {
  create(input: PersonaFields & { name: string; forkedFromId?: string }, owner: ScopeId, by: string): Promise<Persona>;
  get(id: string): Promise<Persona | null>;
  update(id: string, fields: PersonaFields): Promise<Persona | null>;
  remove(id: string): Promise<boolean>;
  access(id: string): Promise<PersonaAccess[]>;
  replaceAccess(id: string, access: ReadonlyArray<{ scopeId: ScopeId; role: PersonaRole }>, by: string): Promise<void>;
  roles(grantees: readonly ScopeId[], id?: string): Promise<Map<string, PersonaRole>>;
}

export const PERSONA_MIGRATIONS: PgMigrationDefinition[] = [
  {
    id: "personas/store/0001",
    statements: [
      `CREATE TABLE IF NOT EXISTS personas(
        id             TEXT        PRIMARY KEY,
        name           TEXT        NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 200),
        description    TEXT        NOT NULL DEFAULT '',
        instructions   TEXT        NOT NULL DEFAULT '',
        icon_kind      TEXT        CHECK (icon_kind IN ('emoji', 'custom')),
        icon_value     TEXT,
        forked_from_id TEXT,
        created_by     TEXT        NOT NULL,
        created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
        CHECK ((icon_kind IS NULL) = (icon_value IS NULL))
      )`,
      `CREATE TABLE IF NOT EXISTS persona_access(
        persona_id       TEXT        NOT NULL REFERENCES personas(id) ON DELETE CASCADE,
        grantee_scope_id TEXT        NOT NULL CHECK (grantee_scope_id ~ '^(personal|team|org|channel):.+'),
        role             TEXT        NOT NULL CHECK (role IN ('owner', 'write', 'read')),
        granted_by       TEXT        NOT NULL,
        granted_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
        PRIMARY KEY (persona_id, grantee_scope_id)
      )`,
      `CREATE INDEX IF NOT EXISTS persona_access_grantee ON persona_access(grantee_scope_id)`,
    ],
  },
];

const ms = (value: unknown): number => new Date(value as string).getTime();

function toPersona(r: Rows[number]): Persona {
  return {
    id: r.id as string,
    name: r.name as string,
    description: r.description as string,
    instructions: r.instructions as string,
    ...(r.icon_kind ? { icon: { kind: r.icon_kind as PersonaIcon["kind"], value: r.icon_value as string } } : {}),
    ...(r.forked_from_id ? { forkedFromId: r.forked_from_id as string } : {}),
    createdBy: r.created_by as string,
    createdAt: ms(r.created_at),
    updatedAt: ms(r.updated_at),
  };
}

export class PersonaOwnerRequired extends Error {
  constructor() {
    super("a persona needs at least one owner");
  }
}

export function createPostgresPersonaStore(connectionString: string, opts: { id?: () => string } = {}): PersonaStore {
  const { q, pool } = createPgPool(connectionString, PERSONA_MIGRATIONS);
  const nextId = opts.id ?? randomUUID;
  return {
    async create(input, owner, by) {
      const id = nextId();
      return withPgTransaction(await pool(), async (db) => {
        const { rows } = await db.query(
          `INSERT INTO personas (id, name, description, instructions, icon_kind, icon_value, forked_from_id, created_by)
           VALUES ($1, btrim($2), $3, $4, $5, $6, $7, $8) RETURNING *`,
          [
            id,
            input.name,
            input.description ?? "",
            input.instructions ?? "",
            input.icon?.kind ?? null,
            input.icon?.value ?? null,
            input.forkedFromId ?? null,
            by,
          ],
        );
        await db.query(
          `INSERT INTO persona_access (persona_id, grantee_scope_id, role, granted_by) VALUES ($1, $2, 'owner', $3)`,
          [id, owner, by],
        );
        return toPersona(rows[0]!);
      });
    },
    async get(id) {
      const rows = await q("SELECT * FROM personas WHERE id = $1", [id]);
      return rows[0] ? toPersona(rows[0]) : null;
    },
    async update(id, fields) {
      const icon = fields.icon === undefined ? undefined : fields.icon;
      const rows = await q(
        `UPDATE personas SET
           name = COALESCE(btrim($2), name),
           description = COALESCE($3, description),
           instructions = COALESCE($4, instructions),
           icon_kind = CASE WHEN $5 THEN $6 ELSE icon_kind END,
           icon_value = CASE WHEN $5 THEN $7 ELSE icon_value END,
           updated_at = now()
         WHERE id = $1 RETURNING *`,
        [
          id,
          fields.name ?? null,
          fields.description ?? null,
          fields.instructions ?? null,
          icon !== undefined,
          icon?.kind ?? null,
          icon?.value ?? null,
        ],
      );
      return rows[0] ? toPersona(rows[0]) : null;
    },
    async remove(id) {
      const rows = await q("DELETE FROM personas WHERE id = $1 RETURNING id", [id]);
      return rows.length > 0;
    },
    async access(id) {
      const rows = await q(
        "SELECT * FROM persona_access WHERE persona_id = $1 ORDER BY array_position(ARRAY['owner','write','read'], role), grantee_scope_id",
        [id],
      );
      return rows.map((r) => ({
        scopeId: r.grantee_scope_id as ScopeId,
        role: r.role as PersonaRole,
        grantedBy: r.granted_by as string,
        grantedAt: ms(r.granted_at),
      }));
    },
    async replaceAccess(id, access, by) {
      if (!access.some((entry) => entry.role === "owner")) throw new PersonaOwnerRequired();
      await withPgTransaction(await pool(), async (db) => {
        await db.query("SELECT 1 FROM personas WHERE id = $1 FOR UPDATE", [id]);
        const kept = access.map((entry) => entry.scopeId);
        await db.query("DELETE FROM persona_access WHERE persona_id = $1 AND NOT (grantee_scope_id = ANY($2))", [
          id,
          kept,
        ]);
        for (const entry of access)
          await db.query(
            `INSERT INTO persona_access (persona_id, grantee_scope_id, role, granted_by) VALUES ($1, $2, $3, $4)
             ON CONFLICT (persona_id, grantee_scope_id) DO UPDATE
               SET role = EXCLUDED.role, granted_by = EXCLUDED.granted_by, granted_at = now()
               WHERE persona_access.role IS DISTINCT FROM EXCLUDED.role`,
            [id, entry.scopeId, entry.role, by],
          );
      });
    },
    async roles(grantees, id) {
      const rows = await q(
        `SELECT persona_id, role FROM persona_access
          WHERE grantee_scope_id = ANY($1) AND ($2::text IS NULL OR persona_id = $2)`,
        [[...new Set(grantees)], id ?? null],
      );
      const best = new Map<string, PersonaRole>();
      for (const r of rows) {
        const role = r.role as PersonaRole;
        const key = r.persona_id as string;
        if (roleRank(role) > roleRank(best.get(key))) best.set(key, role);
      }
      return best;
    },
  };
}
