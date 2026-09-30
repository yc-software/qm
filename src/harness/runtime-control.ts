import type { RuntimeService } from "./runtime-types.ts";
import type { App } from "../api/app.ts";
import { runtimeConfigBody, webuiModelEnabled, type RuntimeDeps } from "../api/runtime-config.ts";
import { livePersonCapability } from "../api/artifact-share.ts";
import { parseScopeId } from "../types.ts";
import { isHarnessId, parseRuntimeChoice } from "../model/pi-models.ts";

export function createRuntimeService(deps: RuntimeDeps, app: Pick<App, "authorizesCapabilityScope">): RuntimeService {
  return async (
    claims,
    active,
    request,
    authorizeChoice,
    individualAuth,
    signal,
    cronFire = false,
    purpose,
    defaults,
  ) => {
    if (!deps.config) return { ok: false, error: "runtime_unavailable" };
    const scope = parseScopeId(claims.scopeId);
    if (
      scope.kind === "org" ||
      (scope.kind === "personal" && scope.ref !== claims.actorId) ||
      !(await app.authorizesCapabilityScope(claims))
    )
      return { ok: false, error: "forbidden" };
    await deps.refreshModels?.();
    purpose ??= cronFire ? "cron" : undefined;
    const snapshot = await runtimeConfigBody(
      { deps },
      claims.scopeId,
      individualAuth ? authorizeChoice : undefined,
      purpose,
      defaults,
    );
    if (request.action === "get")
      return {
        ok: true,
        active,
        ...snapshot,
        taskLifetime:
          "The current request or cron fire, including retries and runtime handoffs. Future requests and fires use their configured defaults.",
      };
    const lifetime = request.lifetime ?? "task";
    const cronTask = cronFire && claims.triggered === true && !claims.botActor && lifetime === "task";
    if (!cronTask && (!livePersonCapability(claims) || claims.triggered || claims.botActor))
      return { ok: false, error: "live_actor_required" };
    if (request.action === "inherit") {
      const purposeConfigured = purpose && (await deps.config.getPurposeRuntimeDurable(purpose));
      const parsed = parseRuntimeChoice(
        lifetime === "scope" && !purposeConfigured ? snapshot.orgDefault : snapshot.effective,
      );
      if (!parsed.ok) return { ok: false, error: parsed.error, message: parsed.message };
      const choice = parsed.choice;
      if (
        !snapshot.approvedHarnesses.includes(choice.harnessId) ||
        !snapshot.modelsByHarness[choice.harnessId]?.includes(choice.modelId)
      )
        return { ok: false, error: "runtime_unavailable" };
      if (!(await webuiModelEnabled({ deps }, choice.modelId, purpose)))
        return { ok: false, error: "model_not_enabled" };
      const authError = await authorizeChoice?.(choice);
      if (authError) return { ok: false, error: "account_runtime_unavailable", message: authError };
      if (signal?.aborted) return { ok: false, error: "cancelled" };
      if (lifetime === "scope") await deps.config.setRuntimeSelectionLatest(claims.scopeId, null);
      return { ok: true, handoff: { choice, lifetime } };
    }
    if (request.action !== "set") return { ok: false, error: "invalid_action" };
    const harnessId = request.harness ?? active.harnessId;
    if (!isHarnessId(harnessId) || !snapshot.approvedHarnesses.includes(harnessId))
      return { ok: false, error: "harness_not_approved", candidates: snapshot.approvedHarnesses };
    const candidates = snapshot.modelsByHarness[harnessId] ?? [];
    let modelId = request.model ?? active.modelId;
    if (!candidates.includes(modelId)) {
      const query = modelId.toLowerCase();
      const matches = candidates.filter((id) => {
        const meta = snapshot.modelCatalog[id];
        return [id, meta?.name, meta?.label, meta?.buttonLabel].some((label) => label?.toLowerCase() === query);
      });
      if (matches.length !== 1)
        return {
          ok: false,
          error: matches.length ? "model_ambiguous" : "model_unavailable",
          candidates: matches.length ? matches : candidates,
        };
      modelId = matches[0]!;
    }
    if (!(await webuiModelEnabled({ deps }, modelId, purpose))) return { ok: false, error: "model_not_enabled" };
    const carried = request.effort === undefined && active.effortLevel !== undefined;
    const parsed = parseRuntimeChoice(
      {
        harnessId,
        modelId,
        effortLevel: request.effort ?? active.effortLevel ?? "auto",
        fastMode: request.fastMode ?? active.fastMode ?? false,
      },
      carried,
    );
    if (!parsed.ok) return { ok: false, error: parsed.error, message: parsed.message };
    const choice = parsed.choice;
    const authError = await authorizeChoice?.(choice);
    if (authError) return { ok: false, error: "account_runtime_unavailable", message: authError };
    if (signal?.aborted) return { ok: false, error: "cancelled" };
    if (lifetime === "scope") await deps.config.setRuntimeSelectionLatest(claims.scopeId, choice);
    return { ok: true, handoff: { choice, lifetime } };
  };
}
