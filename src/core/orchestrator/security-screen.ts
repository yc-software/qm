import { randomUUID } from "node:crypto";
import type { ScopeId } from "../../types.ts";
import type { TurnOrigin } from "../turn-origin.ts";
import type { SecurityScreenClassification, SecurityScreenHook } from "../../security/security-screener.ts";
import {
  securityScreenSystemPrompt,
  UNSCREENED_REASON,
  type SecurityScreenVerdict,
} from "../../security/security-posture.ts";
import { estimateCostUsd } from "../../ratelimit/budget.ts";
import type { HarnessLlmRequestRecord } from "../../harness/harness.ts";
import { swallowAs } from "../../util/errors.ts";
import { sleep } from "../../util/async.ts";
import { headSlice } from "../../util/text.ts";
import type { OrchestratorDeps } from "./types.ts";

const DEFAULT_SECURITY_SCREEN_TIMEOUT_MS = 15_000;
const MAX_SCREEN_REQUEST_CHARS = 2_000;
const MAX_AUDITED_SOURCES = 20;

const unscreenedVerdict = (): SecurityScreenVerdict => ({
  decision: "auto",
  unscreened: true,
  reason: UNSCREENED_REASON,
});

type ScreenStatus = "allow" | "block" | "would_block" | "error";
type Screened = Pick<SecurityScreenClassification, "verdict"> & Partial<SecurityScreenClassification>;

interface SecurityScreenContext {
  mode: "observe" | "enforce";
  hook?: SecurityScreenHook;
  surface?: string;
  origin?: TurnOrigin["kind"];
  requestId?: string;
  request?: string;
  sessionId?: string;
  runId?: string;
  thread?: string;
}

export type SecurityClassifier = (
  payload: string,
  actorId: string,
  scopeLabel: ScopeId,
  recordLlmRequest: ((rec: HarnessLlmRequestRecord, signal?: AbortSignal) => void | Promise<void>) | undefined,
  context: SecurityScreenContext,
) => Promise<SecurityScreenVerdict | undefined>;

function screenSources(payload: string): string[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(payload);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  const sources = parsed.flatMap((item: { source?: unknown } | null) =>
    typeof item?.source === "string" ? [item.source.slice(0, 120)] : [],
  );
  return [...new Set(sources)].slice(0, MAX_AUDITED_SOURCES);
}

export function createSecurityClassifier(deps: OrchestratorDeps): SecurityClassifier {
  return async function classifySecurityData(payload, actorId, scopeLabel, recordLlmRequest, context) {
    const screener = deps.securityScreener;
    const model = deps.harness.models.screenSecurity;
    const observe = context.mode === "observe";
    if (!screener && !model) return observe ? { decision: "auto" } : undefined;
    const timeoutMs = deps.securityScreenTimeoutMs ?? DEFAULT_SECURITY_SCREEN_TIMEOUT_MS;
    const hook = context.hook ?? "user_input";
    let request: { origin: string; text: string; truncated: boolean } | undefined;
    if (hook === "tool_response" && context.request?.trim()) {
      request = {
        origin: context.origin ?? "unknown",
        text: headSlice(context.request, MAX_SCREEN_REQUEST_CHARS).toWellFormed(),
        truncated: context.request.length > MAX_SCREEN_REQUEST_CHARS,
      };
    }

    const audit = (status: ScreenStatus, requestId: string, attempts: number, result?: Screened): void => {
      deps.auditLog.record({
        at: Date.now(),
        principalId: actorId,
        action: "security_screen.classify",
        resource: screener?.provider ?? "model",
        scopeLabel,
        status,
        detail: JSON.stringify({
          hook,
          mode: context.mode,
          sources: screenSources(payload),
          ...(context.surface ? { surface: context.surface } : {}),
          ...(context.origin ? { origin: context.origin } : {}),
          ...(context.sessionId ? { sessionId: context.sessionId } : {}),
          ...(context.runId ? { runId: context.runId } : {}),
          ...(context.thread ? { thread: context.thread } : {}),
          requestId,
          attempts,
          ...(result?.score !== undefined ? { score: result.score, threshold: result.threshold } : {}),
          ...(result?.outcome ? { outcome: result.outcome } : {}),
        }),
      });
    };

    const screenOnce = async (requestId: string, signal: AbortSignal): Promise<Screened | undefined> => {
      if (screener) {
        return screener.classify({
          payload,
          hook,
          metadata: {
            ...(context.surface ? { surface: context.surface } : {}),
            ...(context.origin ? { origin: context.origin } : {}),
            ...(request ? { request } : {}),
          },
          requestId,
          signal,
        });
      }
      const flagger = deps.config?.getAutoFlaggerConfig();
      const verdict = await model!({
        payload: request ? JSON.stringify({ request, payload }) : payload,
        ...(flagger
          ? {
              harnessId: flagger.harnessId,
              modelId: flagger.modelId,
              systemPrompt: securityScreenSystemPrompt(flagger.rubric),
            }
          : {}),
        signal,
        recordModelCall: (rec) => {
          deps.modelGateway.recordCall({ at: Date.now(), scopeLabel, ...rec });
          if (!observe) void deps.budget?.record(actorId, estimateCostUsd(rec.inputTokens));
        },
        ...(recordLlmRequest && !observe ? { recordLlmRequest } : {}),
      });
      return verdict ? { verdict } : undefined;
    };

    const attempt = async (): Promise<{ requestId: string; result: Screened | undefined }> => {
      const requestId = context.requestId ?? randomUUID();
      const abort = new AbortController();
      const timer = setTimeout(() => abort.abort(), timeoutMs);
      if (observe) timer.unref();
      const timedOut = new Promise<undefined>((resolve) =>
        abort.signal.addEventListener("abort", () => resolve(undefined), { once: true }),
      );
      try {
        const result = await Promise.race([screenOnce(requestId, abort.signal), timedOut]).catch(
          swallowAs("orchestrator: security screen", undefined),
        );
        return { requestId, result };
      } finally {
        clearTimeout(timer);
        abort.abort();
      }
    };
    const settle = ({ requestId, result }: Awaited<ReturnType<typeof attempt>>, attempts: number) => {
      let status: ScreenStatus = "error";
      if (result && !result.verdict.unscreened) {
        if (result.verdict.decision === "strict") status = observe ? "would_block" : "block";
        else status = "allow";
      }
      audit(status, requestId, attempts, result);
      return result?.verdict;
    };

    if (observe) {
      void attempt()
        .then((result) => settle(result, 1))
        .catch(swallowAs("orchestrator: observed security screen", undefined));
      return { decision: "auto" };
    }

    const startedAt = Date.now();
    const first = await attempt();
    if (first.result || Date.now() - startedAt >= timeoutMs / 2) return settle(first, 1) ?? unscreenedVerdict();
    await sleep(250);
    return settle(await attempt(), 2) ?? unscreenedVerdict();
  };
}
