import { sendJson } from "../../http.ts";
import { audit, authorizeAdmin, orgScope } from "../shared.ts";
import type { ApiCtx } from "../route.ts";
import { securityScreenSystemPrompt, type SecurityScreenVerdict } from "../../../security/security-posture.ts";
import { defaultAutoFlaggerConfig, parseAutoFlaggerDraft, type AutoFlaggerDraft } from "../admin-resources.ts";
import { isHarnessId } from "../../../model/pi-models.ts";
import type { ScreenSample } from "../../../sessions/session-store.ts";
import type { SecurityScreenProbe } from "../../../security/security-screener.ts";

const DEFAULT_WINDOW = 100;
const MAX_WINDOW = 500;
const CONCURRENCY = 4;
const PER_SAMPLE_TIMEOUT_MS = 20_000;
const RUN_DEADLINE_MS = 120_000;

interface RunTotals {
  flagged: number;
  allowed: number;
  unscreened: number;
  errors: number;
}

const emptyTotals = (): RunTotals => ({ flagged: 0, allowed: 0, unscreened: 0, errors: 0 });

const rate = (flagged: number, scored: number): number | null =>
  scored > 0 ? Math.round((flagged / scored) * 10_000) / 10_000 : null;

/**
 * Replay past screenings through one flagger configuration. Verdicts are counted, never returned —
 * the payloads belong to the conversations they came from, and the answer here is a rate.
 */
async function replay(
  probe: SecurityScreenProbe,
  config: AutoFlaggerDraft,
  samples: readonly ScreenSample[],
  actorId: string,
  deadline: number,
): Promise<{ totals: RunTotals; verdicts: Map<string, "strict" | "auto">; complete: boolean }> {
  const systemPrompt = securityScreenSystemPrompt(config.rubric);
  const totals = emptyTotals();
  const verdicts = new Map<string, "strict" | "auto">();
  let next = 0;
  let complete = true;
  const worker = async (): Promise<void> => {
    for (;;) {
      if (Date.now() >= deadline) {
        complete = false;
        return;
      }
      const sample = samples[next++];
      if (!sample) return;
      let verdict: SecurityScreenVerdict | undefined;
      try {
        verdict = await probe({
          payload: sample.payload,
          harnessId: config.harnessId,
          modelId: config.modelId,
          systemPrompt,
          actorId,
          scopeLabel: sample.scopeLabel,
          signal: AbortSignal.timeout(PER_SAMPLE_TIMEOUT_MS),
        });
      } catch {
        verdict = undefined;
      }
      if (!verdict) totals.errors += 1;
      else if (verdict.unscreened) totals.unscreened += 1;
      else if (verdict.decision === "strict") {
        totals.flagged += 1;
        verdicts.set(sample.id, "strict");
      } else {
        totals.allowed += 1;
        verdicts.set(sample.id, "auto");
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, samples.length) }, worker));
  return { totals, verdicts, complete };
}

/**
 * POST /v1/admin/scopes/:scope/auto-flagger/test — run a candidate flagger over the most recent
 * real screenings and report how often it flags. Org-wide, admin-only, aggregates only.
 */
