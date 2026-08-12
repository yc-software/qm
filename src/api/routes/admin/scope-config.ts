import { parseScopeId } from "../../../types.ts";
import { encodeRef, serviceCredRef } from "../../../acl/resource-ref.ts";
import { computeRetention } from "../../../admin/retention.ts";
import {
  HARNESS_IDS,
  SELECTABLE_BASE_MODELS,
  defaultModelForHarness,
  modelProviderAvailabilityFor,
  modelServiceable,
  ALL_PROVIDERS_AVAILABLE,
  resolveModel,
} from "../../../model/pi-models.ts";
import {
  builtInModelCatalog,
  selectableCatalogForHarness,
  selectableModelCatalog,
  type ModelCatalogEntry,
} from "../../../model/model-catalog.ts";
import { sendJson } from "../../http.ts";
import { adminActorFrom, audit, authorizeAdmin, orgScope } from "../shared.ts";
import { ADMIN_RESOURCES, ADMIN_RESOURCE_BY_ID, adminResourceManifest } from "../admin-resources.ts";
import { type ApiCtx } from "../route.ts";
import {
  composePolicy,
  defaultOrgPolicy,
  evaluateCommand,
  parseCommandPolicy,
} from "../../../policy/command-policy.ts";
import { isHostDenied } from "../../../resolution/egress-policy.ts";
import { discoverScopes } from "./common.ts";
import { sessionCategory } from "./origins.ts";

export async function putScopeConfig(ctx: ApiCtx): Promise<void> {
  const { res, deps, params, body } = ctx;
  if (!deps.config) return sendJson(res, 404, { error: "not_found" });
  const targetScope = params.scope!;
  const resource = params.resource!;

  const actor = await authorizeAdmin(ctx, targetScope);
  if (!actor) return;
  const withScopeMutationLock = async <T>(fn: () => Promise<T>): Promise<T> =>
    deps.advisoryLock ? deps.advisoryLock.withLock(`admin-governance:${targetScope}`, fn) : fn();

  if (resource === "command-policy-simulate") {
    const command = (body as { command?: unknown }).command;
    if (typeof command !== "string" || !command.trim())
      return sendJson(res, 400, { error: "bad_request", message: "command is required" });
    const supplied = (body as { policy?: unknown }).policy;
    const parsed = supplied === undefined ? null : parseCommandPolicy(supplied);
    if (parsed && "error" in parsed) return sendJson(res, 400, { error: "bad_request", message: parsed.error });
    const targetKind = parseScopeId(targetScope).kind;
    const target =
      parsed?.policy ??
      deps.config.getCommandPolicy(targetScope) ??
      (targetKind === "org" ? defaultOrgPolicy() : { mode: "denylist" as const, rules: [] });
    const orgPolicy = deps.config.getCommandPolicy(orgScope(deps)) ?? defaultOrgPolicy();
    const effective = targetKind === "org" ? target : composePolicy(orgPolicy, target);
    const result = evaluateCommand(command, effective);
    const effectiveRuleIndex = result.approvalKey
      ? effective.rules.findIndex((rule) => rule.pattern === result.approvalKey)
      : -1;
    const orgRuleCount = targetKind === "org" ? 0 : orgPolicy.rules.length;
    let ruleSource: "organization" | "scope" | null = null;
    if (effectiveRuleIndex >= 0) ruleSource = effectiveRuleIndex < orgRuleCount ? "organization" : "scope";
    const ruleIndex = effectiveRuleIndex < 0 ? null : effectiveRuleIndex - (ruleSource === "scope" ? orgRuleCount : 0);
    audit(deps, {
      principalId: actor.id,
      action: "command-policy.simulate",
      resource: "command-policy",
      scopeLabel: targetScope,
    });
    return sendJson(res, 200, {
      ok: true,
      decision: result.decision,
      reason: result.reason ?? null,
      matched: result.matched ?? null,
      ruleSource,
      ruleIndex,
      deploymentRulesEvaluated: false,
    });
  }

  const desc = ADMIN_RESOURCE_BY_ID.get(resource);
  if (!desc) return sendJson(res, 404, { error: "not_found", message: `unknown admin resource: ${resource}` });
  return withScopeMutationLock(async () => {
    try {
      const result = await desc.apply(ctx, actor, targetScope);
      if ("error" in result) {
        return sendJson(res, result.status ?? 400, { error: result.code ?? "bad_request", message: result.error });
      }
      await deps.config!.flushScope(targetScope);
    } catch (err) {
      await deps.config!.refreshScope(targetScope);
      throw err;
    }
    audit(deps, { principalId: actor.id, action: `${resource}.update`, resource, scopeLabel: targetScope });
    return sendJson(res, 200, { ok: true, scopeId: targetScope, resource });
  });
}

