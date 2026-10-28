import type { TeamChange } from "../../teams/teams.ts";
import { decisionCatalog, parseDecisionProvider, parseDecisionRule } from "../../decisions/decisions.ts";
import { parseAckEmoji } from "../../slack/config.ts";
import type { ConfiguredDeps } from "../deps.ts";
import type { ConfiguredCtx } from "./route.ts";
import { parseCommandPolicy } from "../../policy/command-policy.ts";
import { parseScopeId, type ScopeId } from "../../types.ts";
import {
  defaultModel,
  fastModeModelIds,
  modelSupported,
  modelServiceable,
  resolveModel,
  resolveEmbeddingModel,
  embeddingModelCatalog,
  thinkingLevelsFor,
  selectableBaseModels,
} from "../../model/pi-models.ts";
import { resolveRuntimeChoiceDurable } from "../../harness/runtime-choice.ts";
import { sanitizeBranding } from "../../resolution/branding.ts";
import { checkChannelSettings } from "./context-policy.ts";
import { authorizeUrl, PROVIDERS, type ConsentMode } from "../../connectors/oauth.ts";
import { resolverFor } from "./connectors.ts";
import { errMessage, swallowAs } from "../../util/errors.ts";
import { isBackendFailure } from "../http.ts";
import { DEFAULT_SECURITY_SCREEN_RUBRIC } from "../../security/security-screen.ts";
import type { ApprovalGrantModes } from "../../types.ts";
import { parseEgressPolicy } from "../../resolution/egress-policy.ts";
import { FEATURE_NAMES, FEATURES, type FeatureName } from "../../feature-flags.ts";
import { tenant } from "../../tenant.ts";
import { SCOPE_SETTINGS, type ScopeSettingName, type ScopeSettingValue } from "../../resolution/config-store.ts";
import { auditAs, modelKeys, orgOnly } from "./admin/common.ts";
import { applyServiceCredentials } from "./admin-service-credentials.ts";

interface AutoFlaggerDraft {
  modelId: string;
  rubric: string;
}

const AUTO_FLAGGER_MAX_RUBRIC_CHARS = 20_000;

export function defaultAutoFlaggerConfig(deps: Pick<ConfiguredDeps, "baseModelDefault">): AutoFlaggerDraft {
  return { modelId: defaultModel(deps.baseModelDefault), rubric: DEFAULT_SECURITY_SCREEN_RUBRIC };
}

async function parseAutoFlaggerDraft(
  deps: Pick<ConfiguredDeps, "providerKeys" | "modelCredentials">,
  body: { modelId?: unknown; rubric?: unknown },
): Promise<{ value: AutoFlaggerDraft } | { error: string }> {
  if (typeof body.modelId !== "string" || !body.modelId.trim()) return { error: "auto-flagger requires a modelId" };
  const modelId = body.modelId.trim();
  if (!modelSupported(modelId)) return { error: `model ${modelId} is not supported` };
  if (typeof body.rubric !== "string" || !body.rubric.trim() || body.rubric.length > AUTO_FLAGGER_MAX_RUBRIC_CHARS) {
    return {
      error: `auto-flagger requires a non-empty rubric of at most ${AUTO_FLAGGER_MAX_RUBRIC_CHARS} characters`,
    };
  }
  if (!modelServiceable(modelId, await modelKeys(deps)))
    return { error: `model ${modelId} isn't serviceable on this deployment` };
  return { value: { modelId, rubric: body.rubric.trim() } };
}

export type Actor = { id: string };

type AdminResourceKind = "boolean" | "string" | "text" | "string-list" | "enum" | "secret" | "custom";

export type ApplyResult = { ok: true } | { error: string; code?: string; status?: number };

export interface AdminResource {
  id: string;
  kind: AdminResourceKind;
  readKey?: string;
  get?: (deps: ConfiguredDeps, scope: string) => unknown | Promise<unknown>;
  apply: (ctx: ConfiguredCtx, actor: Actor, scope: string) => Promise<ApplyResult>;
  target?: "org" | "any";
  secret?: boolean;
  clearable?: boolean;
  label?: string;
  enumValues?: readonly unknown[];
  refreshesModels?: true;
}

function generic<V>(
  parse: (body: unknown) => { value: V } | { error: string },
  set: (deps: ConfiguredDeps, scope: string, value: V) => Promise<void>,
): AdminResource["apply"] {
  return async (ctx, _actor, scope) => {
    const parsed = parse(ctx.body);
    if ("error" in parsed) return parsed;
    await set(ctx.deps, scope, parsed.value);
    return { ok: true };
  };
}

