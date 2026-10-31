import { createTurnLedger, type TurnLedger } from "../../src/turns/turn-ledger.ts";

export function turnLedgerAt(databaseUrl: string, at: number): TurnLedger {
  const url = new URL(databaseUrl);
  url.searchParams.set("options", `-c absurd.fake_now=${new Date(at).toISOString()}`);
  return createTurnLedger(url.toString());
}
