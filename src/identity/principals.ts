import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import { createPgPool } from "../persistence/pg-pool.ts";
import { combineReferences } from "./principal-refs.ts";

type PrincipalKind = "person" | "agent";
export type IdentityProvider = "oidc" | "slack" | "email";

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
const SLACK_USER = /^[UW][A-Z0-9]+$/;

export const isPrincipalId = (id: string): boolean => UUID.test(id);

/** The identity a raw handle names. Emails are lowercased; Slack user ids and OIDC subjects are kept verbatim. */
export function handleOf(raw: string): { provider: IdentityProvider; externalId: string } {
  const id = raw.trim();
  if (id.includes("@") && !id.startsWith("oidc:")) return { provider: "email", externalId: id.toLowerCase() };
  if (SLACK_USER.test(id) || /^T[A-Z0-9]+:[UW][A-Z0-9]+$/.test(id)) return { provider: "slack", externalId: id };
  return { provider: "oidc", externalId: id };
}

const key = (provider: string, externalId: string): string => `${provider}\u0000${externalId}`;

/** Storage for the two identity tables. Postgres in production, memory in tests and single-process dev. */
export interface PrincipalStore {
  load(): Promise<{ principals: PrincipalRow[]; identities: IdentityRow[] }>;
  createForIdentity(principal: PrincipalRow, identity: IdentityRow): Promise<string>;
  putIdentity(row: IdentityRow): Promise<void>;
  deleteIdentity(provider: string, externalId: string): Promise<void>;
  combine(keep: string, drop: string): Promise<void>;
}

export function createMemoryPrincipalStore(): PrincipalStore {
  const principals = new Map<string, PrincipalRow>();
  const identities = new Map<string, IdentityRow>();
  return {
    async load() {
      return { principals: [...principals.values()], identities: [...identities.values()] };
    },
    async createForIdentity(principal, row) {
      const existing = identities.get(key(row.provider, row.externalId))?.principalId;
      if (existing) return existing;
      principals.set(principal.principalId, principal);
      identities.set(key(row.provider, row.externalId), row);
      return principal.principalId;
    },
    async putIdentity(row) {
      identities.set(key(row.provider, row.externalId), row);
    },
    async deleteIdentity(provider, externalId) {
      identities.delete(key(provider, externalId));
    },
    async combine(keep, drop) {
      for (const row of identities.values()) if (row.principalId === drop) row.principalId = keep;
      principals.delete(drop);
    },
  };
}