const orgWide =
  (label: string, apply: AdminResource["apply"]): AdminResource["apply"] =>
  async (ctx, actor, scope) =>
    orgOnly(scope, label) ?? apply(ctx, actor, scope);

const unserviceable = async (deps: ConfiguredDeps, modelId: string): Promise<{ error: string } | null> =>
  modelServiceable(modelId, await modelKeys(deps))
    ? null
    : { error: `model ${modelId} isn't serviceable on this deployment: its provider key is not configured` };

type Parsed<V> = { value: V } | { error: string };

/** An admin resource over one per-scope setting: reads and writes go through the store, the target comes from SCOPE_SETTINGS. */
function settingResource<K extends ScopeSettingName>(
  name: K,
  resource: Omit<AdminResource, "get" | "apply" | "target"> & {
    /** The error for a non-org scope; required when the setting's target is "org". */
    orgWide?: string;
    /** Read only at the org scope. */
    orgRead?: true;
    parse: (
      body: unknown,
      deps: ConfiguredDeps,
    ) => Parsed<ScopeSettingValue<K> | null> | Promise<Parsed<ScopeSettingValue<K> | null>>;
  },
): AdminResource {
  const { orgWide: scopeLabel, orgRead, parse } = resource;
  const { target, orgOnly } = SCOPE_SETTINGS[name];
  const get = (deps: ConfiguredDeps, scope: string) => deps.config.setting(name, orgOnly ? undefined : scope);
  const apply: AdminResource["apply"] = async (ctx, _actor, scope) => {
    const parsed = await parse(ctx.body, ctx.deps);
    if ("error" in parsed) return parsed;
    await ctx.deps.config.setSetting(name, parsed.value, orgOnly ? undefined : scope);
    return { ok: true };
  };
  // Copy descriptors rather than spreading so a live `get enumValues()` stays live.
  const { orgWide: _o, orgRead: _r, parse: _p, ...props } = Object.getOwnPropertyDescriptors(resource);
  return Object.defineProperties(
    {
      readKey: name,
      ...(target === "org" ? { target } : {}),
      get: orgRead ? orgScopeOnly(get) : get,
      apply: scopeLabel ? orgWide(scopeLabel, apply) : apply,
    } as AdminResource,
    props,
  );
}

const orgScopeOnly =
  <T>(get: (deps: ConfiguredDeps, scope: string) => T) =>
  (deps: ConfiguredDeps, scope: string) =>
    parseScopeId(scope).kind === "org" ? get(deps, scope) : undefined;

const boolBody = (body: unknown): { value: boolean } => ({ value: !!(body as { on?: unknown }).on });

function channelContainer(scope: string): string | undefined {
  const { kind, ref } = parseScopeId(scope);
  return ref && (kind === "channel" || kind === "group") ? ref : undefined;
}

