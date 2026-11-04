import { createPgPool, setOwnerDatabase, type PgPool } from "../persistence/pg-pool.ts";

let ownerUrl: string | undefined;
let ownerPool: PgPool | undefined;

export function useOwnerDatabase(url: string | undefined): void {
  const next = url || undefined;
  if (next === ownerUrl) return;
  void ownerPool?.close();
  ownerUrl = next;
  ownerPool = undefined;
  setOwnerDatabase(next);
}

export function ownerPgPool(pg: PgPool): PgPool {
  if (!ownerUrl) return pg;
  ownerPool ??= createPgPool(ownerUrl);
  return ownerPool;
}
