import { AsyncLocalStorage } from "node:async_hooks";
import type { SessionOrigin } from "../sessions/session-store.ts";

export interface ModelRequestContext {
  sessionId?: string;
  actorId?: string;
  scopeId?: string;
  origin?: SessionOrigin;
}

const current = new AsyncLocalStorage<ModelRequestContext>();

export function withModelRequestContext<T>(
  { sessionId, actorId, scopeId, origin }: ModelRequestContext,
  work: () => T,
): T {
  return current.run({ sessionId, actorId, scopeId, origin }, work);
}

export function currentModelRequestContext(): ModelRequestContext {
  return current.getStore() ?? {};
}