export const ADMIN_RESOURCES: readonly AdminResource[] = [
  settingResource("autoFlagger", {
    id: "auto-flagger",
    refreshesModels: true,
    kind: "custom",
    clearable: true,
    label: "The model and classification rubric used to screen external content.",
    orgWide: "the Auto flagger is org-wide",
    parse: (body, deps) =>
      (body as { reset?: unknown }).reset === true
        ? { value: null }
        : parseAutoFlaggerDraft(deps, body as Record<string, unknown>),
  }),
  {
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
    apply: orgWide("decisions are org-wide", async (ctx, actor, scope) => {
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
        if (isBackendFailure(error)) throw error;
        return { error: errMessage(error) };
      }
      auditAs(ctx.deps, actor.id, change[0], change[1], scope);
      return { ok: true };
    }),
  },
  {
    id: "approval-grant-modes",
    kind: "custom",
    target: "any",
    label:
      'Which standing HiLO approval options are offered: "Allow session" and "Allow always". Composes tighten-only with the org value; disabling a mode also suspends existing grants of that mode until re-enabled.',
    readKey: "approvalGrantModes",
    get: (deps, scope) => deps.config.getApprovalGrantModesDurable(scope),
    apply: generic<ApprovalGrantModes>(
      (body) => {
        const b = body as { session?: unknown; always?: unknown };
        if (typeof b.session !== "boolean" || typeof b.always !== "boolean")
          return { error: "approval-grant-modes requires { session: boolean, always: boolean }" };
        return { value: { session: b.session, always: b.always } };
      },
      (deps, scope, modes) => deps.config.setApprovalGrantModes(scope, modes),
    ),
  },
  settingResource("commandPolicy", {
    id: "command-policy",
    kind: "custom",
    parse: (body) => {
      const p = parseCommandPolicy(body);
      return "error" in p ? { error: p.error } : { value: p.policy };
    },
  }),
  {
    id: "instructions",
    kind: "text",
    readKey: "instructions",
    get: (deps, scope) => deps.config.getInstructions(scope),
    apply: async (ctx, actor, scope) => {
      const body = ctx.body as { content?: unknown; expectedVersion?: unknown };
      if (typeof body.content !== "string") return { error: "instructions requires { content: string }" };
      if (body.expectedVersion === undefined) {
        await ctx.deps.config.setInstructions(scope, body.content, actor.id);
        return { ok: true };
      }
      if (typeof body.expectedVersion !== "number")
        return { error: "expectedVersion must be a number", code: "bad_version" };
      const version = await ctx.deps.config.setInstructionsIfVersion(
        scope,
        body.expectedVersion,
        body.content,
        actor.id,
      );
      if (version === null) {
        return {
          error: "Instructions changed after this draft was loaded. Reload before saving.",
          code: "version_conflict",
          status: 409,
        };
      }
      return { ok: true };
    },
  },
  {
    id: "ambient-policy",
    kind: "custom",
    readKey: "ambientPolicy",
    get: async (deps, scope) => {
      const ref = channelContainer(scope);
      if (!deps.channelPolicy || !ref) return undefined;
      const p = await deps.channelPolicy.get(ref).catch(swallowAs("admin: read channel ambient policy", undefined));
      if (p === undefined) return undefined;
      return {
        bots: p?.bots ?? {},
        ambientEnabled: p?.ambientEnabled ?? null,
        updatedAt: p?.updatedAt ?? 0,
      };
    },
    apply: async (ctx, actor, scope) => {
      const deps = ctx.deps;
      if (!deps.channelPolicy) return { error: "not available on this deployment", status: 404 };
      const ref = channelContainer(scope);
      if (!ref) return { error: "ambient policy applies to channel and group scopes only" };
      const b = (ctx.body ?? {}) as {
        bots?: unknown;
        ambientEnabled?: unknown;
        baseUpdatedAt?: unknown;
      };
      const settings = await checkChannelSettings(deps.channelPolicy, ref, b);
      if ("message" in settings)
        return settings.status === 409
          ? { error: settings.message, code: "conflict", status: 409 }
          : { error: settings.message };
      await deps.channelPolicy.set(ref, { setBy: actor.id, ...settings });
      auditAs(ctx.deps, actor.id, "surface.policy.set", ref, scope);
      return { ok: true };
    },
  },
  settingResource("egress", {
    id: "egress",
    kind: "custom",
    parse: (body) => {
      const parsed = parseEgressPolicy(body);
      return "error" in parsed ? parsed : { value: parsed.policy };
    },
  }),
  {
    id: "feature-flags",
    kind: "custom",
    target: "org",
    readKey: "featureFlags",
    label: "Live feature rollout table. Each feature maps to the scopes where it is enabled.",
    get: async (deps) => {
      if (!deps.featureFlags) return undefined;
      const rows = await deps.featureFlags.list();
      return FEATURE_NAMES.map((featureName) => ({
        ...FEATURES[featureName],
        ...(rows.find((row) => row.featureName === featureName) ?? { featureName, enabledScopes: [] }),
      }));
    },
    apply: async (ctx, actor, scope) => {
      if (!ctx.deps.featureFlags) return { error: "not available on this deployment", status: 404 };
      const body = (ctx.body ?? {}) as { featureName?: unknown; scopeId?: unknown; on?: unknown };
      if (typeof body.featureName !== "string" || !(FEATURE_NAMES as readonly string[]).includes(body.featureName))
        return { error: `feature-flags requires featureName: ${FEATURE_NAMES.join(" | ")}` };
      if (typeof body.scopeId !== "string" || !body.scopeId.trim()) return { error: "feature-flags requires scopeId" };
      const before = await ctx.deps.featureFlags.enabled(body.featureName as FeatureName, body.scopeId as ScopeId);
      await ctx.deps.featureFlags.setEnabled(
        body.featureName as FeatureName,
        body.scopeId as ScopeId,
        body.on === true,
        actor.id,
      );
      auditAs(
        ctx.deps,
        actor.id,
        "feature-flag.update",
        `${body.featureName}:${body.scopeId}:${before}->${body.on === true}`,
        scope,
      );
      return { ok: true };
    },
  },
  {
    id: "teams",
    kind: "custom",
    target: "org",
    readKey: "teams",
    label:
      "Teams. Each team is a team:<id> scope shared by its members. Send { id, name?, isolatedInOpen?, addMembers?, addAdmins?, drop?, addRooms?, dropRooms? } or { id, remove: true }. Rooms are channel or group scopes where the team stays available; isolatedInOpen keeps it isolated when the org posture is Open.",
    get: (deps) => deps.teams?.list(),
    apply: async (ctx, actor, scope) => {
      if (!ctx.deps.teams) return { error: "not available on this deployment", status: 404 };
      const change = parseTeamChange(ctx.body);
      if ("error" in change) return change;
      await ctx.deps.teams.apply(change, actor.id);
      auditAs(ctx.deps, actor.id, change.remove ? "team.remove" : "team.update", `team:${change.id}`, scope);
      return { ok: true };
    },
  },
  settingResource("unfulfilledInsights", { id: "unfulfilled-insights", kind: "boolean", parse: boolBody }),
  settingResource("externalSlackParticipants", {
    id: "external-slack-participants",
    kind: "boolean",
    label:
      "Supports external Slack participants: internal members may chat with the agent in Slack rooms whose audience includes an external user (Connect member or guest). Externals themselves still can't interact.",
    orgWide: "the external-Slack-participants toggle is org-wide",
    parse: boolBody,
  }),
  settingResource("channelHeaderPin", {
    id: "channel-header-pin-default",
    kind: "boolean",
    readKey: "channelHeaderPinDefault",
    label:
      "Channel pinned-header default: on means the agent posts and pins its header message (naming the model in use) in every Slack channel unless a channel explicitly turns it off.",
    orgWide: "the channel pinned-header default is org-wide",
    orgRead: true,
    parse: boolBody,
  }),
  settingResource("orgAmbient", {
    id: "org-ambient",
    kind: "boolean",
    label:
      "Ambient behavior org-wide: off means the agent never acts on overheard messages anywhere, regardless of per-channel settings.",
    orgWide: "the ambient switch here is org-wide",
    orgRead: true,
    parse: boolBody,
  }),
  settingResource("interactiveFastMode", {
    id: "interactive-fast-mode",
    kind: "boolean",
    label:
      "Fast mode for interactive turns org-wide: on means human turns run in fast mode on fast-capable models unless the turn asks otherwise. Requires fast-mode quota with the provider.",
    orgWide: "the interactive fast-mode switch is org-wide",
    orgRead: true,
    parse: boolBody,
  }),
  settingResource("individualModelAuth", {
    id: "individual-model-auth",
    kind: "boolean",
    label:
      "Individual authorization for AI usage org-wide: on means each user must connect their own Claude or Codex account (API key or subscription login) before using the assistant; the org's shared model credentials are not used for their turns.",
    orgWide: "the individual-authorization switch is org-wide",
    orgRead: true,
    parse: boolBody,
  }),
  {
    id: "memory-embedding-model",
    refreshesModels: true,
    kind: "enum",
    target: "org",
    clearable: true,
    readKey: "memoryEmbeddingModel",
    get enumValues() {
      return embeddingModelCatalog();
    },
    get: (deps) => deps.config.getEmbeddingModelDurable(),
    apply: orgWide("the memory embedding model is org-wide", async (ctx) => {
      const { modelId } = ctx.body as { modelId?: unknown };
      if (modelId !== null && (typeof modelId !== "string" || !modelId.trim()))
        return { error: "Provide an embedding modelId, or null to disable semantic recall" };
      if (modelId !== null && !resolveEmbeddingModel(modelId)) return { error: "Unknown embedding model" };
      await ctx.deps.config.setEmbeddingModel(modelId as string | null);
      return { ok: true };
    }),
  },
  {
    id: "base-model",
    refreshesModels: true,
    kind: "enum",
    target: "any",
    clearable: true,
    readKey: "baseModel",
    get enumValues() {
      return selectableBaseModels();
    },
    get: (deps, scope) => deps.config.getRuntimeSelection(scope)?.modelId ?? null,
    apply: async (ctx, _actor, scope) => {
      const raw = (ctx.body as { modelId?: unknown }).modelId;
      if (raw !== undefined && raw !== null && typeof raw !== "string")
        return { error: "base-model requires { modelId: string } (empty string clears the override)" };
      const modelId = typeof raw === "string" ? raw.trim() : "";
      if (modelId && !resolveModel(modelId)) return { error: `unknown model id: ${modelId}` };
      const runtime = await ctx.deps.config.getRuntimeSelectionDurable(scope);
      if (!modelId) await ctx.deps.config.setRuntimeSelection(scope, null);
      else {
        if (!modelSupported(modelId)) return { error: `model ${modelId} is not supported` };
        const unavailable = await unserviceable(ctx.deps, modelId);
        if (unavailable) return unavailable;
        const current =
          runtime ??
          (await resolveRuntimeChoiceDurable(ctx.deps.config, tenant().orgScope, scope, {
            modelId: defaultModel(ctx.deps.baseModelDefault),
          }));
        await ctx.deps.config.setRuntimeSelection(scope, {
          modelId,
          ...(current.effortLevel ? { effortLevel: current.effortLevel } : {}),
          ...(typeof current.fastMode === "boolean"
            ? { fastMode: current.fastMode && fastModeModelIds().includes(modelId) }
            : {}),
        });
      }
      return { ok: true };
    },
  },
  ...([undefined, "cron", "subagent", "fallback"] as const).map((purpose): AdminResource => ({
    id: purpose ? `${purpose}-runtime` : "runtime",
    refreshesModels: true,
    kind: "custom",
    target: purpose ? "org" : "any",
    clearable: true,
    readKey: purpose ? `${purpose}Runtime` : "runtime",
    get: async (deps, scope) =>
      purpose
        ? ((await deps.config.getPurposeRuntimeDurable(purpose)) ?? null)
        : deps.config.getRuntimeSelection(scope),
    apply: async (ctx, _actor, scope) => {
      const bad = purpose && orgOnly(scope, `${purpose} runtime defaults are org-wide`);
      if (bad) return bad;
      if ((ctx.body as { inherit?: unknown } | null)?.inherit === true || (purpose && ctx.body === null)) {
        if (purpose) await ctx.deps.config.clearPurposeRuntime(purpose);
        else await ctx.deps.config.setRuntimeSelection(scope, null);
        return { ok: true };
      }
      const modelId = (ctx.body as { modelId?: unknown }).modelId;
      const effortLevel = (ctx.body as { effortLevel?: unknown }).effortLevel ?? (purpose ? undefined : "auto");
      const fastMode = (ctx.body as { fastMode?: unknown }).fastMode ?? (purpose ? undefined : false);
      if (typeof modelId !== "string" || !modelSupported(modelId))
        return { error: `model ${String(modelId)} is not supported` };
      const thinkingLevels = thinkingLevelsFor(modelId);
      if (effortLevel !== undefined && (typeof effortLevel !== "string" || !thinkingLevels.includes(effortLevel)))
        return { error: `runtime requires effortLevel (${thinkingLevels.join(" | ")}) for ${modelId}` };
      if (fastMode !== undefined && typeof fastMode !== "boolean")
        return { error: "runtime requires fastMode (boolean)" };
      if (purpose && fastMode === true && !fastModeModelIds().includes(modelId))
        return { error: `fast mode is not supported by ${modelId}` };
      const unavailable = await unserviceable(ctx.deps, modelId);
      if (unavailable) return unavailable;
      const choice = {
        modelId,
        ...(typeof effortLevel === "string" ? { effortLevel } : {}),
        ...(typeof fastMode === "boolean" ? { fastMode: fastMode && fastModeModelIds().includes(modelId) } : {}),
      };
      if (purpose) await ctx.deps.config.setPurposeRuntime(purpose, choice);
      else await ctx.deps.config.setRuntimeSelection(scope, choice);
      return { ok: true };
    },
  })),
  settingResource("webuiModels", {
    id: "webui-models",
    refreshesModels: true,
    kind: "string-list",
    clearable: true,
    label:
      "Web UI model picker (ordered list of model ids; the org base model is the default selection, else the first). Empty restores the built-in set.",
    get enumValues() {
      return selectableBaseModels();
    },
    orgWide: "the web UI model picker is org-wide",
    parse: (body) => {
      const raw = (body as { ids?: unknown }).ids;
      if (raw !== undefined && raw !== null && !Array.isArray(raw))
        return { error: "webui-models requires { ids: string[] } (empty list restores the default picker)" };
      const ids = Array.isArray(raw) ? raw.map((v) => (typeof v === "string" ? v.trim() : "")).filter(Boolean) : [];
      for (const id of ids) if (!resolveModel(id)) return { error: `unknown model id: ${id}` };
      const seen = new Set<string>();
      const unique = ids.filter((id) => (seen.has(id) ? false : (seen.add(id), true)));
      return { value: unique.length ? unique : null };
    },
  }),
  settingResource("ackEmoji", {
    id: "ack-emoji",
    kind: "string-list",
    clearable: true,
    label:
      "Slack ack emoji (names the bot may react with to acknowledge a message). Empty restores the built-in rotation.",
    orgWide: "the ack emoji set is org-wide",
    parse: (body) => {
      const raw = (body as { names?: unknown }).names;
      if (raw !== undefined && raw !== null && !Array.isArray(raw))
        return { error: "ack-emoji requires { names: string[] } (empty list restores the default rotation)" };
      const input = Array.isArray(raw) ? raw.map((v) => (typeof v === "string" ? v : "")).join(",") : "";
      const names = parseAckEmoji(input);
      const supplied = Array.isArray(raw) ? raw.filter((v) => typeof v === "string" && v.trim()).length : 0;
      if (supplied && names.length !== supplied)
        return { error: "ack-emoji names must be Slack emoji names (lowercase letters, digits, _ + -)" };
      return { value: names.length ? names : null };
    },
  }),
  settingResource("branding", {
    id: "branding",
    kind: "custom",
    clearable: true,
    orgWide: "branding is org-wide",
    parse: (input) => {
      const body = (input ?? {}) as {
        accent?: unknown;
        mark?: unknown;
        markUrl?: unknown;
        selfLabel?: unknown;
        orgName?: unknown;
      };
      const accentInput = typeof body.accent === "string" ? body.accent.trim() : "";
      const markUrlInput = typeof body.markUrl === "string" ? body.markUrl.trim() : "";
      const value = sanitizeBranding(body);
      if (accentInput && !value?.accent) return { error: "branding accent must be a hex color (e.g. #4f46e5)" };
      if (markUrlInput && !value?.markUrl) return { error: "branding mark image must be an https URL" };
      return { value: value ?? null };
    },
  }),
  settingResource("browseModel", {
    id: "browse-model",
    refreshesModels: true,
    kind: "enum",
    clearable: true,
    label:
      "The model driving the browser agent in the browse skill, org-wide (empty follows the deployment's base model; fast mode applies only on Opus models).",
    get enumValues() {
      return selectableBaseModels();
    },
    orgWide: "the browse model is org-wide",
    parse: async (body, deps) => {
      const raw = (body as { modelId?: unknown }).modelId;
      if (raw !== undefined && raw !== null && typeof raw !== "string")
        return { error: "browse-model requires { modelId: string } (empty string clears the override)" };
      const modelId = typeof raw === "string" ? raw.trim() : "";
      if (modelId && !resolveModel(modelId)) return { error: `unknown model id: ${modelId}` };
      return (modelId ? await unserviceable(deps, modelId) : null) ?? { value: modelId || null };
    },
  }),
  settingResource("browseMaxSteps", {
    id: "browse-max-steps",
    kind: "string",
    clearable: true,
    label: "Max browser steps per browse task (empty restores the default of 50).",
    orgWide: "the browse step limit is org-wide",
    parse: (body) => {
      const raw = (body as { steps?: unknown }).steps;
      if (raw === undefined || raw === null || raw === "") return { value: null };
      let steps = NaN;
      if (typeof raw === "number") steps = raw;
      else if (typeof raw === "string") steps = Number(raw.trim());
      if (!Number.isInteger(steps) || steps < 1 || steps > 500)
        return { error: "browse-max-steps requires { steps: integer 1-500 } (empty clears to the default of 50)" };
      return { value: steps };
    },
  }),
  {
    id: "connectors",
    kind: "custom",
    readKey: "connectors",
    get: (deps, scope) => deps.config.listConnectorClients(scope),
    apply: async (ctx, actor, scope) => {
      const { deps } = ctx;
      const b = ctx.body as {
        provider?: unknown;
        clientId?: unknown;
        clientSecret?: unknown;
        scopes?: unknown;
        redirectAllowlist?: unknown;
        consentMode?: unknown;
        hostedDomain?: unknown;
        enabled?: unknown;
        delete?: unknown;
      };
      const provider = typeof b.provider === "string" ? b.provider : "";
      if (!PROVIDERS[provider]) return { error: `unknown OAuth provider: ${provider}` };
      if (b.delete === true) {
        await deps.config.deleteConnectorClient(scope, provider);
        return { ok: true };
      }
      if (typeof b.clientId !== "string" || typeof b.clientSecret !== "string")
        return { error: "connectors requires { provider, clientId, clientSecret }" };
      await deps.config.setConnectorClient(scope, provider, {
        clientId: b.clientId,
        clientSecret: b.clientSecret,
        ...(Array.isArray(b.scopes) ? { scopes: b.scopes.map(String) } : {}),
        ...(Array.isArray(b.redirectAllowlist) ? { redirectAllowlist: b.redirectAllowlist.map(String) } : {}),
        ...(typeof b.consentMode === "string" ? { consentMode: b.consentMode as ConsentMode } : {}),
        ...(typeof b.hostedDomain === "string" ? { hostedDomain: b.hostedDomain } : {}),
        ...(typeof b.enabled === "boolean" ? { enabled: b.enabled } : {}),
        updatedBy: actor.id,
      });
      try {
        const client = await resolverFor(deps)(provider, {});
        authorizeUrl(provider, {
          redirectUri: client.redirectAllowlist?.[0] ?? "https://example.invalid/cb",
          state: "dry-run",
          client,
        });
      } catch (e) {
        return { error: errMessage(e), code: "connector_invalid" };
      }
      return { ok: true };
    },
  },
  {
    id: "service-credentials",
    kind: "custom",
    target: "org",
    secret: true,
    apply: applyServiceCredentials,
  },
];

