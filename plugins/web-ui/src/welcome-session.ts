import type { CoreSession } from "./core-bridge";
import type { Me } from "./shell-state.ts";

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
  saved: boolean;
  empty: boolean;
  draft: boolean;
}): { show: boolean; hideSuggestions: boolean; hideComposer: boolean } {
  const { me, threadRef, empty } = view;
  if (!me) return { show: false, hideSuggestions: false, hideComposer: false };
  const requested = Boolean(threadRef?.startsWith(`web:${me.user}:welcome:`));
  const first =
    (!view.saved || Boolean(me.welcomeCohort)) &&
    isWelcomeConversation(view.sessions, me.user, threadRef, view.scopeId);
  const show = (requested || first) && (empty || Boolean(me.welcomeCohort));
  return { show, hideSuggestions: show, hideComposer: show && empty && Boolean(me.welcome) && !view.draft };
}
