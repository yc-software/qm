import type { Keychain, KeychainAsk, KeychainGrant } from "../credentials/keychain.ts";
import type { AuditLog } from "../audit/audit-log.ts";
import type { Destination, ScopeId } from "../types.ts";
import { runTrigger, destinationVisible, type TriggerDeps, type TriggerOutcome } from "./run-trigger.ts";
import { swallow } from "../util/errors.ts";
import { keychainUseCommand } from "../api/contract.ts";

function resolutionInput(ask: KeychainAsk, grant?: KeychainGrant): string {
  if (ask.status === "approved") {
    const once = grant?.mode !== "standing";
    return (
      `Keychain ask \`${ask.id}\` was approved by its owner (${ask.ownerId}): ${once ? "one-time" : "standing"} ` +
      `grant \`${ask.grantId}\` for this conversation (the owner's consent, verbatim: "${grant?.purpose ?? ask.purpose}" — act within it; ` +
      `originally asked for: "${ask.purpose}"). Tell the requester and resume ` +
      `the task it was for — load the credential with ` +
      `\`${keychainUseCommand({ grant: String(ask.grantId) })}\` ` +
      `and run the task in that same shell${once ? " (the grant is single-use)" : ""}.`
    );
  }
  if (ask.status === "declined") {
    return (
      `Keychain ask \`${ask.id}\` (purpose: "${ask.purpose}") was declined by its owner (${ask.ownerId})` +
      `${ask.note ? ` — "${ask.note}"` : ""}. Tell the requester, and offer the alternatives: they can run the ` +
      `service's own login here themselves, or register their own credential in their DM with me.`
    );
  }
  return (
    `Keychain ask \`${ask.id}\` to ${ask.ownerId} (purpose: "${ask.purpose}") expired without an answer. ` +
    `Tell the requester, and offer the alternatives: re-send the ask, run the service's own login here ` +
    `themselves, or register their own credential in their DM with me.`
  );
}

export interface AskResolutionDeps extends TriggerDeps {
  getAsk?: (id: string) => Promise<KeychainAsk | null>;
  getGrant?: (id: string) => Promise<KeychainGrant | null>;
}

function fallbackText(ask: KeychainAsk): string {
  let what = "expired without an answer";
  if (ask.status === "approved") what = "was approved — the grant is active for this conversation";
  else if (ask.status === "declined") what = `was declined${ask.note ? ` ("${ask.note}")` : ""}`;
  return `Keychain ask \`${ask.id}\` (purpose: "${ask.purpose}") ${what}, but I couldn't resume the task automatically. Mention me here to pick it up.`;
}

export async function fireAskResolution(
  deps: AskResolutionDeps,
  ask: KeychainAsk,
  grant?: KeychainGrant,
): Promise<TriggerOutcome> {
  if (!grant && ask.status === "approved" && ask.grantId) {
    grant = (await deps.getGrant?.(ask.grantId)) ?? undefined;
  }
  const outcome = await runTrigger(deps, {
    owner: ask.requesterId,
    ownerScopeId: ask.requesterScopeId,
    input: resolutionInput(ask, grant),
    fireKey: `ask:${ask.id}:${ask.status}`,
    surface: "keychain-ask",
    ...(ask.requesterDestination ? { destination: ask.requesterDestination } : {}),
    ...(ask.requesterThreadRef ? { threadRef: ask.requesterThreadRef } : {}),
  });
  if (outcome.ran && outcome.status === "ok") return outcome;
  if (!outcome.ran && !outcome.authzFailed) {
    const cur = await deps.getAsk?.(ask.id);
    if (cur?.notifiedAt !== undefined) return outcome;
  }
  if (ask.requesterDestination && (await destinationVisible(deps, ask.requesterId, ask.requesterDestination))) {
    await deps.deliveries.enqueue({
      destination: ask.requesterDestination,
      text: fallbackText(ask),
      idempotencyKey: `ask:${ask.id}:${ask.status}:fallback`,
    });
  }
  return outcome;
}

export interface DropResolution {
  id: string;
  ownerId: string;
  service: string;
  purpose: string;
  audienceScopeId: ScopeId;
  destination?: Destination;
  threadRef?: string;
  grantId?: string;
  granted: boolean;
  pendingSiblings?: string[];
}

function dropResolutionInput(drop: DropResolution): string {
  const waiting = !!drop.pendingSiblings?.length;
  const where = drop.granted
    ? `now in the keychain and granted to this conversation — load it with \`${keychainUseCommand({ grant: String(drop.grantId) })}\`${waiting ? " when the task runs" : " and run the task in that same shell"}`
    : `now in your keychain and available here`;
  const next = waiting
    ? `Heads-up: other drop links from this conversation (${drop.pendingSiblings!.map((s) => `\`${s}\``).join(", ")}) haven't been filled yet — ` +
      `if the task still needs them, acknowledge and keep waiting; don't run it on partial credentials.`
    : `Pick the task back up.`;
  return (
    `Your \`${drop.service}\` credential was just supplied securely via a secret-drop link (for: "${drop.purpose}"). ` +
    `It is ${where}. ${next}`
  );
}

function dropFallbackText(drop: DropResolution): string {
  return (
    `Your \`${drop.service}\` credential was saved to the keychain${drop.granted ? " and granted to this conversation" : ""}, ` +
    `but I couldn't resume the task automatically. Mention me here to pick it up.`
  );
}

export async function fireDropResolution(deps: TriggerDeps, drop: DropResolution): Promise<TriggerOutcome> {
  const outcome = await runTrigger(deps, {
    owner: drop.ownerId,
    ownerScopeId: drop.audienceScopeId,
    input: dropResolutionInput(drop),
    fireKey: `drop:${drop.id}`,
    surface: "secret-drop",
    ...(drop.destination ? { destination: drop.destination } : {}),
    ...(drop.threadRef ? { threadRef: drop.threadRef } : {}),
  });
  if (outcome.ran && outcome.status === "ok") return outcome;
  if (drop.destination && (await destinationVisible(deps, drop.ownerId, drop.destination))) {
    await deps.deliveries.enqueue({
      destination: drop.destination,
      text: dropFallbackText(drop),
      idempotencyKey: `drop:${drop.id}:fallback`,
    });
  }
  return outcome;
}

export function createAskExpirySweep(deps: {
  keychain: Keychain;
  fire: (ask: KeychainAsk) => Promise<unknown>;
  auditLog?: AuditLog;
}): (now: number) => Promise<void> {
  return async (now) => {
    for (const ask of await deps.keychain.unnotifiedResolvedAsks(now)) {
      if (ask.status === "expired") {
        deps.auditLog?.record({
          at: now,
          principalId: ask.ownerId,
          action: "keychain.ask.expire",
          resource: ask.id,
          scopeLabel: ask.requesterScopeId,
        });
      }
      try {
        await deps.fire(ask);
        await deps.keychain.markAskNotified(ask.id);
      } catch (e) {
        swallow(`keychain: ask sweep fire failed for ${ask.id} (will retry next tick)`, e);
      }
    }
  };
}