export async function getAdminResources(ctx: ApiCtx): Promise<void> {
  const { res, deps } = ctx;
  const scope = orgScope(deps);
  const actor = await authorizeAdmin(ctx, scope);
  if (!actor) return;
  audit(deps, { principalId: actor.id, action: "resources.read", resource: "resources", scopeLabel: scope });
  return sendJson(res, 200, { resources: adminResourceManifest() });
}

export async function whoami(ctx: ApiCtx): Promise<void> {
  const { res, deps } = ctx;
  if (!deps.admin) return sendJson(res, 404, { error: "not_found" });
  const actor = adminActorFrom(ctx);
  if (!actor) return sendJson(res, 200, { isAdmin: false, permissions: [] });
  const status = await deps.admin.adminStatusOf(actor);
  const permissions = status.isAdmin ? ["admin"] : [];
  audit(deps, {
    principalId: actor.id,
    action: "admin.whoami",
    resource: "whoami",
    scopeLabel: status.scopeId ?? actor.id,
  });
  return sendJson(res, 200, { ...status, permissions });
}

export async function listAdminScopes(ctx: ApiCtx): Promise<void> {
  const { res, app, deps } = ctx;
  const scope = orgScope(deps);
  const actor = await authorizeAdmin(ctx, scope);
  if (!actor) return;
  audit(deps, { principalId: actor.id, action: "scopes.read", resource: "scopes", scopeLabel: scope });
  const crons = await app.listCrons();
  const deployments = await app.listDeployments();
  const skills = await app.listSkills();
  const environmentRows = await app.listEnvironments();
  const environments = environmentRows.map(({ environment, attachments }) => ({
    id: environment.id,
    name: environment.name,
    ownerActorId: environment.ownerActorId,
    attachedScopes: attachments.map((attachment) => attachment.scopeId).sort(),
  }));
  const environmentById = new Map(environments.map((environment) => [environment.id, environment]));
  const attachmentByScope = new Map(
    environments.flatMap((environment) =>
      environment.attachedScopes.map((attachedScope) => [attachedScope, environment] as const),
    ),
  );
  const owners = [
    ...crons.map((c) => c.ownerScopeId),
    ...deployments.map((d) => d.ownerScopeId),
    ...skills.map((s) => s.scopeId),
    ...environments.map((environment) => environment.id),
    ...environments.flatMap((environment) => environment.attachedScopes),
  ];
  const labels = await discoverScopes(app, deps, owners);
  const countBy = (ids: string[]): Map<string, number> => {
    const m = new Map<string, number>();
    for (const id of ids) m.set(id, (m.get(id) ?? 0) + 1);
    return m;
  };
  const summaries = (await deps.sessions?.scopeSessionSummaries(scope, true, undefined, false)) ?? [];
  const conversationSummaries = summaries.filter((s) => sessionCategory(s) === "conversation");
  const backgroundSummaries = summaries.filter((s) => sessionCategory(s) === "background");
  const sessionN = countBy(conversationSummaries.map((s) => s.scopeId));
  const backgroundN = countBy(backgroundSummaries.map((s) => s.scopeId));
  const lastActivityBy = new Map<string, number>();
  for (const s of summaries)
    lastActivityBy.set(s.scopeId, Math.max(lastActivityBy.get(s.scopeId) ?? 0, s.lastActivity));
  const lastConversationBy = new Map<string, number>();
  const winnerBy = new Map<string, { at: number; sessionId: string }>();
  for (const s of conversationSummaries) {
    lastConversationBy.set(s.scopeId, Math.max(lastConversationBy.get(s.scopeId) ?? 0, s.lastActivity));
    if (s.turns > 0) {
      const prev = winnerBy.get(s.scopeId);
      if (!prev || s.lastActivity > prev.at) winnerBy.set(s.scopeId, { at: s.lastActivity, sessionId: s.id });
    }
  }
  const previews =
    (await deps.sessions?.lastUserMessages([...winnerBy.values()].map((w) => w.sessionId))) ??
    new Map<string, string>();
  const lastMessageBy = new Map<string, string>();
  for (const [scopeId, w] of winnerBy) {
    const text = previews.get(w.sessionId);
    if (text) lastMessageBy.set(scopeId, text);
  }
  const cronN = countBy(crons.map((c) => c.ownerScopeId));
  const deployN = countBy(deployments.map((d) => d.ownerScopeId));
  const skillN = countBy(skills.map((s) => s.scopeId));
  const scopes = [...labels].map(([id, label]) => {
    const environment = environmentById.get(id);
    const attachment = attachmentByScope.get(id);
    return {
      scopeId: id,
      ...(label ? { label } : {}),
      ...(environment?.name ? { environmentName: environment.name } : {}),
      ...(attachment
        ? {
            environmentAttachment: {
              environmentId: attachment.id,
              environmentName: attachment.name,
            },
          }
        : {}),
      sessions: sessionN.get(id) ?? 0,
      backgroundSessions: backgroundN.get(id) ?? 0,
      lastActivity: lastActivityBy.get(id) ?? 0,
      lastConversationActivity: lastConversationBy.get(id) ?? 0,
      lastMessage: lastMessageBy.get(id) ?? "",
      crons: cronN.get(id) ?? 0,
      deployments: deployN.get(id) ?? 0,
      skills: skillN.get(id) ?? 0,
    };
  });
  scopes.sort(
    (a, b) =>
      b.lastActivity - a.lastActivity ||
      b.sessions - a.sessions ||
      b.backgroundSessions - a.backgroundSessions ||
      a.scopeId.localeCompare(b.scopeId),
  );
  return sendJson(res, 200, { scopeId: scope, scopes, environments });
}

