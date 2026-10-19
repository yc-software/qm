import { decisionCatalog, parseDecisionProvider, parseDecisionRule } from "../../decisions/decisions.ts";
import { selectableBaseModels } from "../../model/pi-models.ts";
import { parseScopeId } from "../../types.ts";
import { errMessage } from "../../util/errors.ts";
import type { AdminResource } from "./admin-resources.ts";
import { audit } from "./shared.ts";

export const decisionsResource: AdminResource = {
  id: "decisions",
  kind: "custom",
  target: "org",
  label:
    "Decision providers and rules. Send { provider }, { removeProvider: id }, { rule } or { removeRule: id }. A provider names a wire protocol (chat-completions, decisions or systemone); leave baseUrl unset to use the model gateway, or set baseUrl plus an org service credential. A rule asks a classifier a question at a hook and applies the chosen option's action. Rule mode is off, observe or enforce.",
  readKey: "decisions",
  get: async (deps, scope) =>
    deps.decisions && {
      ...decisionCatalog(),
      models: selectableBaseModels().map((m) => m.id),
      credentials: ((await deps.serviceCreds?.listServiceCredentials(scope)) ?? [])
        .filter((c) => c.source !== "deployment")
        .map((c) => c.slug),
      providers: await deps.decisions.providers(),
      rules: await deps.decisions.rules(),
    },
  apply: async (ctx, actor, scope) => {
    if (parseScopeId(scope).kind !== "org") return { error: "decisions are org-wide; target an org scope" };
    const store = ctx.deps.decisions;
    if (!store) return { error: "not available on this deployment", status: 404 };
    const body = (ctx.body ?? {}) as Record<string, unknown>;
    const by = { actorId: actor.id };
    let change: [string, string];
    try {
      if (typeof body.removeProvider === "string") {
        await store.removeProvider(body.removeProvider);
        change = ["decision.provider.remove", body.removeProvider];
      } else if (typeof body.removeRule === "string") {
        await store.removeRule(body.removeRule);
        change = ["decision.rule.remove", body.removeRule];
      } else if (body.provider !== undefined) {
        const parsed = parseDecisionProvider(body.provider);
        if ("error" in parsed) return parsed;
        const credential = parsed.provider.credential;
        const credentials = credential ? ((await ctx.deps.serviceCreds?.listServiceCredentials(scope)) ?? []) : [];
        if (credentials.some((c) => c.slug === credential && c.source === "deployment"))
          return { error: `credential ${credential} is supplied by this deployment for the broker only` };
        await store.saveProvider(parsed.provider, by);
        change = ["decision.provider.save", parsed.provider.id];
      } else if (body.rule !== undefined) {
        const models = new Set(selectableBaseModels().map((m) => m.id));
        const named = (body.rule as { model?: { provider?: unknown } } | null)?.model?.provider;
        const providers = typeof named === "string" ? await store.providers([named]) : [];
        const parsed = parseDecisionRule(body.rule, providers, models);
        if ("error" in parsed) return parsed;
        await store.saveRule(parsed.rule, by);
        change = ["decision.rule.save", `${parsed.rule.id}:${parsed.rule.mode}`];
      } else return { error: "send provider, removeProvider, rule or removeRule" };
    } catch (error) {
      return { error: errMessage(error) };
    }
    audit(ctx.deps, { principalId: actor.id, action: change[0], resource: change[1], scopeLabel: scope });
    return { ok: true };
  },
};
