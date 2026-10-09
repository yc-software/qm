import { createHash, randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import { createPgPool } from "../persistence/pg-pool.ts";
import { combineReferences } from "./principal-refs.ts";

type PrincipalKind = "person" | "agent";
export type IdentityProvider = "oidc" | "slack" | "email" | "composio";

/** A handle as its edge knows it: the provider that vouched for it and that provider's id. */
export interface Handle {
  provider: IdentityProvider;
  externalId: string;
}

/** Emails are stored lowercased; every other provider's id is kept verbatim. */
export const handle = (provider: IdentityProvider, externalId: string): Handle => ({
  provider,
  externalId: provider === "email" ? externalId.trim().toLowerCase() : externalId.trim(),
});

interface PrincipalRow {
  principalId: string;
  kind: PrincipalKind;
  displayName: string;
  createdAt: number;
}

export interface IdentityRow {
  provider: IdentityProvider;
  externalId: string;
  principalId: string | null;
  email: string | null;
  verifiedAt: number | null;
  linkedBy: string | null;
  evidence: string | null;
  updatedAt: number;
}

export class IdentityLinkError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const isPrincipalId = (id: string): boolean => UUID.test(id);

const PROVIDERS: readonly IdentityProvider[] = ["oidc", "slack", "email", "composio"];
export const isIdentityProvider = (v: unknown): v is IdentityProvider => PROVIDERS.includes(v as IdentityProvider);

/** An id as an edge hands it over: a principal id, or a handle whose provider the edge names. */
export interface EdgeHandle {
  principalId: string;
  provider?: IdentityProvider;
}

/** Resolve an edge id. Without a provider it must already be a principal id; nothing is inferred from its shape. */
export async function principalFromEdge(
  graph: Pick<PrincipalGraph, "act">,
  id: string,
  provider: IdentityProvider | undefined,
  opts?: ActOptions,
): Promise<string> {
  if (provider) return graph.act(handle(provider, id), opts);
  const s = id.trim();
  if (!isPrincipalId(s)) throw new IdentityLinkError(400, "a handle needs its provider");
  return s.toLowerCase();
}

/** The Composio user id an org mints for a principal (or, before principals, for a handle). */
export function composioUserId(org: string, owner: string): string {
  return `qm_${createHash("sha256")
    .update(JSON.stringify([org, owner]))
    .digest("hex")}`;
}

const key = (provider: string, externalId: string): string => `${provider}\u0000${externalId}`;

/** Storage for the two identity tables. Postgres in production, memory in tests and single-process dev. */
export interface PrincipalStore {
  load(): Promise<{ principals: PrincipalRow[]; identities: IdentityRow[] }>;
  /** Changes whenever either table is written, so readers reload only when something moved. */
  version(): Promise<string>;
  createForIdentity(principal: PrincipalRow, identity: IdentityRow): Promise<string>;
  putIdentity(row: IdentityRow): Promise<void>;
  deleteIdentity(provider: string, externalId: string): Promise<void>;
  combine(keep: string, drop: string): Promise<void>;
}

export function createMemoryPrincipalStore(): PrincipalStore {
  const principals = new Map<string, PrincipalRow>();
  const identities = new Map<string, IdentityRow>();
  let version = 0;
  return {
    async load() {
      return {
        principals: [...principals.values()].map((p) => ({ ...p })),
        identities: [...identities.values()].map((i) => ({ ...i })),
      };
    },
    async version() {
      return String(version);
    },
    async createForIdentity(principal, row) {
      const existing = identities.get(key(row.provider, row.externalId))?.principalId;
      if (existing) return existing;
      principals.set(principal.principalId, principal);
      identities.set(key(row.provider, row.externalId), { ...row });
      version++;
      return principal.principalId;
    },
    async putIdentity(row) {
      identities.set(key(row.provider, row.externalId), { ...row });
      version++;
    },
    async deleteIdentity(provider, externalId) {
      identities.delete(key(provider, externalId));
      version++;
    },
    async combine(keep, drop) {
      for (const row of identities.values()) if (row.principalId === drop) row.principalId = keep;
      principals.delete(drop);
      version++;
    },
  };
}

const PRINCIPAL_SCHEMA = [
  `CREATE TABLE IF NOT EXISTS principals(
    principal_id UUID PRIMARY KEY,
    kind         TEXT NOT NULL CHECK (kind IN ('person', 'agent')),
    display_name TEXT NOT NULL,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
  )`,
  `CREATE TABLE IF NOT EXISTS identities(
    provider     TEXT NOT NULL,
    external_id  TEXT NOT NULL,
    principal_id UUID REFERENCES principals(principal_id),
    email        TEXT,
    verified_at  TIMESTAMPTZ,
    linked_by    TEXT,
    evidence     TEXT,
    updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (provider, external_id)
  )`,
  `CREATE INDEX IF NOT EXISTS identities_by_principal ON identities(principal_id)`,
];

/** One counter both tables bump on every statement, so a cached graph reloads only after a write. */
const VERSION_SCHEMA = [
  `CREATE TABLE IF NOT EXISTS identity_version(id INT PRIMARY KEY CHECK (id = 1), v BIGINT NOT NULL)`,
  `INSERT INTO identity_version(id, v) VALUES (1, 0) ON CONFLICT DO NOTHING`,
  `CREATE OR REPLACE FUNCTION bump_identity_version() RETURNS trigger LANGUAGE plpgsql AS $$
   BEGIN UPDATE identity_version SET v = v + 1 WHERE id = 1; RETURN NULL; END $$`,
  `DROP TRIGGER IF EXISTS principals_version ON principals`,
  `CREATE TRIGGER principals_version AFTER INSERT OR UPDATE OR DELETE ON principals
   FOR EACH STATEMENT EXECUTE FUNCTION bump_identity_version()`,
  `DROP TRIGGER IF EXISTS identities_version ON identities`,
  `CREATE TRIGGER identities_version AFTER INSERT OR UPDATE OR DELETE ON identities
   FOR EACH STATEMENT EXECUTE FUNCTION bump_identity_version()`,
];

export const PRINCIPAL_MIGRATIONS = [
  { id: "identity/principals/0001", statements: PRINCIPAL_SCHEMA },
  { id: "identity/principals/0002-version", statements: VERSION_SCHEMA },
];

const ts = (ms: number | null): Date | null => (ms === null ? null : new Date(ms));
const ms = (v: unknown): number | null => {
  if (v instanceof Date) return v.getTime();
  return v == null ? null : Number(v);
};

export function createPostgresPrincipalStore(connectionString: string): PrincipalStore {
  const { q, pool } = createPgPool(connectionString, PRINCIPAL_MIGRATIONS);
  return {
    async load() {
      const [p, i] = await Promise.all([q("SELECT * FROM principals"), q("SELECT * FROM identities")]);
      return {
        principals: p.map((r) => ({
          principalId: String(r.principal_id),
          kind: r.kind as PrincipalKind,
          displayName: String(r.display_name),
          createdAt: ms(r.created_at) ?? 0,
        })),
        identities: i.map((r) => ({
          provider: r.provider as IdentityProvider,
          externalId: String(r.external_id),
          principalId: r.principal_id == null ? null : String(r.principal_id),
          email: r.email == null ? null : String(r.email),
          verifiedAt: ms(r.verified_at),
          linkedBy: r.linked_by == null ? null : String(r.linked_by),
          evidence: r.evidence == null ? null : String(r.evidence),
          updatedAt: ms(r.updated_at) ?? 0,
        })),
      };
    },
    async version() {
      const rows = await q("SELECT v FROM identity_version WHERE id = 1");
      return String(rows[0]?.v ?? "");
    },
    async createForIdentity(principal, row) {
      const client: PoolClient = await (await pool()).connect();
      try {
        await client.query("BEGIN");
        await client.query(
          "INSERT INTO principals(principal_id, kind, display_name, created_at) VALUES ($1, $2, $3, $4)",
          [principal.principalId, principal.kind, principal.displayName, ts(principal.createdAt)],
        );
        const claimed = await client.query(
          `INSERT INTO identities(provider, external_id, principal_id, email, verified_at, linked_by, evidence, updated_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8) ON CONFLICT (provider, external_id) DO NOTHING RETURNING principal_id`,
          [
            row.provider,
            row.externalId,
            row.principalId,
            row.email,
            ts(row.verifiedAt),
            row.linkedBy,
            row.evidence,
            ts(row.updatedAt),
          ],
        );
        if (claimed.rowCount) {
          await client.query("COMMIT");
          return principal.principalId;
        }
        await client.query("ROLLBACK");
        const winner = await client.query(
          "SELECT principal_id FROM identities WHERE provider = $1 AND external_id = $2",
          [row.provider, row.externalId],
        );
        const id = winner.rows[0]?.principal_id;
        if (id == null) throw new Error(`identity ${row.provider}:${row.externalId} is unlinked; link it instead`);
        return String(id);
      } catch (error) {
        await client.query("ROLLBACK").catch(() => {});
        throw error;
      } finally {
        client.release();
      }
    },
    async putIdentity(row) {
      await q(
        `INSERT INTO identities(provider, external_id, principal_id, email, verified_at, linked_by, evidence, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         ON CONFLICT (provider, external_id) DO UPDATE SET principal_id = $3, email = $4, verified_at = $5,
           linked_by = $6, evidence = $7, updated_at = $8`,
        [
          row.provider,
          row.externalId,
          row.principalId,
          row.email,
          ts(row.verifiedAt),
          row.linkedBy,
          row.evidence,
          ts(row.updatedAt),
        ],
      );
    },
    async deleteIdentity(provider, externalId) {
      await q("DELETE FROM identities WHERE provider = $1 AND external_id = $2", [provider, externalId]);
    },
    async combine(keep, drop) {
      const client: PoolClient = await (await pool()).connect();
      try {
        await client.query("BEGIN");
        await combineReferences(client, keep, drop);
        await client.query("COMMIT");
      } catch (error) {
        await client.query("ROLLBACK").catch(() => {});
        throw error;
      } finally {
        client.release();
      }
    },
  };
}

interface ActOptions {
  email?: string | null;
  displayName?: string;
  kind?: PrincipalKind;
  verified?: boolean;
}

export interface PrincipalGraph {
  refresh(force?: boolean): Promise<void>;
  principalOf(h: Handle): string | undefined;
  identitiesOf(principalId: string): IdentityRow[];
  displayName(principalId: string): string | undefined;
  act(h: Handle, opts?: ActOptions): Promise<string>;
  attach(h: Handle, principalId: string, linkedBy: string, evidence?: string): Promise<IdentityRow>;
  unlink(h: Handle): Promise<IdentityRow | null>;
  setEmails(principalId: string, emails: readonly string[], linkedBy: string): Promise<void>;
  autoLink(h: Handle, email: string): Promise<string | undefined>;
  identities(principalId?: string): Promise<IdentityRow[]>;
  principals(): Promise<PrincipalRow[]>;
  combine(keep: string, drop: string): Promise<void>;
}

const REFRESH_TTL_MS = 10_000;

export function createPrincipalGraph(
  store: PrincipalStore = createMemoryPrincipalStore(),
  opts: { onAutoLink?: (identity: IdentityRow) => void } = {},
): PrincipalGraph {
  const principals = new Map<string, PrincipalRow>();
  const identities = new Map<string, IdentityRow>();
  const byPrincipal = new Map<string, Map<string, IdentityRow>>();
  let checkedAt = 0;
  let loadedVersion: string | null = null;
  let refreshP: Promise<void> | null = null;
  let tail: Promise<unknown> = Promise.resolve();
  const serial = <T>(fn: () => Promise<T>): Promise<T> => {
    const run = tail.then(fn, fn);
    tail = run.catch(() => {});
    return run;
  };

  function forget(k: string): void {
    const prior = identities.get(k);
    if (prior?.principalId) byPrincipal.get(prior.principalId)?.delete(k);
    identities.delete(k);
  }

  function remember(row: IdentityRow): void {
    const k = key(row.provider, row.externalId);
    forget(k);
    identities.set(k, row);
    if (!row.principalId) return;
    const rows = byPrincipal.get(row.principalId) ?? new Map<string, IdentityRow>();
    rows.set(k, row);
    byPrincipal.set(row.principalId, rows);
  }

  /** Checks the store's version at most once per TTL (always when forced) and reloads only when it moved. */
  function refresh(force = false): Promise<void> {
    if (refreshP) return refreshP;
    if (!force && Date.now() - checkedAt < REFRESH_TTL_MS) return Promise.resolve();
    refreshP = (async () => {
      const version = await store.version();
      checkedAt = Date.now();
      if (version === loadedVersion) return;
      const data = await store.load();
      principals.clear();
      identities.clear();
      byPrincipal.clear();
      for (const p of data.principals) principals.set(p.principalId, p);
      for (const i of data.identities) remember(i);
      loadedVersion = version;
    })().finally(() => {
      refreshP = null;
    });
    return refreshP;
  }

  const identity = (h: Handle): IdentityRow | undefined => identities.get(key(h.provider, h.externalId));
  const principalOf = (h: Handle): string | undefined => identity(h)?.principalId ?? undefined;

  async function write(row: IdentityRow): Promise<IdentityRow> {
    await store.putIdentity(row);
    remember(row);
    return row;
  }

  function blank(h: Handle, email: string | null): IdentityRow {
    return (
      identity(h) ?? {
        ...h,
        principalId: null,
        email: h.provider === "email" ? h.externalId : email,
        verifiedAt: null,
        linkedBy: null,
        evidence: null,
        updatedAt: Date.now(),
      }
    );
  }

  async function autoLinkLocked(h: Handle, email: string): Promise<string | undefined> {
    const current = identity(h);
    if (current?.principalId) return current.principalId;
    const address = email.trim().toLowerCase();
    const owner = address ? principalOf(handle("email", address)) : undefined;
    if (!owner) return undefined;
    const row = await write({
      ...blank(h, address),
      principalId: owner,
      linkedBy: "auto:email",
      evidence: address,
      updatedAt: Date.now(),
    });
    opts.onAutoLink?.(row);
    return owner;
  }

  async function principalFor(id: string): Promise<string> {
    if (!principals.has(id)) await refresh(true);
    if (!principals.has(id)) throw new IdentityLinkError(404, `no principal ${id}`);
    return id;
  }

  return {
    refresh,
    principalOf,
    identitiesOf(principalId) {
      return [...(byPrincipal.get(principalId)?.values() ?? [])];
    },
    displayName(principalId) {
      return principals.get(principalId)?.displayName;
    },
    async act(h, o = {}) {
      const cached = principalOf(h);
      if (cached) return cached;
      return serial(async () => {
        await refresh();
        const known = principalOf(h);
        if (known) return known;
        const email = o.email?.trim().toLowerCase() || null;
        const linked = await autoLinkLocked(h, email ?? (h.provider === "email" ? h.externalId : ""));
        if (linked) return linked;
        const principal: PrincipalRow = {
          principalId: randomUUID(),
          kind: o.kind ?? "person",
          displayName: o.displayName?.trim() || email || h.externalId,
          createdAt: Date.now(),
        };
        const row: IdentityRow = {
          ...blank(h, email),
          principalId: principal.principalId,
          linkedBy: "self",
          verifiedAt: o.verified ? Date.now() : null,
          updatedAt: Date.now(),
        };
        const owner = await store.createForIdentity(principal, row);
        if (owner !== principal.principalId) {
          await refresh(true);
          return owner;
        }
        principals.set(principal.principalId, principal);
        remember(row);
        return owner;
      });
    },
    attach(h, principalId, linkedBy, evidence) {
      return serial(async () => {
        await refresh();
        const target = await principalFor(principalId);
        const previous = principalOf(h);
        const row = await write({
          ...blank(h, null),
          principalId: target,
          linkedBy,
          evidence: evidence ?? null,
          updatedAt: Date.now(),
        });
        if (previous && previous !== target) {
          await store.combine(target, previous);
          await refresh(true);
        }
        return row;
      });
    },
    unlink(h) {
      return serial(async () => {
        await refresh();
        const row = identity(h);
        if (!row?.principalId) return null;
        return write({ ...row, principalId: null, linkedBy: null, evidence: null, updatedAt: Date.now() });
      });
    },
    setEmails(principalId, emails, linkedBy) {
      return serial(async () => {
        await refresh();
        await principalFor(principalId);
        const wanted = new Set(emails.map((e) => handle("email", e).externalId).filter(Boolean));
        for (const row of [...(byPrincipal.get(principalId)?.values() ?? [])])
          if (row.provider === "email" && row.linkedBy === linkedBy && !wanted.has(row.externalId)) {
            await store.deleteIdentity(row.provider, row.externalId);
            forget(key(row.provider, row.externalId));
          }
        for (const address of wanted) {
          const h = handle("email", address);
          if (principalOf(h)) continue;
          await write({ ...blank(h, address), principalId, linkedBy, updatedAt: Date.now() });
        }
        for (const row of Array.from(identities.values()))
          if (row.provider !== "email" && !row.principalId && row.email && wanted.has(row.email))
            await autoLinkLocked(row, row.email);
      });
    },
    autoLink(h, email) {
      return serial(async () => {
        await refresh();
        return autoLinkLocked(h, email);
      });
    },
    async identities(principalId) {
      await refresh();
      if (principalId !== undefined) return [...(byPrincipal.get(principalId)?.values() ?? [])];
      return [...identities.values()];
    },
    async principals() {
      await refresh();
      return [...principals.values()];
    },
    combine(keep, drop) {
      return serial(async () => {
        if (keep === drop) throw new IdentityLinkError(400, "a principal cannot be combined with itself");
        await principalFor(keep);
        await principalFor(drop);
        await store.combine(keep, drop);
        await refresh(true);
      });
    },
  };
}
