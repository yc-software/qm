import type { Session } from "../types.ts";

export const INCOGNITO_WRITE_REFUSAL = "This is an incognito conversation, so nothing can be saved to your qm.";

export const INCOGNITO_CONFLICT_REASON =
  "this conversation's incognito setting is fixed when it starts; start a new conversation to change it";

export function incognitoConflicts(stored: Pick<Session, "incognito"> | null, requested: boolean | undefined): boolean {
  return stored !== null && requested !== undefined && (stored.incognito === true) !== requested;
}
