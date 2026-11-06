import type { IdentityService } from "../identity/identity-service.ts";
import type { FinnyApprovalBridge } from "../slack/finny-approvals.ts";
import type { FinnyStore } from "./store.ts";

const PLAN_OUTCOMES = {
  approve: { decision: "approved", detail: "Execution started." },
  reject: { decision: "rejected", detail: "The plan will not run." },
  request_change: { decision: "request_change", detail: "The plan must be revised before execution." },
} as const;

export interface FinnyApprovedPlan {
  scopeId: string;
  jobId: string;
  requestId: string;
}

export function createFinnyApprovalService(deps: {
  store: FinnyStore;
  identity: Pick<IdentityService, "resolve" | "isInternal">;
  onApproved(input: FinnyApprovedPlan): Promise<void>;
}): FinnyApprovalBridge {
  return {
    async pending(requestId) {
      const request = await deps.store.getApprovalRequest(requestId);
      if (!request) {
        const clarification = await deps.store.getClarificationRequest(requestId);
        if (!clarification || clarification.decidedAt !== undefined) return null;
        return {
          kind: "clarification",
          requestId,
          card: {
            question: clarification.question,
            options: clarification.options,
            recommendedOptionId: clarification.recommendedOptionId,
          },
        };
      }
      if (request.decidedAt !== undefined || request.job.approval !== undefined) return null;
      if (request.planDigest !== request.job.planDigest || request.originThreadRef !== request.job.originThreadRef)
        throw new Error("Finny approval request binding does not match the job");
      const { title, summary, phases, certification, deliverable, destination } = request.job.plan;
      return {
        kind: "plan",
        requestId,
        card: {
          title,
          ...(summary !== undefined ? { summary } : {}),
          phases,
          certification,
          deliverable,
          destination,
        },
      };
    },
    async decide(input) {
      const request = await deps.store.getApprovalRequest(input.requestId);
      if (!request) {
        const clarification = await deps.store.getClarificationRequest(input.requestId);
        if (!clarification || clarification.decidedAt !== undefined) return { kind: "gone" };
        if (input.decision.kind !== "clarification") throw new Error("Finny decision does not match the request");
        const actor = deps.identity.resolve(input.actor);
        if (!deps.identity.isInternal(actor) || actor.id !== clarification.authorizedActorId)
          throw new Error("Finny clarification actor is not authorized");
        const actualThreadRef = `slack:${input.slack.channel}:${input.slack.threadTs ?? input.slack.messageTs}`;
        const decision =
          input.decision.action === "select"
            ? { kind: "option" as const, optionId: input.decision.optionId }
            : { kind: "other" as const };
        const decided = await deps.store.recordClarificationDecision({
          requestId: clarification.requestId,
          actorId: actor.id,
          originThreadRef: actualThreadRef,
          decision,
          decidedAt: Date.now(),
        });
        const decidedChoice = decided.decision;
        const summary =
          decidedChoice?.kind === "option"
            ? decided.options.find((option) => option.id === decidedChoice.optionId)?.label
            : "Other selected; follow-up required.";
        if (!summary) throw new Error("Finny clarification option is not available");
        return { kind: "result", card: { title: "Clarification recorded", status: "passed", summary } };
      }
      if (request.decidedAt !== undefined || request.job.approval !== undefined) return { kind: "gone" };
      if (input.decision.kind !== "plan") throw new Error("Finny decision does not match the request");
      const actor = deps.identity.resolve(input.actor);
      if (!deps.identity.isInternal(actor) || actor.id !== request.authorizedActorId)
        throw new Error("Finny approval actor is not authorized");
      const actualThreadRef = `slack:${input.slack.channel}:${input.slack.threadTs ?? input.slack.messageTs}`;
      if (actualThreadRef !== request.originThreadRef)
        throw new Error("Finny approval must be decided in its origin thread");
      await deps.store.recordApproval({
        scopeId: request.scopeId,
        jobId: request.jobId,
        requestId: request.requestId,
        actorId: actor.id,
        action: input.decision.action,
        originThreadRef: actualThreadRef,
        decidedAt: Date.now(),
      });
      if (input.decision.action === "approve")
        await deps.onApproved({ scopeId: request.scopeId, jobId: request.jobId, requestId: request.requestId });
      const outcome = PLAN_OUTCOMES[input.decision.action];
      return { kind: "decision", card: { title: request.job.plan.title, ...outcome } };
    },
  };
}
