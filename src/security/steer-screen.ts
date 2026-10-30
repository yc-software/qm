import type { Conversation, Principal } from "../types.ts";
import type { ResolutionService } from "../resolution/resolution-service.ts";
import type { RateLimiter } from "../ratelimit/rate-limiter.ts";
import type { SessionStore } from "../sessions/session-store.ts";
import { createSecurityClassifier, type SecurityClassifierDeps } from "./security-classifier.ts";
import { securityScreenPayload, UNSCREENED_REASON } from "./security-posture.ts";

export type SteerScreenDecision = "allow" | "block" | "unscreened";

export type SteerScreen = (input: {
  payload: string;
  actor: Principal;
  conversation: Conversation;
  sessionId?: string;
  verifiedSwarm?: boolean;
}) => Promise<SteerScreenDecision>;

export function createSteerScreen(
  deps: SecurityClassifierDeps & {
    resolution: ResolutionService;
    rateLimiter: RateLimiter;
    sessions: Pick<SessionStore, "recordLlmRequest">;
  },
): SteerScreen {
  const classifySecurityData = createSecurityClassifier(deps);
  const securitySteersInFlight = new Set<string>();
  return async function screenSecuritySteer({ payload, actor, conversation, sessionId, verifiedSwarm }) {
    const resolution = await deps.resolution.resolve(conversation, actor);
    const { screening } = resolution.securityPolicy;
    if (screening === "off") return "allow";
    const scopeLabel = deps.resolution.scopeFor(conversation, actor);
    const bounded = securityScreenPayload({
      surface: "external",
      text: "",
      triggered: true,
      securityScreenData: payload,
      ...(verifiedSwarm ? { verifiedSwarm } : {}),
    });
    const steerContext = {
      hook: "user_input",
      surface: "steer",
      origin: verifiedSwarm ? "automation" : "ambient",
      thread: conversation.threadRef,
      ...(sessionId ? { sessionId } : {}),
    } as const;
    if (screening === "observe") {
      if (bounded && !bounded.truncated)
        await classifySecurityData(bounded.content, actor.id, scopeLabel, undefined, {
          ...steerContext,
          mode: "observe",
        });
      return "allow";
    }
    const block = (cause: string, reason?: string): "block" => {
      deps.auditLog.record({
        at: Date.now(),
        principalId: actor.id,
        action: "security_posture.steer_block",
        resource: conversation.threadRef,
        scopeLabel,
        status: "strict",
        detail: JSON.stringify({ cause, ...(reason ? { reason } : {}) }),
      });
      return "block";
    };
    if (!deps.securityScreener && !deps.agent.screenSecurity) return block("no-screener");
    if (!(await deps.rateLimiter.check(actor.id)).allowed) return block("rate-limited");
    if (deps.budget && !(await deps.budget.check(actor.id)).allowed) return block("over-budget");
    if (securitySteersInFlight.has(conversation.threadRef)) return block("steer-in-flight");
    if (!bounded || bounded.truncated) return block("oversize-input");
    securitySteersInFlight.add(conversation.threadRef);
    const verdict = await classifySecurityData(
      bounded.content,
      actor.id,
      scopeLabel,
      sessionId
        ? async (rec, signal) => {
            await deps.sessions.recordLlmRequest(sessionId, { ...rec, scopeLabel }, signal);
          }
        : undefined,
      { ...steerContext, mode: "enforce" },
    ).finally(() => securitySteersInFlight.delete(conversation.threadRef));
    if (verdict?.decision === "auto") {
      if (!verdict.unscreened) return "allow";
      deps.auditLog.record({
        at: Date.now(),
        principalId: actor.id,
        action: "security_posture.steer_failed_open",
        resource: conversation.threadRef,
        scopeLabel,
        status: "allowed",
        detail: JSON.stringify({ cause: UNSCREENED_REASON }),
      });
      return "unscreened";
    }
    return block("strict-verdict", verdict?.reason);
  };
}
