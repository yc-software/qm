import { createTurnLedger, type TurnLedger } from "../../src/turns/turn-ledger.ts";

/**
 * A turn ledger whose database sessions see Absurd's clock (`absurd.current_time()`) frozen at `at`,
 * so a test can claim as if a retry delay had passed without waiting for it.
 */
export function turnLedgerAt(databaseUrl: string, at: number): TurnLedger {
  const url = new URL(databaseUrl);
  url.searchParams.set("options", `-c absurd.fake_now=${new Date(at).toISOString()}`);
  return createTurnLedger(url.toString());
}
