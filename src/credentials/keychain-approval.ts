import { KeychainError, type Keychain, type KeychainAsk, type KeychainGrant } from "./keychain.ts";
import type { App } from "../api/app.ts";
import type { IdentityService } from "../identity/identity-service.ts";
import type { SessionStore } from "../sessions/session-store.ts";
import type { AuditLog } from "../audit/audit-log.ts";
import type { ActorAssertion, Destination } from "../types.ts";
import type { DeliveryStore } from "../delivery/delivery-store.ts";
import { principalDestination } from "../reach/reach.ts";
import { samePerson } from "../directory/person.ts";
import { swallow } from "../util/errors.ts";

export interface KeychainApprovalView {
  ask: KeychainAsk;
  service: string;
  accountLabel?: string;
  conversation: string;
  sessionId?: string;
  requesterSessionId?: string;
  seq?: number;
  slack?: { channel: string; ts: string };
  mode?: "once" | "standing";
}

export interface KeychainApprovals {
  get(id: string, ownerId: string): Promise<KeychainApprovalView | null>;
  card(id: string): Promise<KeychainApprovalView | null>;
  decide(id: string, actor: ActorAssertion, decision: "once" | "standing" | "deny"): Promise<KeychainApprovalView>;
}

// The card goes where the request came from: its Slack thread or channel, a cron's destination in
// that same conversation, or inline in the owner's own web session (no delivery). Anything else,
// including a destination outside the requesting conversation, falls back to the owner's DM.
export function approvalCardDestination(ask: KeychainAsk): Destination | null {
  const d = ask.requesterDestination;
  const own = samePerson(ask.ownerId, ask.requesterId);
  if (d?.type === "web" && own) return null;
  if (
    d?.type === "principal"
      ? samePerson(d.target, ask.ownerId)
      : d && d.type !== "web" && d.audienceScopeId === ask.requesterScopeId
  )
    return { ...d!, keychainAskId: ask.id };
  return { ...principalDestination(ask.ownerId, ask.requesterId), keychainAskId: ask.id };
}

export function createKeychainApprovals(deps: {
  keychain: Keychain;
  app: Pick<App, "belongsToScope" | "listContexts">;
  identity: IdentityService;
  sessions: SessionStore;
  audit?: AuditLog;
  deliveries?: Pick<DeliveryStore, "enqueue">;
  resume(ask: KeychainAsk, grant?: KeychainGrant): Promise<unknown>;
}): KeychainApprovals {
  const { keychain, app, identity, sessions } = deps;
  async function get(id: string, ownerId: string): Promise<KeychainApprovalView | null> {
    const ask = await keychain.getAsk(id);
    if (!ask || !samePerson(ask.ownerId, ownerId)) return null;
    const credential = await keychain.getCredential(ask.credentialId);
    if (!credential) return null;
    const context = (await app.listContexts(ownerId)).find((c) => c.scopeId === ask.requesterScopeId);
    let session = ask.requesterThreadRef ? await sessions.getByThread(ask.requesterThreadRef) : null;
    const requester = session && (await sessions.getForParticipant(session.id, ownerId));
    const seen = new Set<string>();
    while (session?.parentSessionId && !seen.has(session.id)) {
      seen.add(session.id);
      const parent = await sessions.getForParticipant(session.parentSessionId, ownerId);
      if (!parent || parent.scopeId !== ask.requesterScopeId) break;
      session = parent;
    }
    const visible = session && (await sessions.getForParticipant(session.id, ownerId));
    const slack =
      session && (await app.belongsToScope(ownerId, ask.requesterScopeId))
        ? /^(?:ch|grp|dm):([^:]+)(?::(\d+\.\d+))?$/.exec(session.threadRef)
        : null;
    const slackTs =
      (session?.threadRef === ask.requesterThreadRef ? ask.requesterMessageTs : undefined) ??
      slack?.[2] ??
      ask.requesterDestination?.threadTs;
    const grant = ask.grantId ? await keychain.getGrant(ask.grantId) : null;
    return {
      ask,
      service: credential.service,
      ...(credential.accountLabel ? { accountLabel: credential.accountLabel } : {}),
      conversation: visible?.title || context?.name || "the requesting conversation",
      ...(visible ? { sessionId: visible.id } : {}),
      ...(requester ? { requesterSessionId: requester.id } : {}),
      ...(ask.requesterSeq !== undefined && visible?.threadRef === ask.requesterThreadRef
        ? { seq: ask.requesterSeq }
        : {}),
      ...(slack && slackTs ? { slack: { channel: slack[1]!, ts: slackTs } } : {}),
      ...(grant ? { mode: grant.mode } : {}),
    };
  }
  return {
    get,
    async card(id) {
      const ask = await keychain.getAsk(id);
      return ask ? get(id, ask.ownerId) : null;
    },
    async decide(id, assertion, decision) {
      await identity.refresh(true);
      const actor = identity.resolve(assertion);
      const current = await get(id, actor.id);
      if (!identity.isInternal(actor) || !current)
        throw new KeychainError(403, "Only the credential owner can decide this request.");
      const { ask } = current;
      if (ask.status !== "pending") return current;
      if (
        !(await app.belongsToScope(actor.id, ask.requesterScopeId)) ||
        !(await app.belongsToScope(ask.requesterId, ask.requesterScopeId))
      ) {
        throw new KeychainError(403, "The owner and requester must still have access to the requesting conversation.");
      }
      let resolved: KeychainAsk;
      let grant: KeychainGrant | undefined;
      try {
        if (decision === "deny") resolved = await keychain.declineAsk({ askId: id, ownerId: actor.id, note: "Denied" });
        else
          ({ ask: resolved, grant } = await keychain.approveAsk({
            askId: id,
            ownerId: actor.id,
            mode: decision,
            purpose: ask.purpose,
          }));
      } catch (error) {
        if (!(error instanceof KeychainError) || error.status !== 410) throw error;
        const latest = await get(id, actor.id);
        if (!latest || latest.ask.status === "pending") throw error;
        return latest;
      }
      deps.audit?.record({
        at: Date.now(),
        principalId: actor.id,
        action: decision === "deny" ? "keychain.ask.decline" : `keychain.grant.${decision}`,
        resource: `${id} (${ask.credentialId}→${ask.requesterScopeId})`,
        scopeLabel: ask.requesterScopeId,
      });
      const destination = approvalCardDestination(resolved);
      if (destination)
        await deps.deliveries
          ?.enqueue({ destination, text: "Credential request resolved.", idempotencyKey: `ask:${id}:resolved` })
          .catch((error) => swallow("keychain: sync approval card", error));
      void deps
        .resume(resolved, grant)
        .then(() => keychain.markAskNotified(id, resolved.status))
        .catch((error) => swallow("keychain: native approval resume (sweep will retry)", error));
      return { ...current, ask: resolved, ...(grant ? { mode: grant.mode } : {}) };
    },
  };
}