export const PRINCIPAL_SCHEMA = [
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

const ts = (ms: number | null): Date | null => (ms === null ? null : new Date(ms));
const ms = (v: unknown): number | null => {
  if (v instanceof Date) return v.getTime();
  return v == null ? null : Number(v);
};

export function createPostgresPrincipalStore(connectionString: string): PrincipalStore {
  const { q, pool } = createPgPool(connectionString, "identity/principals/0001", PRINCIPAL_SCHEMA);
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
  principalOf(handle: string): string | undefined;
  identitiesOf(principalId: string): IdentityRow[];
  displayName(principalId: string): string | undefined;
  act(handle: string, opts?: ActOptions): Promise<string>;
  attach(handle: string, principalId: string, linkedBy: string, evidence?: string): Promise<IdentityRow>;
  unlink(handle: string): Promise<IdentityRow | null>;
  setEmails(principalId: string, emails: readonly string[], linkedBy: string): Promise<void>;
  autoLink(handle: string, email: string): Promise<string | undefined>;
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
  let refreshedAt = 0;
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

  async function refresh(force = false): Promise<void> {
    if (!force && Date.now() - refreshedAt < REFRESH_TTL_MS) return;
    if (refreshP) return refreshP;
    refreshP = store
      .load()
      .then((data) => {
        principals.clear();
        identities.clear();
        byPrincipal.clear();
        for (const p of data.principals) principals.set(p.principalId, p);
        for (const i of data.identities) remember(i);
        refreshedAt = Date.now();
      })
      .finally(() => {
        refreshP = null;
      });
    return refreshP;
  }

  const identity = (handle: string): IdentityRow | undefined => {
    const h = handleOf(handle);
    return identities.get(key(h.provider, h.externalId));
  };

  function principalOf(handle: string): string | undefined {
    const id = handle.trim();
    if (isPrincipalId(id)) return id.toLowerCase();
    return identity(id)?.principalId ?? undefined;
  }

  async function write(row: IdentityRow): Promise<IdentityRow> {
    await store.putIdentity(row);
    remember(row);
    return row;
  }

  function blank(handle: string, email: string | null): IdentityRow {
    const h = handleOf(handle);
    const prior = identities.get(key(h.provider, h.externalId));
    return (
      prior ?? {
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

  const emailOwner = (email: string): string | undefined =>
    identities.get(key("email", email.trim().toLowerCase()))?.principalId ?? undefined;

  async function autoLinkLocked(handle: string, email: string): Promise<string | undefined> {
    const current = identity(handle);
    if (current?.principalId) return current.principalId;
    const owner = emailOwner(email);
    if (!owner) return undefined;
    const row = await write({
      ...blank(handle, email.trim().toLowerCase()),
      principalId: owner,
      linkedBy: "auto:email",
      evidence: email.trim().toLowerCase(),
      updatedAt: Date.now(),
    });
    opts.onAutoLink?.(row);
    return owner;
  }

  async function principalFor(id: string): Promise<string> {
    const target = principalOf(id);
    if (!target || !principals.has(target)) await refresh(true);
    if (!target || !principals.has(target)) throw new IdentityLinkError(404, `no principal ${id}`);
    return target;
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
    async act(handle, o = {}) {
      const cached = principalOf(handle);
      if (cached) return cached;
      return serial(async () => {
        await refresh();
        const known = principalOf(handle);
        if (known) return known;
        const email = o.email?.trim().toLowerCase() || null;
        const h = handleOf(handle);
        const linked = await autoLinkLocked(handle, email ?? (h.provider === "email" ? h.externalId : ""));
        if (linked) return linked;
        const principal: PrincipalRow = {
          principalId: randomUUID(),
          kind: o.kind ?? "person",
          displayName: o.displayName?.trim() || email || h.externalId,
          createdAt: Date.now(),
        };
        const row: IdentityRow = {
          ...blank(handle, email),
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
    attach(handle, principalId, linkedBy, evidence) {
      return serial(async () => {
        await refresh();
        const target = await principalFor(principalId);
        const previous = identity(handle)?.principalId;
        const row = await write({
          ...blank(handle, null),
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
    unlink(handle) {
      return serial(async () => {
        await refresh();
        const row = identity(handle);
        if (!row?.principalId) return null;
        return write({ ...row, principalId: null, linkedBy: null, evidence: null, updatedAt: Date.now() });
      });
    },
    setEmails(principalId, emails, linkedBy) {
      return serial(async () => {
        await refresh();
        await principalFor(principalId);
        const wanted = new Set(emails.map((e) => e.trim().toLowerCase()).filter((e) => e.includes("@")));
        for (const row of [...(byPrincipal.get(principalId)?.values() ?? [])])
          if (row.provider === "email" && row.linkedBy === linkedBy && !wanted.has(row.externalId)) {
            await store.deleteIdentity(row.provider, row.externalId);
            forget(key(row.provider, row.externalId));
          }
        for (const address of wanted) {
          if (identities.get(key("email", address))?.principalId) continue;
          await write({ ...blank(address, address), principalId, linkedBy, updatedAt: Date.now() });
        }
        for (const row of Array.from(identities.values()))
          if (row.provider !== "email" && !row.principalId && row.email && wanted.has(row.email))
            await autoLinkLocked(row.externalId, row.email);
      });
    },
    autoLink(handle, email) {
      return serial(async () => {
        await refresh();
        return autoLinkLocked(handle, email);
      });
    },
    async identities(principalId) {
      await refresh();
      return [...identities.values()].filter((r) => principalId === undefined || r.principalId === principalId);
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
