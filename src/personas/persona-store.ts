import { claimRows, type ClaimedRow } from "../tenants/claim.ts";
import { randomUUID } from "node:crypto";
import { createPgPool, withPgTransaction, type Rows } from "../persistence/pg-pool.ts";
import { DIRECTORY_MIGRATIONS } from "../directory/postgres-directory-store.ts";
import { foldPrincipalId } from "../directory/person.ts";
import { ensureUserIn, USER_SCHEMA_MIGRATIONS } from "../identity/user-store.ts";
import { SESSION_MIGRATIONS } from "../sessions/session-schema.ts";
import type { ScopeId } from "../types.ts";
import type { ProjectIcon } from "../projects/project-store.ts";
import type { PersonaRole } from "./persona-schema.ts";

export interface Persona {
  id: string;
  name: string;
  description: string;
  instructions: string;
  icon?: ProjectIcon;
  version: number;
  createdBy: string;
  createdAt: number;
  updatedAt: number;
}

interface PersonaVersionMeta {
  version: number;
  restoredFrom?: number;
  editedBy: string;
  editedAt: number;
}

export interface PersonaVersion extends PersonaVersionMeta {
  name: string;
  description: string;
  instructions: string;
  icon?: ProjectIcon;
}

export interface PersonaVersionPage {
  versions: Array<PersonaVersion | PersonaVersionMeta>;
  more: boolean;
}

export interface PersonaAccess {
  scopeId: ScopeId;
  role: PersonaRole;
  grantedBy: string;
  grantedAt: number;
  pinned?: boolean;
}

export interface PersonaAccessEntry {
  scopeId: ScopeId;
  role: PersonaRole;
  pinned?: boolean;
}

export class PersonaChannelPinned extends Error {
  constructor(channel: ScopeId, cause?: unknown) {
    super(`${channel} already has another persona pinned; unpin it there first`, { cause });
  }
}

export interface PersonaFields {
  name?: string;
  description?: string;
  instructions?: string;
  icon?: ProjectIcon | null;
}

export interface PersonaStore {
  claimTenants?(): Promise<ClaimedRow[]>;
  create(input: PersonaFields & { name: string }, owner: ScopeId, by: string): Promise<Persona>;
  get(id: string): Promise<Persona | null>;
  update(id: string, fields: PersonaFields, by: string, restoredFrom?: number): Promise<Persona | null>;
  versions(id: string, page: { before?: number; limit: number; full?: boolean }): Promise<PersonaVersionPage>;
  version(id: string, version: number): Promise<PersonaVersion | null>;
  remove(id: string): Promise<boolean>;
  access(id: string): Promise<PersonaAccess[]>;
  replaceAccess(id: string, access: ReadonlyArray<PersonaAccessEntry>, by: string): Promise<void>;
  pinnedIn(channel: ScopeId): Promise<string | null>;
  roles(grantees: readonly ScopeId[], id?: string): Promise<Map<string, PersonaRole>>;
  listFor(grantees: readonly ScopeId[]): Promise<Array<Persona & { role: PersonaRole }>>;
  ownerGrants(): Promise<Array<{ personaId: string; scopeId: ScopeId }>>;
  addOwner(id: string, owner: ScopeId, by: string): Promise<void>;
}

const BEST_ROLE = `(ARRAY['read','write','owner'])[MAX(array_position(ARRAY['read','write','owner'], role))]`;

const PERSONA_SELECT = `SELECT p.*, u.primary_alias AS created_by_alias,
    (SELECT MAX(v.version) FROM persona_versions v WHERE v.persona_id = p.id) AS version
  FROM personas p JOIN users u ON u.id = p.created_by`;

const VERSION_SELECT = (columns: string) =>
  `SELECT ${columns}, u.primary_alias AS edited_by_alias FROM persona_versions v JOIN users u ON u.id = v.edited_by`;

const RECORD_VERSION = `INSERT INTO persona_versions
    (persona_id, version, name, description, instructions, icon, restored_from, edited_by, edited_at)
  SELECT p.id, COALESCE((SELECT MAX(version) FROM persona_versions WHERE persona_id = p.id), 0) + 1,
         p.name, p.description, p.instructions, p.icon, $2, $3, p.updated_at
    FROM personas p WHERE p.id = $1`;

const ms = (value: unknown): number => new Date(value as string).getTime();

