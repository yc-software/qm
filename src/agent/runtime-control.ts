import type { RuntimeChoice } from "./agent.ts";
import type { RuntimeService } from "./runtime-types.ts";
import type { App } from "../api/app.ts";
import { runtimeConfigBody, validateRuntimeChoice, type RuntimeDeps } from "../api/runtime-config.ts";
import { personAtKeyboard } from "../api/artifact-share.ts";
import { parseScopeId } from "../types.ts";

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
    if (!cronTask && !personAtKeyboard(claims)) return { ok: false, error: "live_actor_required" };
    const candidates = snapshot.models;
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
    const choice: RuntimeChoice = {
      modelId,
      effortLevel: request.effort ?? active.effortLevel ?? "auto",
      fastMode: request.fastMode ?? active.fastMode ?? false,
    };
    const error = validateRuntimeChoice(choice);
    if (error) return { ok: false, error };
    const authError = await authorizeChoice?.(choice);
    if (authError) return { ok: false, error: "account_runtime_unavailable", message: authError };
    if (signal?.aborted) return { ok: false, error: "cancelled" };
    if (lifetime === "scope") await deps.config.setRuntimeSelection(claims.scopeId, choice);
    return { ok: true, handoff: { choice, lifetime } };
  };
}
