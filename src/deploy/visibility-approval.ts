export type VisibilityWidening = "public" | "org";

export const VISIBILITY_APPROVAL_REQUIRED =
  "making an app public or visible to the whole organization needs the owner's approval; use the apps tool so an approval card is posted";

export function visibilityApprovalCommand(app: string, widening: VisibilityWidening): string {
  return widening === "public" ? `apps share ${app} public:true` : `apps share ${app} toScope:org`;
}

export function visibilityApprovalKey(app: string, widening: VisibilityWidening): string {
  return `app-visibility:${JSON.stringify([app, widening])}`;
}

export function visibilityApprovalReason(app: string, widening: VisibilityWidening): string {
  return widening === "public"
    ? `make app "${app}" public: anyone with the link can open it without signing in`
    : `share app "${app}" with everyone in the organization`;
}

export function agentTurnCapability(claims: { sessionId?: string } | undefined): boolean {
  return typeof claims?.sessionId === "string";
}
