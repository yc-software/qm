import type { DeliveryProvenance, Destination, ScopeId } from "../../types.ts";
import { parseScopeId, scopeId } from "../../types.ts";
import type { DeliveryStore } from "../../delivery/delivery-store.ts";
import type { DurableMap } from "../../persistence/durable-map.ts";
import { principalDestination, reachEnqueue } from "../../reach/reach.ts";
import { samePerson } from "../../directory/person.ts";
import { reportFailure } from "../../util/errors.ts";
import { claimThenBind } from "../../tenants/claim.ts";
import { DEFAULT_CRON_TIMEZONE, nextCalendarFireAfter } from "../schedule.ts";
import { createFireHandler, type FireReport, type HandlerState } from "./fire-handler.ts";

const HANDLER_WAKE_INTERVAL_MS = 10 * 60_000;
const DIGEST_CRON = "0 9,17 * * *";

export interface HandlerInbox {
  owner: string;
  ownerScopeId: ScopeId;
  destination: Destination;
  pending: FireReport[];
  state: HandlerState;
  lastWakeAt: number;
  lastDigestAt: number;
}

export interface HandlerInboxDeps {
  inboxes: DurableMap<HandlerInbox>;
  deliveries: DeliveryStore;
  ask: (owner: string, ownerScopeId: ScopeId, threadRef: string, prompt: string, key: string) => Promise<string>;
  timezone?: (principalId: string) => Promise<string | undefined>;
}

function handlerThreadRef(principalId: string): string {
  return `handler:${principalId}`;
}

export function ownerHandledDestination(
  owner: string,
  ownerScopeId: ScopeId,
  destination: Destination | undefined,
): Destination | null {
  const home = parseScopeId(ownerScopeId);
  const personal = scopeId("personal", owner);
  if (!destination)
    return home.kind === "personal" && samePerson(home.ref, owner) ? principalDestination(owner, owner) : null;
  if (destination.type === "principal" && samePerson(destination.target, owner)) return destination;
  if (destination.type === "web" && destination.audienceScopeId === personal) return destination;
  return null;
}

export function createHandlerInboxes(deps: HandlerInboxDeps) {
  const provenance = (inbox: HandlerInbox, key: string): DeliveryProvenance => ({
    trigger: "cron",
    surface: "cron",
    fireKey: key,
    sourceScopeId: inbox.ownerScopeId,
    sourceThreadRef: handlerThreadRef(inbox.owner),
    sourceTitle: "Scheduled task reports",
  });

  const send = async (inbox: HandlerInbox, text: string, key: string): Promise<void> => {
    await reachEnqueue({
      deliveries: deps.deliveries,
      destination: inbox.destination,
      text,
      idempotencyKey: key,
      provenance: provenance(inbox, key),
    });
  };

  const digestDue = async (inbox: HandlerInbox, now: number): Promise<boolean> => {
    const timezone = (await deps.timezone?.(inbox.owner).catch(() => undefined)) ?? DEFAULT_CRON_TIMEZONE;
    const next = nextCalendarFireAfter({ cron: DIGEST_CRON, timezone }, inbox.lastDigestAt);
    return next !== undefined && next <= now;
  };

  return {
    async accept(input: { owner: string; ownerScopeId: ScopeId; destination: Destination; report: FireReport }) {
      const fresh: HandlerInbox = {
        owner: input.owner,
        ownerScopeId: scopeId("personal", input.owner),
        destination: input.destination,
        pending: [],
        state: { digest: [] },
        lastWakeAt: 0,
        lastDigestAt: input.report.at,
      };
      await deps.inboxes.mutateMany([
        {
          id: input.owner,
          apply: (current) => {
            const base = current ?? fresh;
            return { ...base, destination: input.destination, pending: [...base.pending, input.report] };
          },
        },
      ]);
    },

    async sweep(now: number): Promise<void> {
      await claimThenBind(deps.inboxes.claimTenants, () => this.sweepTenant(now));
    },

    async sweepTenant(now: number): Promise<void> {
      for (const [id, inbox] of await deps.inboxes.entries()) {
        const wake =
          inbox.pending.length > 0 &&
          (inbox.pending.some((r) => r.urgent) || now - inbox.lastWakeAt >= HANDLER_WAKE_INTERVAL_MS);
        const flush = inbox.state.digest.length > 0 && (await digestDue(inbox, now));
        if (!wake && !flush) continue;
        try {
          await this.wake(id, now, wake, flush);
        } catch (e) {
          reportFailure(`cron handler: wake for ${id}`, e);
        }
      }
    },

    async wake(id: string, now: number, wake: boolean, flush: boolean): Promise<void> {
      const inbox = await deps.inboxes.get(id);
      if (!inbox) return;
      const taken = wake ? inbox.pending : [];
      let calls = 0;
      const handler = createFireHandler({
        state: structuredClone(inbox.state),
        model: (prompt) =>
          deps.ask(
            inbox.owner,
            inbox.ownerScopeId,
            handlerThreadRef(inbox.owner),
            prompt,
            `handler:${id}:${now}:${calls++}`,
          ),
      });
      const decision = await handler.handle(taken, now);
      for (const [i, text] of decision.sendNow.entries()) await send(inbox, text, `handler:${id}:${now}:now:${i}`);
      const digest = flush ? await handler.flushDigest(now) : null;
      if (digest) await send(inbox, digest, `handler:${id}:${now}:digest`);
      await deps.inboxes.update(id, (v) => ({
        ...v,
        pending: v.pending.slice(taken.length),
        state: handler.state,
        ...(wake ? { lastWakeAt: now } : {}),
        ...(flush ? { lastDigestAt: now } : {}),
      }));
    },
  };
}

export type HandlerInboxes = ReturnType<typeof createHandlerInboxes>;