export async function testAutoFlagger(ctx: ApiCtx): Promise<void> {
  const scope = orgScope();
  const requestedScope = decodeURIComponent(ctx.params.scope ?? scope);
  const actor = await authorizeAdmin(ctx, scope);
  if (!actor) return;
  if (requestedScope !== scope) {
    sendJson(ctx.res, 400, { error: "bad_request", message: "the Auto flagger is org-wide; request an org scope" });
    return;
  }
  const body = (ctx.body ?? {}) as {
    window?: unknown;
    harnessId?: unknown;
    modelId?: unknown;
    rubric?: unknown;
    compare?: unknown;
  };
  const requestedWindow = body.window === undefined ? DEFAULT_WINDOW : Number(body.window);
  if (!Number.isInteger(requestedWindow) || requestedWindow < 1 || requestedWindow > MAX_WINDOW) {
    sendJson(ctx.res, 400, {
      error: "bad_request",
      message: `window must be an integer between 1 and ${MAX_WINDOW}`,
    });
    return;
  }
  const { sessions, screenSecurity, config: configStore } = ctx.deps;
  if (!sessions || !screenSecurity || !configStore) {
    sendJson(ctx.res, 501, {
      error: "unsupported",
      message: "this deployment has no screening model wired, so the flagger cannot be tested",
    });
    return;
  }
  const saved = configStore.getAutoFlaggerConfig();
  const fallback = defaultAutoFlaggerConfig(ctx.deps);
  const effective: AutoFlaggerDraft =
    saved && isHarnessId(saved.harnessId)
      ? { harnessId: saved.harnessId, modelId: saved.modelId, rubric: saved.rubric }
      : fallback;
  const draftGiven = body.harnessId !== undefined || body.modelId !== undefined || body.rubric !== undefined;
  const parsed = draftGiven
    ? await parseAutoFlaggerDraft(ctx.deps, body)
    : ({ value: effective } as { value: AutoFlaggerDraft });
  if ("error" in parsed) {
    sendJson(ctx.res, 400, { error: "bad_request", message: parsed.error });
    return;
  }
  const candidate = parsed.value;
  const samples = await sessions.listScreenSamples(requestedWindow);
  const startedAt = Date.now();
  const deadline = startedAt + RUN_DEADLINE_MS;
  if (!samples.length) {
    audit(ctx.deps, {
      principalId: actor.id,
      action: "auto_flagger.test",
      resource: "auto-flagger",
      scopeLabel: scope,
      status: "empty",
      detail: JSON.stringify({ window: requestedWindow, sampled: 0 }),
    });
    sendJson(ctx.res, 200, {
      scopeId: scope,
      window: requestedWindow,
      sampled: 0,
      harnessId: candidate.harnessId,
      modelId: candidate.modelId,
      message: "no past screenings are recorded yet, so there is nothing to replay",
    });
    return;
  }
  const run = await replay(screenSecurity, candidate, samples, actor.id, deadline);
  const scored = run.totals.flagged + run.totals.allowed;
  const wantCompare =
    body.compare === true &&
    (candidate.harnessId !== effective.harnessId ||
      candidate.modelId !== effective.modelId ||
      candidate.rubric !== effective.rubric);
  const baseline = wantCompare ? await replay(screenSecurity, effective, samples, actor.id, deadline) : null;
  let changed: number | null = null;
  if (baseline) {
    changed = 0;
    for (const [id, verdict] of run.verdicts) {
      const before = baseline.verdicts.get(id);
      if (before && before !== verdict) changed += 1;
    }
  }
  const result = {
    scopeId: scope,
    window: requestedWindow,
    sampled: samples.length,
    scored,
    flagged: run.totals.flagged,
    allowed: run.totals.allowed,
    unscreened: run.totals.unscreened,
    errors: run.totals.errors,
    flagRate: rate(run.totals.flagged, scored),
    oldestAt: samples[samples.length - 1]?.createdAt ?? null,
    newestAt: samples[0]?.createdAt ?? null,
    harnessId: candidate.harnessId,
    modelId: candidate.modelId,
    saved: !!saved,
    partial: !run.complete || !(baseline?.complete ?? true),
    durationMs: Date.now() - startedAt,
    ...(baseline
      ? {
          baseline: {
            harnessId: effective.harnessId,
            modelId: effective.modelId,
            flagged: baseline.totals.flagged,
            flagRate: rate(baseline.totals.flagged, baseline.totals.flagged + baseline.totals.allowed),
            changed,
          },
        }
      : {}),
  };
  audit(ctx.deps, {
    principalId: actor.id,
    action: "auto_flagger.test",
    resource: "auto-flagger",
    scopeLabel: scope,
    status: result.partial ? "partial" : "ok",
    detail: JSON.stringify({
      window: requestedWindow,
      sampled: result.sampled,
      flagged: result.flagged,
      errors: result.errors,
      harnessId: candidate.harnessId,
      modelId: candidate.modelId,
      compared: !!baseline,
    }),
  });
  sendJson(ctx.res, 200, result);
}