interface ScopeEnvironmentMetadata {
  environment?: { id: string; name: string; ownerActorId: string | null };
  environmentAttachment?: { environmentId: string; environmentName: string | null };
}

async function scopeEnvironmentMetadata(deps: ApiCtx["deps"], targetScope: string): Promise<ScopeEnvironmentMetadata> {
  const store = deps.environments;
  if (!store) return {};

  const [environment, attachment] = await Promise.all([store.get(targetScope), store.getAttachment(targetScope)]);
  const metadata: ScopeEnvironmentMetadata = {};
  if (environment?.name) {
    metadata.environment = {
      id: environment.id,
      name: environment.name,
      ownerActorId: environment.ownerActorId,
    };
  }
  if (attachment) {
    const attachedEnvironment = await store.get(attachment.environmentId);
    metadata.environmentAttachment = {
      environmentId: attachment.environmentId,
      environmentName: attachedEnvironment?.name ?? null,
    };
  }
  return metadata;
}

export async function getScopeConfig(ctx: ApiCtx): Promise<void> {
  const { res, deps, params } = ctx;
  if (!deps.config) return sendJson(res, 404, { error: "not_found" });
  const targetScope = params.scope!;
  if (!targetScope || targetScope.includes("/")) return sendJson(res, 404, { error: "not_found" });
  const actor = await authorizeAdmin(ctx, targetScope);
  if (!actor) return;
  await deps.config.refreshScope(targetScope);
  audit(deps, { principalId: actor.id, action: "config.read", resource: "config", scopeLabel: targetScope });
  const environmentMetadata = await scopeEnvironmentMetadata(deps, targetScope);
  const serviceCredentials = await Promise.all(
    (deps.serviceCreds ? await deps.serviceCreds.listServiceCredentials(targetScope) : []).map(async (c) => {
      const usage = (await deps.credentialUsage?.list({ slug: c.slug, limit: 5000 })) ?? [];
      const successful = usage.filter((u) => u.status === "ok");
      return {
        ...c,
        grantees: deps.acl
          ? (await deps.acl.grantsFor(targetScope, encodeRef(serviceCredRef(c.slug)))).map((g) => g.granteeScopeId)
          : [],
        usageCount: successful.length,
        usageTruncated: usage.length === 5000,
        usageSince: successful.length ? Math.min(...successful.map((u) => u.ts)) : null,
        lastUsedAt: successful.length ? Math.max(...successful.map((u) => u.ts)) : null,
        recentUsagePrincipals: [...new Set(successful.map((u) => u.principalId))].slice(0, 12),
      };
    }),
  );
  const values: Record<string, unknown> = {};
  for (const r of ADMIN_RESOURCES) {
    if (r.readKey && r.get) values[r.readKey] = await r.get(deps, targetScope);
  }
  const declaredEgress = deps.egressDeclaredEnforcement ?? deps.egressEnforcement ?? "none";
  const effectiveEgressFidelity = deps.egressEnforcement ?? "none";
  let egressReason = "ready";
  if (declaredEgress !== "domain") egressReason = "backend_unsupported";
  else if (effectiveEgressFidelity !== "domain") egressReason = "control_plane_unconfigured";
  const orgEgress = deps.config.getEgress(orgScope(deps));
  const targetEgress = deps.config.getEgress(targetScope);
  const effectiveEgressPolicy = {
    deniedHosts: [...new Set([...(orgEgress?.deniedHosts ?? []), ...(targetEgress?.deniedHosts ?? [])])],
    allowedHosts: [] as string[],
  };
  effectiveEgressPolicy.allowedHosts = [
    ...new Set([...(orgEgress?.allowedHosts ?? []), ...(targetEgress?.allowedHosts ?? [])]),
  ].filter((host) => !isHostDenied(host, effectiveEgressPolicy.deniedHosts));
  const configuredKeys = deps.providerKeys ?? ALL_PROVIDERS_AVAILABLE;
  const managedKeys = deps.modelCredentials ? await deps.modelCredentials.availability() : configuredKeys;
  const providersFor = (harnessId: string) => modelProviderAvailabilityFor(harnessId, configuredKeys, managedKeys);
  const catalog =
    deps.modelCredentials && managedKeys.openrouter
      ? await selectableModelCatalog(deps.modelCredentialFetch)
      : builtInModelCatalog();
  const runtime = values.runtime as { harnessId?: unknown; modelId?: unknown } | null | undefined;
  const resolvedCurrent = runtime && typeof runtime.modelId === "string" ? resolveModel(runtime.modelId) : null;
  const currentProvider = resolvedCurrent?.provider;
  const currentModel =
    runtime &&
    typeof runtime.modelId === "string" &&
    (currentProvider === "anthropic" || currentProvider === "openai" || currentProvider === "openrouter")
      ? ({ id: runtime.modelId, name: resolvedCurrent!.name, provider: currentProvider } satisfies ModelCatalogEntry)
      : null;
  const modelsFor = (harnessId: string) => {
    const models = selectableCatalogForHarness(catalog, harnessId);
    if (currentModel && runtime?.harnessId === harnessId && !models.some((model) => model.id === currentModel.id))
      models.push(currentModel);
    return models.filter((model) => modelServiceable(model.id, providersFor(harnessId)));
  };
  return sendJson(res, 200, {
    scopeId: targetScope,
    ...environmentMetadata,
    ...values,
    soulVersion: deps.config.soulVersion(targetScope),
    soulHistory: deps.config.soulHistory(targetScope),
    directoryMembers: parseScopeId(targetScope).kind === "org" ? ((await deps.directory?.list()) ?? []) : [],
    baseModelDefault: defaultModelForHarness(deps.harnessId ?? "pi", deps.baseModelDefault),
    baseModelOptions: modelsFor(deps.harnessId ?? "pi"),
    harnessDefault: deps.harnessId ?? "pi",
    harnessOptions: HARNESS_IDS.filter((id) => id !== "mock"),
    modelsByHarness: Object.fromEntries(HARNESS_IDS.map((id) => [id, modelsFor(id)])),
    browseModelOptions: SELECTABLE_BASE_MODELS.filter((m) =>
      modelServiceable(m.id, providersFor(deps.harnessId ?? "pi")),
    ),
    egressEnforcement: {
      backend: deps.sandboxBackend ?? "unknown",
      declaredFidelity: declaredEgress,
      effectiveFidelity: effectiveEgressFidelity,
      fidelity: effectiveEgressFidelity,
      active: effectiveEgressFidelity === "domain",
      reason: egressReason,
    },
    egressEffective: effectiveEgressPolicy,
    serviceCredentials,
  });
}

export async function retention(ctx: ApiCtx): Promise<void> {
  const { res, deps, url } = ctx;
  const scope = url.searchParams.get("scope") ?? orgScope(deps);
  if (parseScopeId(scope).kind !== "org") {
    return sendJson(res, 400, { error: "bad_request", message: "retention is org-wide; request an org scope" });
  }
  const actor = await authorizeAdmin(ctx, scope);
  if (!actor) return;
  audit(deps, { principalId: actor.id, action: "retention.read", resource: "retention", scopeLabel: scope });
  const sessions = (await deps.sessions?.listAll()) ?? [];
  const participants = (await deps.sessions?.listParticipants()) ?? [];
  const turns = (await deps.sessions?.attributedTurns()) ?? [];
  const report = computeRetention({ sessions, participants, turns, nowMs: Date.now() });
  return sendJson(res, 200, { scopeId: scope, ...report });
}
