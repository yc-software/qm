import { getBuiltinModels } from "@earendil-works/pi-ai/providers/all";
import { ModelVerificationError } from "../../../model/model-verification.ts";
import { MODEL_REGISTRY, safeModelMetadata } from "../../../model/pi-models.ts";
import { errMessage } from "../../../util/errors.ts";
import { sendJson } from "../../http.ts";
import type { ApiCtx } from "../route.ts";
import { audit, authorizeAdmin, orgScope, isObj } from "../shared.ts";

export async function modelRegistry(ctx: ApiCtx): Promise<void> {
  const scope = orgScope(ctx.deps);
  const actor = await authorizeAdmin(ctx, scope);
  if (!actor) return;
  const store = ctx.deps.modelRegistry;
  if (!store) return sendJson(ctx.res, 404, { error: "not_found" });
  if (ctx.method === "GET") {
    await ctx.deps.refreshModels?.();
    const ids = new Set([
      ...MODEL_REGISTRY.map((model) => model.id),
      ...getBuiltinModels("openai").map((model) => model.id),
      ...getBuiltinModels("anthropic").map((model) => model.id),
    ]);
    const templates = [...ids].flatMap((id) => {
      const model = safeModelMetadata(id);
      return model && (model.provider === "openai" || model.provider === "anthropic") ? [model] : [];
    });
    return sendJson(ctx.res, 200, { models: await store.statuses(), templates });
  }
  const id = ctx.params.model;
  if (!id) return sendJson(ctx.res, 400, { error: "bad_request" });
  let verification: { verifiedAt: number; verificationScope: "organization" } | undefined;
  try {
    if (ctx.method === "DELETE") {
      if (!(await store.delete(id, actor.id))) return sendJson(ctx.res, 404, { error: "not_found" });
    } else {
      if (!isObj(ctx.body) || (ctx.body.id !== undefined && ctx.body.id !== id))
        return sendJson(ctx.res, 400, { error: "bad_request" });
      const { verify, ...spec } = ctx.body;
      if (verify !== true)
        return sendJson(ctx.res, 400, {
          error: "verification_consent_required",
          message:
            "Verify and enable sends a small billable synthetic request with organization credentials. Set verify: true to continue.",
        });
      verification = await store.upsert({ ...spec, id }, actor.id);
    }
  } catch (error) {
    if (error instanceof ModelVerificationError) {
      audit(ctx.deps, {
        principalId: actor.id,
        action: "model-registry.verification-failed",
        resource: id,
        scopeLabel: scope,
      });
      await store.refresh();
      return sendJson(
        ctx.res,
        ["configuration_conflict", "changed_during_verification"].includes(error.code) ? 409 : 422,
        { error: error.code, message: error.message },
      );
    }
    return sendJson(ctx.res, 400, { error: "bad_request", message: errMessage(error) });
  }
  audit(ctx.deps, {
    principalId: actor.id,
    action: ctx.method === "DELETE" ? "model-registry.delete" : "model-registry.update",
    resource: id,
    scopeLabel: scope,
  });
  await store.refresh();
  return sendJson(ctx.res, 200, { ok: true, ...verification });
}

import { builtinModelSpec, lookupModel, modelLookupInput } from "../../../model/model-lookup.ts";
import { builtInModelCatalog, selectableModelCatalog } from "../../../model/model-catalog.ts";
import { verificationFailure } from "../../../model/model-verification.ts";