function toPersona(r: Rows[number]): Persona {
  return {
    id: r.id as string,
    name: r.name as string,
    description: r.description as string,
    instructions: r.instructions as string,
    ...(r.icon ? { icon: r.icon as ProjectIcon } : {}),
    version: Number(r.version),
    createdBy: r.created_by_alias as string,
    createdAt: ms(r.created_at),
    updatedAt: ms(r.updated_at),
  };
}

function toVersionMeta(r: Rows[number]): PersonaVersionMeta {
  return {
    version: Number(r.version),
    ...(r.restored_from != null ? { restoredFrom: Number(r.restored_from) } : {}),
    editedBy: r.edited_by_alias as string,
    editedAt: ms(r.edited_at),
  };
}

function toVersion(r: Rows[number]): PersonaVersion {
  return {
    ...toVersionMeta(r),
    name: r.name as string,
    description: r.description as string,
    instructions: r.instructions as string,
    ...(r.icon ? { icon: r.icon as ProjectIcon } : {}),
  };
}

export class PersonaOwnerRequired extends Error {
  constructor() {
    super("a persona needs at least one owner");
  }
}

export function createPostgresPersonaStore(connectionString: string, opts: { id?: () => string } = {}): PersonaStore {
  const { q, pool } = createPgPool(connectionString, [
    ...DIRECTORY_MIGRATIONS,
    ...SESSION_MIGRATIONS,
    ...USER_SCHEMA_MIGRATIONS,
  ]);
  const nextId = opts.id ?? randomUUID;
  return {
    claimTenants: () => claimRows({ q }, "claim_persona_tenants"),
    async create(input, owner, by) {
      const id = nextId();
      return withPgTransaction(await pool(), async (db) => {
        const user = await ensureUserIn(db, foldPrincipalId(by));
        await db.query(
          `INSERT INTO personas (id, name, description, instructions, icon, created_by)
           VALUES ($1, btrim($2), $3, $4, $5, $6)`,
          [id, input.name, input.description ?? "", input.instructions ?? "", input.icon ?? null, user],
        );
        await db.query(
          `INSERT INTO persona_access (persona_id, grantee_scope_id, role, granted_by) VALUES ($1, $2, 'owner', $3)`,
          [id, owner, user],
        );
        await db.query(RECORD_VERSION, [id, null, user]);
        return toPersona((await db.query(`${PERSONA_SELECT} WHERE p.id = $1`, [id])).rows[0]!);
      });
    },
    async get(id) {
      const rows = await q(`${PERSONA_SELECT} WHERE p.id = $1`, [id]);
      return rows[0] ? toPersona(rows[0]) : null;
    },
    async update(id, fields, by, restoredFrom) {
      return withPgTransaction(await pool(), async (db) => {
        const user = await ensureUserIn(db, foldPrincipalId(by));
        const changed = await db.query(
          `UPDATE personas SET
             name = COALESCE(btrim($2), name),
             description = COALESCE($3, description),
             instructions = COALESCE($4, instructions),
             icon = CASE WHEN $5 THEN $6::jsonb ELSE icon END,
             updated_at = now()
           WHERE id = $1
             AND (name, description, instructions, icon::text) IS DISTINCT FROM
                 (COALESCE(btrim($2), name), COALESCE($3, description), COALESCE($4, instructions),
                  CASE WHEN $5 THEN $6::jsonb ELSE icon END::text)
           RETURNING id`,
          [
            id,
            fields.name ?? null,
            fields.description ?? null,
            fields.instructions ?? null,
            fields.icon !== undefined,
            fields.icon ? JSON.stringify(fields.icon) : null,
          ],
        );
        if (changed.rows.length) await db.query(RECORD_VERSION, [id, restoredFrom ?? null, user]);
        const rows = (await db.query(`${PERSONA_SELECT} WHERE p.id = $1`, [id])).rows;
        return rows[0] ? toPersona(rows[0]) : null;
      });
    },
    async versions(id, page) {
      const rows = await q(
        `${VERSION_SELECT(page.full ? "v.*" : "v.version, v.restored_from, v.edited_at")}
         WHERE v.persona_id = $1 AND ($2::int IS NULL OR v.version < $2)
         ORDER BY v.version DESC LIMIT $3`,
        [id, page.before ?? null, page.limit + 1],
      );
      return {
        versions: rows.slice(0, page.limit).map(page.full ? toVersion : toVersionMeta),
        more: rows.length > page.limit,
      };
    },
    async version(id, version) {
      const rows = await q(`${VERSION_SELECT("v.*")} WHERE v.persona_id = $1 AND v.version = $2`, [id, version]);
      return rows[0] ? toVersion(rows[0]) : null;
    },
    async remove(id) {
      const rows = await q("DELETE FROM personas WHERE id = $1 RETURNING id", [id]);
      return rows.length > 0;
    },
    async access(id) {
      const rows = await q(
        `SELECT a.*, u.primary_alias AS granted_by_alias FROM persona_access a JOIN users u ON u.id = a.granted_by
          WHERE a.persona_id = $1 ORDER BY array_position(ARRAY['owner','write','read'], a.role), a.grantee_scope_id`,
        [id],
      );
      return rows.map((r) => ({
        scopeId: r.grantee_scope_id as ScopeId,
        role: r.role as PersonaRole,
        grantedBy: r.granted_by_alias as string,
        grantedAt: ms(r.granted_at),
        ...(r.pinned ? { pinned: true } : {}),
      }));
    },
    async replaceAccess(id, access, by) {
      if (!access.some((entry) => entry.role === "owner")) throw new PersonaOwnerRequired();
      await withPgTransaction(await pool(), async (db) => {
        await db.query("SELECT 1 FROM personas WHERE id = $1 FOR UPDATE", [id]);
        const user = await ensureUserIn(db, foldPrincipalId(by));
        const kept = access.map((entry) => entry.scopeId);
        await db.query("DELETE FROM persona_access WHERE persona_id = $1 AND NOT (grantee_scope_id = ANY($2))", [
          id,
          kept,
        ]);
        for (const entry of access)
          await db
            .query(
              `INSERT INTO persona_access (persona_id, grantee_scope_id, role, pinned, granted_by) VALUES ($1, $2, $3, $4, $5)
             ON CONFLICT (tenant_id, persona_id, grantee_scope_id) DO UPDATE
               SET role = EXCLUDED.role, pinned = EXCLUDED.pinned, granted_by = EXCLUDED.granted_by, granted_at = now()
               WHERE (persona_access.role, persona_access.pinned) IS DISTINCT FROM (EXCLUDED.role, EXCLUDED.pinned)`,
              [id, entry.scopeId, entry.role, entry.pinned === true, user],
            )
            .catch((e: unknown) => {
              if ((e as { constraint?: string }).constraint === "persona_access_one_pin")
                throw new PersonaChannelPinned(entry.scopeId, e);
              throw e;
            });
      });
    },
    async pinnedIn(channel) {
      const rows = await q("SELECT persona_id FROM persona_access WHERE grantee_scope_id = $1 AND pinned", [channel]);
      return (rows[0]?.persona_id as string | undefined) ?? null;
    },
    async roles(grantees, id) {
      const rows = await q(
        `SELECT persona_id, ${BEST_ROLE} AS role FROM persona_access
          WHERE grantee_scope_id = ANY($1) AND ($2::text IS NULL OR persona_id = $2) GROUP BY persona_id`,
        [[...new Set(grantees)], id ?? null],
      );
      return new Map(rows.map((r) => [r.persona_id as string, r.role as PersonaRole]));
    },
    async listFor(grantees) {
      const rows = await q(
        `SELECT p.*, u.primary_alias AS created_by_alias, best.role
           FROM (SELECT persona_id, ${BEST_ROLE} AS role FROM persona_access
                  WHERE grantee_scope_id = ANY($1) GROUP BY persona_id) best
           JOIN personas p ON p.id = best.persona_id
           JOIN users u ON u.id = p.created_by
          ORDER BY lower(p.name), p.id`,
        [[...new Set(grantees)]],
      );
      return rows.map((r) => ({ ...toPersona(r), role: r.role as PersonaRole }));
    },
    async ownerGrants() {
      const rows = await q(
        "SELECT persona_id, grantee_scope_id FROM persona_access WHERE role = 'owner' ORDER BY persona_id, grantee_scope_id",
      );
      return rows.map((r) => ({ personaId: r.persona_id as string, scopeId: r.grantee_scope_id as ScopeId }));
    },
    async addOwner(id, owner, by) {
      await withPgTransaction(await pool(), async (db) => {
        const user = await ensureUserIn(db, foldPrincipalId(by));
        await db.query(
          `INSERT INTO persona_access (persona_id, grantee_scope_id, role, granted_by) VALUES ($1, $2, 'owner', $3)
           ON CONFLICT (tenant_id, persona_id, grantee_scope_id) DO UPDATE
             SET role = 'owner', granted_by = EXCLUDED.granted_by, granted_at = now()
             WHERE persona_access.role <> 'owner'`,
          [id, owner, user],
        );
      });
    },
  };
}
