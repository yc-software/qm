import { mintSignedPayload } from "../auth/signed-token.ts";
import type { FinalizeFinnyInput, FinnyReceiptSigner, FinnyStore } from "./store.ts";
import type { FinnyFinalReceipt } from "./types.ts";

export interface FinnyFinalizer {
  finalize(input: FinalizeFinnyInput): Promise<FinnyFinalReceipt>;
}

export function createFinnyFinalizer(store: FinnyStore, sign: FinnyReceiptSigner): FinnyFinalizer {
  return { finalize: (input) => store.finalize(input, sign) };
}

export function createSignedFinnyFinalizer(store: FinnyStore, secret: string): FinnyFinalizer {
  return createFinnyFinalizer(store, (payload) => mintSignedPayload(payload, secret));
}