export async function lookupRegistryModel(ctx: ApiCtx): Promise<void> {
  if (!(await authorizeAdmin(ctx, orgScope(ctx.deps)))) return;
  const input = modelLookupInput.safeParse(ctx.body);
  if (!input.success)
    return sendJson(ctx.res, 400, { error: "bad_request", message: "Choose a provider and enter a valid model ID." });
  await ctx.deps.refreshModels?.();
  try {
    const saved = (await ctx.deps.modelRegistry?.statuses())?.find(
      (row) => row.spec.id === input.data.id && !row.disabled,
    );
    if (saved?.spec.provider && saved.spec.provider !== input.data.provider)
      return sendJson(ctx.res, 400, {
        error: "provider_mismatch",
        message: "The saved model uses a different provider.",
      });
    if (saved && saved.spec.provider)
      return sendJson(ctx.res, 200, {
        kind: "saved",
        spec: saved.spec,
        source: "Saved administrator definition",
        missing: [
          ...["name", "template", "contextWindow", "maxTokens"].filter(
            (field) => saved.spec[field as keyof typeof saved.spec] == null,
          ),
          ...["input", "output", "cacheRead", "cacheWrite"].filter(
            (field) => saved.spec.cost?.[field as "input" | "output" | "cacheRead" | "cacheWrite"] == null,
          ),
        ],
        message: "Review or edit this existing definition, then verify it again.",
      });
    return sendJson(
      ctx.res,
      200,
      await lookupModel(input.data, ctx.deps.modelCredentials, ctx.deps.modelCredentialFetch),
    );
  } catch {
    return sendJson(ctx.res, 400, {
      error: "lookup_failed",
      message: "The model ID does not match the selected provider.",
    });
  }
}

export async function enableBuiltinModel(ctx: ApiCtx): Promise<void> {
  const scope = orgScope(ctx.deps);
  const actor = await authorizeAdmin(ctx, scope);
  if (!actor) return;
  if (!isObj(ctx.body)) return sendJson(ctx.res, 400, { error: "bad_request" });
  const input = modelLookupInput.safeParse({ provider: ctx.body.provider, id: ctx.params.model });
  if (!input.success || ctx.body.verify !== true)
    return sendJson(ctx.res, 400, {
      error: "bad_request",
      message: "Choose a provider and explicitly consent to verification with verify: true.",
    });
  const { config, modelVerifier } = ctx.deps;
  if (!config || !modelVerifier) return sendJson(ctx.res, 503, { error: "verification_unavailable" });
  await ctx.deps.refreshModels?.();
  const spec = builtinModelSpec(input.data);
  if (!spec)
    return sendJson(ctx.res, 400, {
      error: "not_builtin",
      message: "Use Verify and enable on the model definition instead.",
    });
  const approved = (await config.getApprovedHarnessesDurable()) ?? [ctx.deps.harnessId ?? "pi"];
  if (!approved.includes("pi"))
    return sendJson(ctx.res, 400, {
      error: "pi_not_approved",
      message: "Enable the Pi harness in Models settings first.",
    });
  try {
    const context = await modelVerifier(spec);
    const signal = AbortSignal.timeout(15_000);
    await context.probe(signal);
    const apply = async () => {
      const stillApproved = (await config.getApprovedHarnessesDurable()) ?? [ctx.deps.harnessId ?? "pi"];
      if (!stillApproved.includes("pi"))
        throw new ModelVerificationError(
          "pi_not_approved",
          "Pi was disabled during verification. Review Models settings.",
        );
      if ((await modelVerifier(spec)).fingerprint !== context.fingerprint)
        throw new ModelVerificationError("changed_during_verification", "Serving credentials changed. Verify again.");
      const managed = await ctx.deps.modelCredentials?.availability();
      const catalog = managed?.openrouter
        ? await selectableModelCatalog(ctx.deps.modelCredentialFetch)
        : builtInModelCatalog();
      const configured = await config.getWebuiModelsDurable(scope);
      const ids = configured ?? catalog.map((model) => model.id);
      config.setWebuiModels(scope, [...new Set([...ids, spec.id])]);
      await config.flushScope(scope);
    };
    if (ctx.deps.advisoryLock) await ctx.deps.advisoryLock.withLock("admin-model-picker", apply);
    else await apply();
  } catch (error) {
    const failure = verificationFailure(error);
    audit(ctx.deps, {
      principalId: actor.id,
      action: "model-registry.verification-failed",
      resource: spec.id,
      scopeLabel: scope,
    });
    return sendJson(ctx.res, 422, { error: failure.code, message: failure.message });
  }
  audit(ctx.deps, {
    principalId: actor.id,
    action: "model-registry.enable-builtin",
    resource: spec.id,
    scopeLabel: scope,
  });
  return sendJson(ctx.res, 200, {
    ok: true,
    verifiedAt: Date.now(),
    verificationScope: "organization",
    message: "Existing model verified and added to the web picker. Organization default unchanged.",
  });
}