export const ADMIN_RESOURCE_BY_ID = new Map(ADMIN_RESOURCES.map((r) => [r.id, r]));

export function adminResourceManifest(): Pick<
  AdminResource,
  "id" | "kind" | "target" | "secret" | "clearable" | "label" | "enumValues"
>[] {
  return ADMIN_RESOURCES.map((r) => ({
    id: r.id,
    kind: r.kind,
    ...(r.target ? { target: r.target } : {}),
    ...(r.secret ? { secret: true } : {}),
    ...(r.clearable ? { clearable: true } : {}),
    ...(r.label ? { label: r.label } : {}),
    ...(r.enumValues ? { enumValues: r.enumValues } : {}),
  }));
}

const TEAM_ID = /^[a-z0-9][a-z0-9-]{0,62}$/;
const TEAM_LISTS = ["addMembers", "addAdmins", "drop", "addRooms", "dropRooms"] as const;

function parseTeamChange(body: unknown): TeamChange | { error: string } {
  const b = (body ?? {}) as Record<string, unknown>;
  if (typeof b.id !== "string" || !TEAM_ID.test(b.id))
    return { error: "teams requires id: lowercase letters, digits, -" };
  if (b.remove === true) return { id: b.id, remove: true };
  const lists: Partial<Record<(typeof TEAM_LISTS)[number], string[]>> = {};
  for (const key of TEAM_LISTS) {
    const v = b[key] ?? [];
    if (!Array.isArray(v) || !v.every((x) => typeof x === "string" && x.trim()))
      return { error: `${key} must be an array of non-empty strings` };
    lists[key] = [...new Set(v as string[])];
  }
  const isRoom = (r: string) => {
    const { kind, ref } = parseScopeId(r as ScopeId);
    return (kind === "channel" || kind === "group") && !!ref;
  };
  if (![...lists.addRooms!, ...lists.dropRooms!].every(isRoom))
    return { error: "rooms must be channel:<id> or group:<id> scopes" };
  return {
    id: b.id,
    ...(typeof b.name === "string" && b.name.trim() ? { name: b.name.trim() } : {}),
    ...(typeof b.isolatedInOpen === "boolean" ? { isolatedInOpen: b.isolatedInOpen } : {}),
    ...lists,
    addRooms: lists.addRooms as ScopeId[],
    dropRooms: lists.dropRooms as ScopeId[],
  };
}
