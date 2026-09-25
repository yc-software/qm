import type { CoreSession } from "./core-bridge";

export function isWelcomeConversation(
  sessions: readonly CoreSession[],
  user: string,
  threadRef: string | null,
  scopeId: string | null,
): boolean {
  if (threadRef?.startsWith(`web:${user}:ideas:`)) return false;
  if (!threadRef?.startsWith(`web:${user}:`) || (scopeId && scopeId !== `personal:${user}`)) return false;
  const personal = sessions.filter(
    (session) =>
      session.scopeId === `personal:${user}` &&
      session.threadRef.startsWith(`web:${user}:`) &&
      !session.threadRef.startsWith(`web:${user}:ideas:`),
  );
  const first = personal.reduce<CoreSession | undefined>(
    (oldest, session) =>
      !oldest ||
      session.createdAt < oldest.createdAt ||
      (session.createdAt === oldest.createdAt && session.threadRef < oldest.threadRef)
        ? session
        : oldest,
    undefined,
  );
  return !first || first.threadRef === threadRef;
}
