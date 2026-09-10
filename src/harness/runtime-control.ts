import type { RuntimeChoice } from "./harness.ts";
import type { RuntimeService } from "./runtime-types.ts";
import type { App } from "../api/app.ts";
import {
  runtimeConfigBody,
  validateRuntimeChoice,
  webuiModelEnabled,
  type RuntimeDeps,
} from "../api/runtime-config.ts";
import { livePersonCapability } from "../api/artifact-share.ts";
import { parseScopeId } from "../types.ts";
import {
  ALL_PROVIDERS_AVAILABLE,
  isHarnessId,
  thinkingLevelsForHarness,
  safeModelMetadata,
  modelSupportedByHarness,
} from "../model/pi-models.ts";

export function createRuntimeService(deps: RuntimeDeps, app: Pick<App, "authorizesCapabilityScope">): RuntimeService {
  return async (claims, active, request, authorizeChoice, individualAuth, signal) => {
    if (!deps.config) return { ok: false, error: "runtime_unavailable" };
    const scope = parseScopeId(claims.scopeId);
    if (
      scope.kind === "org" ||
      (scope.kind === "personal" && scope.ref !== claims.actorId) ||
      !(await app.authorizesCapabilityScope(claims))
    )
      return { ok: false, error: "forbidden" };
    await deps.refreshModels?.();
    const snapshot = await runtimeConfigBody(
      { deps: individualAuth ? { ...deps, providerKeys: ALL_PROVIDERS_AVAILABLE, modelCredentials: undefined } : deps },
      claims.scopeId,
    );
    if (individualAuth && authorizeChoice) {
      if (snapshot.approvedHarnesses.includes("pi")) {
        const piModels = snapshot.modelsByHarness.pi ?? [];
        for (const id of piModels) {
          if (id.startsWith("codex/")) continue;
          const subscriptionId = `codex/${id}`;
          if (modelSupportedByHarness(subscriptionId, "pi") && !piModels.includes(subscriptionId)) {
            piModels.push(subscriptionId);
            const metadata = safeModelMetadata(subscriptionId);
            if (metadata) snapshot.modelCatalog[subscriptionId] = metadata;
          }
        }
      }
      for (const harnessId of snapshot.approvedHarnesses) {
        const candidates = snapshot.modelsByHarness[harnessId] ?? [];
        const allowed = await Promise.all(
          candidates.map((modelId) => authorizeChoice({ harnessId, modelId, effortLevel: "auto", fastMode: false })),
        );
        snapshot.modelsByHarness[harnessId] = candidates.filter((_, index) => !allowed[index]);
      }
    }
    if (request.action === "get")
      return {
        ok: true,
        active,
        ...snapshot,
        effortLevelsByHarness: Object.fromEntries(
          snapshot.approvedHarnesses.map((id) => [id, thinkingLevelsForHarness(id)]),
        ),
        taskLifetime:
          "The current user request, including retries and runtime handoffs. Future requests use the scope default.",
      };
    if (!livePersonCapability(claims) || claims.triggered || claims.botActor)
      return { ok: false, error: "live_actor_required" };
    const lifetime = request.lifetime ?? "task";
    if (request.action === "inherit") {
      const choice = lifetime === "scope" ? snapshot.orgDefault : snapshot.effective;
      const error = validateRuntimeChoice(choice);
      if (error) return { ok: false, error };
      if (
        !snapshot.approvedHarnesses.includes(choice.harnessId) ||
        !snapshot.modelsByHarness[choice.harnessId]?.includes(choice.modelId)
      )
        return { ok: false, error: "runtime_unavailable" };
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
    if (!(await webuiModelEnabled({ deps }, modelId))) return { ok: false, error: "model_not_enabled" };
    const choice: RuntimeChoice = {
      harnessId,
      modelId,
      effortLevel: request.effort ?? active.effortLevel ?? "auto",
      fastMode: request.fastMode ?? active.fastMode ?? false,
    };
    const error = validateRuntimeChoice(choice);
    if (error) return { ok: false, error };
    const authError = await authorizeChoice?.(choice);
    if (authError) return { ok: false, error: "account_runtime_unavailable", message: authError };
    if (signal?.aborted) return { ok: false, error: "cancelled" };
    if (lifetime === "scope") await deps.config.setRuntimeSelectionLatest(claims.scopeId, choice);
    return { ok: true, handoff: { choice, lifetime } };
  };
}
