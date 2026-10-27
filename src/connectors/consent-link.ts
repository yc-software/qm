import { createOneTimeStore, type OneTimeResult } from "../persistence/one-time-store.ts";
import { createPgPool } from "../persistence/pg-pool.ts";
import { cols, retireJsonKeysMigration, mapToTableMigration, typedTable } from "../persistence/typed-table.ts";
import type { AccountType } from "./oauth.ts";

interface ConsentLinkRecord {
  principalId: string;
  orgId?: string;
  provider: string;
  accountType: AccountType;
  redirectUri: string;
  returnTo?: string;
  createdAt: number;
}

export interface ConsentLinkStore {
  mint(rec: Omit<ConsentLinkRecord, "createdAt">, now?: number): Promise<{ linkId: string }>;
  peek(linkId: string, now?: number): Promise<OneTimeResult<ConsentLinkRecord>>;
  redeem(linkId: string, now?: number): Promise<OneTimeResult<ConsentLinkRecord>>;
}

const CONSENT_LINK_TTL_MS = 24 * 60 * 60_000;

const CONSENT_LINKS_MIGRATION = mapToTableMigration("connectors/consent-links/0001-typed", {
  table: "consent_links",
  key: "id",
  columns: cols(`principalId text!, orgId text, provider text!, accountType text!, redirectUri text!,
    returnTo text, createdAt bigint!`),
});

export function createConsentLinkStore(
  databaseUrl: string,
  opts: { ttlMs?: number; now?: () => number } = {},
): ConsentLinkStore {
  const table = typedTable<ConsentLinkRecord>(
    createPgPool(databaseUrl, [
      retireJsonKeysMigration("connectors/consent-links/0000-drop-channel-scope-id", "consent_links", {
        drop: ["channelScopeId"],
      }),
      CONSENT_LINKS_MIGRATION,
    ]),
    CONSENT_LINKS_MIGRATION.spec,
  );
  const links = createOneTimeStore(table, opts.ttlMs ?? CONSENT_LINK_TTL_MS, opts.now);
  return { ...links, mint: async (rec, now) => ({ linkId: await links.mint(rec, now) }) };
}
