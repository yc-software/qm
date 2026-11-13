import type { CoreSession } from "./core-bridge";
import { hasWelcomeScreen, type Me } from "./shell-state.ts";

let onboardThread: string | null = null;

export function showWelcomeIn(threadRef: string): void {
  onboardThread = threadRef;
}

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

export function welcomeLayout(view: {
  me: Me | null;
  sessions: readonly CoreSession[];
  threadRef: string | null;
  scopeId: string | null;
  isNewUser: boolean;
  empty: boolean;
  draft: boolean;
}): { show: boolean; hideSuggestions: boolean; hideComposer: boolean } {
  const { me, threadRef, empty } = view;
  const show =
    (threadRef !== null && threadRef === onboardThread) ||
    (me && hasWelcomeScreen(me)
      ? isWelcomeConversation(view.sessions, me.user, threadRef, view.scopeId)
      : view.isNewUser && empty);
  const seeded = show && Boolean(me?.welcome);
  return {
    show,
    hideSuggestions: (view.isNewUser && hasWelcomeScreen(me)) || seeded,
    hideComposer: seeded && empty && !view.draft,
  };
}
