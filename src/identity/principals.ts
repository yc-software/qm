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
  insertPrincipal(row: PrincipalRow): Promise<void>;
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
    async insertPrincipal(row) {
      principals.set(row.principalId, row);
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
    async insertPrincipal(row) {
      await q(
        "INSERT INTO principals(principal_id, kind, display_name, created_at) VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING",
        [row.principalId, row.kind, row.displayName, ts(row.createdAt)],
      );
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
  /** The principal a handle is linked to, from the in-memory index. A principal UUID resolves to itself. */
  principalOf(handle: string): string | undefined;
  /** Every handle linked to a principal, as the raw ids older rows were keyed by. */
  handlesOf(principalId: string): string[];
  /** Edge entry point: the handle acted, so it must have a principal. Auto-links by email first. */
  act(handle: string, opts?: ActOptions): Promise<string>;
  /** Point an identity at a principal. The self-serve connect flow and the admin link API both call this. */
  attach(handle: string, principalId: string, linkedBy: string, evidence?: string): Promise<IdentityRow>;
  unlink(handle: string): Promise<IdentityRow | null>;
  /** Replace the email identities `linkedBy` wrote for a principal. Admin and platform only. */
  setEmails(principalId: string, emails: readonly string[], linkedBy: string): Promise<void>;
  /** Rule 2: attach an identity carrying `email` to the single principal that owns that email. */
  autoLink(handle: string, email: string): Promise<string | undefined>;
  identities(principalId?: string): Promise<IdentityRow[]>;
  principals(): Promise<PrincipalRow[]>;
  /** Fold `drop` into `keep`: every reference re-pointed, `drop` deleted. */
  combine(keep: string, drop: string): Promise<void>;
}

const REFRESH_TTL_MS = 10_000;

export function createPrincipalGraph(
  store: PrincipalStore = createMemoryPrincipalStore(),
  opts: { onAutoLink?: (identity: IdentityRow) => void } = {},
): PrincipalGraph {
  const principals = new Map<string, PrincipalRow>();
  const identities = new Map<string, IdentityRow>();
  let refreshedAt = 0;
  let refreshP: Promise<void> | null = null;
  let tail: Promise<unknown> = Promise.resolve();
  const serial = <T>(fn: () => Promise<T>): Promise<T> => {
    const run = tail.then(fn, fn);
    tail = run.catch(() => {});
    return run;
  };

  async function refresh(force = false): Promise<void> {
    if (!force && Date.now() - refreshedAt < REFRESH_TTL_MS) return;
    if (refreshP) return refreshP;
    refreshP = store
      .load()
      .then((data) => {
        principals.clear();
        identities.clear();
        for (const p of data.principals) principals.set(p.principalId, p);
        for (const i of data.identities) identities.set(key(i.provider, i.externalId), i);
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
    identities.set(key(row.provider, row.externalId), row);
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

  function emailOwner(email: string): string | undefined {
    const address = email.trim().toLowerCase();
    if (!address.includes("@")) return undefined;
    const owners = new Set<string>();
    for (const row of identities.values())
      if (row.provider === "email" && row.externalId === address && row.principalId) owners.add(row.principalId);
    return owners.size === 1 ? [...owners][0] : undefined;
  }

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

  return {
    refresh,
    principalOf,
    handlesOf(principalId) {
      return [...identities.values()].filter((r) => r.principalId === principalId).map((r) => r.externalId);
    },
    act(handle, o = {}) {
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
        await store.insertPrincipal(principal);
        principals.set(principal.principalId, principal);
        await write({
          ...blank(handle, email),
          principalId: principal.principalId,
          linkedBy: "self",
          verifiedAt: o.verified ? Date.now() : null,
          updatedAt: Date.now(),
        });
        return principal.principalId;
      });
    },
    attach(handle, principalId, linkedBy, evidence) {
      return serial(async () => {
        await refresh(true);
        const target = principalOf(principalId) ?? principalId;
        if (!principals.has(target)) throw new IdentityLinkError(404, `no principal ${principalId}`);
        const prior = identity(handle);
        const previous = prior?.principalId;
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
        await refresh(true);
        const row = identity(handle);
        if (!row?.principalId) return null;
        return write({ ...row, principalId: null, linkedBy: null, evidence: null, updatedAt: Date.now() });
      });
    },
    setEmails(principalId, emails, linkedBy) {
      return serial(async () => {
        await refresh(true);
        if (!principals.has(principalId)) throw new IdentityLinkError(404, `no principal ${principalId}`);
        const wanted = new Set(emails.map((e) => e.trim().toLowerCase()).filter((e) => e.includes("@")));
        for (const row of [...identities.values()])
          if (
            row.provider === "email" &&
            row.principalId === principalId &&
            row.linkedBy === linkedBy &&
            !wanted.has(row.externalId)
          ) {
            await store.deleteIdentity(row.provider, row.externalId);
            identities.delete(key(row.provider, row.externalId));
          }
        for (const address of wanted) {
          const prior = identities.get(key("email", address));
          if (prior?.principalId && prior.principalId !== principalId) continue;
          if (prior?.principalId === principalId) continue;
          await write({ ...blank(address, address), principalId, linkedBy, updatedAt: Date.now() });
        }
        for (const row of [...identities.values()])
          if (row.provider !== "email" && !row.principalId && row.email && wanted.has(row.email))
            await autoLinkLocked(`${row.externalId}`, row.email);
      });
    },
    autoLink(handle, email) {
      return serial(async () => {
        await refresh();
        return autoLinkLocked(handle, email);
      });
    },
    async identities(principalId) {
      await refresh(true);
      return [...identities.values()].filter((r) => principalId === undefined || r.principalId === principalId);
    },
    async principals() {
      await refresh(true);
      return [...principals.values()];
    },
    combine(keep, drop) {
      return serial(async () => {
        if (keep === drop) throw new IdentityLinkError(400, "a principal cannot be combined with itself");
        await refresh(true);
        if (!principals.has(keep) || !principals.has(drop)) throw new IdentityLinkError(404, "unknown principal");
        await store.combine(keep, drop);
        await refresh(true);
      });
    },
  };
}
