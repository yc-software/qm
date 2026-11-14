import type { CoreSession } from "./core-bridge";
import { hasWelcomeScreen, type Me } from "./shell-state.ts";

export const welcomeThreadRef = (user: string): string => `web:${user}:welcome:${crypto.randomUUID()}`;

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
  const first = Boolean(me && isWelcomeConversation(view.sessions, me.user, threadRef, view.scopeId));
  const seeded = Boolean(me?.welcome) && empty && (first || Boolean(threadRef?.startsWith(`web:${me?.user}:welcome:`)));
  const standard = me && hasWelcomeScreen(me) ? first : view.isNewUser && empty;
  const show = me?.welcome ? seeded : standard;
  return {
    show,
    hideSuggestions: (view.isNewUser && hasWelcomeScreen(me)) || seeded,
    hideComposer: seeded && !view.draft,
  };
}
