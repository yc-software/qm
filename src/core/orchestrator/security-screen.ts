import { randomUUID } from "node:crypto";
import type { ScopeId } from "../../types.ts";
import type { TurnOrigin } from "../turn-origin.ts";
import { runShadowScreen, type SecurityScreenHook } from "../../security/security-screener.ts";
import { UNSCREENED_REASON, type SecurityScreenVerdict } from "../../security/security-posture.ts";
import { estimateCostUsd } from "../../ratelimit/budget.ts";
import type { HarnessLlmRequestRecord } from "../../harness/harness.ts";
import { swallowAs } from "../../util/errors.ts";
import { sleep } from "../../util/async.ts";
import type { OrchestratorDeps } from "./types.ts";

const DEFAULT_SECURITY_SCREEN_TIMEOUT_MS = 15_000;

const unscreenedVerdict = (): SecurityScreenVerdict => ({
  decision: "auto",
  unscreened: true,
  reason: UNSCREENED_REASON,
});

export type SecurityClassifier = (
  payload: string,
  actorId: string,
  scopeLabel: ScopeId,
  recordLlmRequest?: (rec: HarnessLlmRequestRecord, signal?: AbortSignal) => void | Promise<void>,
  context?: {
    hook?: SecurityScreenHook;
    surface?: string;
    origin?: TurnOrigin["kind"];
    requestId?: string;
  },
) => Promise<SecurityScreenVerdict | undefined>;

export function createSecurityClassifier(deps: OrchestratorDeps): SecurityClassifier {
  return async function classifySecurityData(payload, actorId, scopeLabel, recordLlmRequest, context = {}) {
    if (!deps.securityScreener && !deps.harness.models.screenSecurity) return undefined;
    const timeoutMs = deps.securityScreenTimeoutMs ?? DEFAULT_SECURITY_SCREEN_TIMEOUT_MS;
    const attempt = async (): Promise<SecurityScreenVerdict | undefined> => {
      const abort = new AbortController();
      let timer: ReturnType<typeof setTimeout> | undefined;
      let proxySettled = false;
      const requestId = context.requestId ?? randomUUID();
      const modelScreen = () =>
        deps.harness.models.screenSecurity?.({
          payload,
          signal: abort.signal,
          recordModelCall: (rec) => {
            deps.modelGateway.recordCall({ at: Date.now(), scopeLabel, ...rec });
            void deps.budget?.record(actorId, estimateCostUsd(rec.inputTokens));
          },
          ...(recordLlmRequest ? { recordLlmRequest } : {}),
        });
      const recordProxyError = () => {
        if (!deps.securityScreener || proxySettled) return;
        proxySettled = true;
        deps.auditLog.record({
          at: Date.now(),
          principalId: actorId,
          action: "security_screen.classify",
          resource: deps.securityScreener.provider,
          scopeLabel,
          status: "error",
        });
      };
      const proxyScreen = async () => {
        if (!deps.securityScreener) return undefined;
        try {
          const classified = await deps.securityScreener.classify({
            payload,
            hook: context.hook ?? "user_input",
            metadata: {
              ...(context.surface ? { surface: context.surface } : {}),
              ...(context.origin ? { origin: context.origin } : {}),
            },
            requestId,
            signal: abort.signal,
          });
          if (abort.signal.aborted) return undefined;
          proxySettled = true;
          let status: "would_block" | "shadow_allow" | "block" | "allow";
          if (deps.securityScreener.shadow) {
            status = classified.verdict.decision === "strict" ? "would_block" : "shadow_allow";
          } else {
            status = classified.verdict.decision === "strict" ? "block" : "allow";
          }
          deps.auditLog.record({
            at: Date.now(),
            principalId: actorId,
            action: "security_screen.classify",
            resource: deps.securityScreener.provider,
            scopeLabel,
            status,
            detail: JSON.stringify({
              hook: context.hook ?? "user_input",
              requestId,
              score: classified.score,
              threshold: classified.threshold,
              ...(classified.outcome ? { outcome: classified.outcome } : {}),
            }),
          });
          return classified;
        } catch {
          recordProxyError();
          return undefined;
        }
      };
      try {
        return await Promise.race([
          Promise.resolve()
            .then(async () => {
              if (!deps.securityScreener) return modelScreen();
              if (!deps.securityScreener.shadow) return (await proxyScreen())?.verdict;
              return runShadowScreen(modelScreen, proxyScreen, (result) => {
                let status: "unavailable" | "agree" | "disagree" = "unavailable";
                if (result.authoritative && result.shadow) {
                  status = result.authoritative.decision === result.shadow.verdict.decision ? "agree" : "disagree";
                }
                deps.auditLog.record({
                  at: Date.now(),
                  principalId: actorId,
                  action: "security_screen.shadow_evaluation",
                  resource: deps.securityScreener!.provider,
                  scopeLabel,
                  status,
                  detail: JSON.stringify({
                    requestId,
                    authoritative: result.authoritative?.decision ?? "unavailable",
                    shadow: result.shadow?.verdict.decision ?? "unavailable",
                  }),
                });
              });
            })
            .catch(swallowAs("orchestrator: security screen", undefined)),
          new Promise<undefined>((resolve) => {
            timer = setTimeout(() => {
              abort.abort();
              recordProxyError();
              resolve(undefined);
            }, timeoutMs);
          }),
        ]);
      } finally {
        if (timer) clearTimeout(timer);
      }
    };
    const startedAt = Date.now();
    const first = await attempt();
    if (first) return first;
    if (Date.now() - startedAt >= timeoutMs / 2) return unscreenedVerdict();
    await sleep(250);
    return (await attempt()) ?? unscreenedVerdict();
  };
}
