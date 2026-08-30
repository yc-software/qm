import { parseAckEmoji } from "../../slack/config.ts";
import { orgId as configOrgId } from "../../config.ts";
import type { ServerDeps } from "../deps.ts";
import type { ApiCtx } from "./route.ts";
import { parseCommandPolicy } from "../../policy/command-policy.ts";
import { parseScopeId, scopeId, type CommandPolicy, type Grant } from "../../types.ts";
import {
  defaultModelForHarness,
  HARNESS_IDS,
  isHarnessId,
  modelSupportedByHarness,
  modelServiceable,
  modelProviderAvailabilityFor,
  resolveModel,
  SELECTABLE_BASE_MODELS,
  ALL_PROVIDERS_AVAILABLE,
} from "../../model/pi-models.ts";
import { resolveRuntimeChoiceDurable } from "../../harness/harness-router.ts";
import { sanitizeBranding } from "../../resolution/branding.ts";
import {
  isValidCredentialSlug,
  isValidServiceCredentialEnvKey,
  type CredentialInjection,
  type DecryptedServiceCredential,
  type PublicServiceCredential,
  type ServiceCredentialInput,
} from "../../credentials/keychain.ts";
import { parseBotLedger } from "../../surface-cache/channel-policy-store.ts";
import { authorizeUrl, PROVIDERS, type ConsentMode } from "../../connectors/oauth.ts";
import { resolverFor } from "./connectors.ts";
import { encodeRef, serviceCredRef } from "../../acl/resource-ref.ts";
import { audit } from "./shared.ts";
import { errMessage } from "../../util/errors.ts";
import { parseSecurityPosture, SECURITY_POSTURES, type SecurityPosture } from "../../security/security-posture.ts";
import type { ApprovalGrantModes } from "../../types.ts";
import { parseEgressPolicy } from "../../resolution/egress-policy.ts";
import { DEVICE_FLOW_CUTOVER_MODES, type DeviceFlowCutoverMode } from "../../credentials/device-flow-cutover.ts";

type Actor = { id: string };

type AdminResourceKind = "boolean" | "string" | "text" | "string-list" | "enum" | "secret" | "custom";

type ApplyResult = { ok: true } | { error: string; code?: string; status?: number };

export interface AdminResource {
  id: string;
  kind: AdminResourceKind;
  readKey?: string;
  get?: (deps: ServerDeps, scope: string) => unknown | Promise<unknown>;
  apply: (ctx: ApiCtx, actor: Actor, scope: string) => Promise<ApplyResult>;
  target?: "org" | "any";
  secret?: boolean;
  clearable?: boolean;
  authz?: "scope-admin" | "org-admin";
  label?: string;
  enumValues?: readonly unknown[];
}

function generic<V>(
  parse: (
    body: unknown,
    ctx: { scope: string; deps: ServerDeps },
  ) => { value: V } | { error: string; code?: string; status?: number },
  set: (deps: ServerDeps, scope: string, value: V) => unknown,
): AdminResource["apply"] {
  return async (ctx, _actor, scope) => {
    const parsed = parse(ctx.body, { scope, deps: ctx.deps });
    if ("error" in parsed) return parsed;
    await Promise.resolve(set(ctx.deps, scope, parsed.value));
    return { ok: true };
  };
}

const orgOnly = (scope: string, label: string): { error: string } | null =>
  parseScopeId(scope).kind === "org" ? null : { error: `${label}; target an org scope` };

const boolBody = (body: unknown): { value: boolean } => ({ value: !!(body as { on?: unknown }).on });

const brokeredServices = (deps: Pick<ServerDeps, "brokeredServices">): readonly string[] =>
  deps.brokeredServices?.() ?? [];

const MAX_ORDERS_CHARS = 20_000;
const MAX_SOUL_CHARS = 100_000;

function channelContainer(scope: string): string | undefined {
  const { kind, ref } = parseScopeId(scope);
  return ref && (kind === "channel" || kind === "group") ? ref : undefined;
}

export const ADMIN_RESOURCES: readonly AdminResource[] = [
  {
    id: "security-posture",
    kind: "enum",
    target: "any",
    label: "Harness security posture. The org value is a minimum; narrower scopes may tighten it but cannot weaken it.",
    readKey: "securityPosture",
    enumValues: SECURITY_POSTURES,
    get: (deps, scope) => deps.config!.getSecurityPostureDurable(scope),
    apply: generic<SecurityPosture>(
      (body) => {
        const posture = parseSecurityPosture((body as { posture?: unknown }).posture);
        return posture
          ? { value: posture }
          : { error: `security-posture requires { posture: ${SECURITY_POSTURES.join(" | ")} }` };
      },
      (deps, scope, posture) => deps.config!.setSecurityPosture(scope, posture),
    ),
  },
  {
    id: "approval-grant-modes",
    kind: "custom",
    target: "any",
    label:
      'Which standing HiLO approval options are offered: "Allow session" and "Allow always". Composes tighten-only with the org value; disabling a mode also suspends existing grants of that mode until re-enabled.',
    readKey: "approvalGrantModes",
    get: (deps, scope) => deps.config!.getApprovalGrantModesDurable(scope),
    apply: generic<ApprovalGrantModes>(
      (body) => {
        const b = body as { session?: unknown; always?: unknown };
        if (typeof b.session !== "boolean" || typeof b.always !== "boolean") {
          return { error: "approval-grant-modes requires { session: boolean, always: boolean }" };
        }
        return { value: { session: b.session, always: b.always } };
      },
      (deps, scope, modes) => deps.config!.setApprovalGrantModes(scope, modes),
    ),
  },
  {
    id: "command-policy",
    kind: "custom",
    readKey: "commandPolicy",
    get: (deps, scope) => deps.config!.getCommandPolicy(scope),
    apply: generic<CommandPolicy>(
      (body) => {
        const p = parseCommandPolicy(body);
        return "error" in p ? { error: p.error } : { value: p.policy };
      },
      (deps, scope, policy) => deps.config!.setCommandPolicy(scope, policy),
    ),
  },
  {
    id: "soul",
    kind: "text",
    readKey: "soul",
    get: (deps, scope) => deps.config!.getSoul(scope),
    apply: async (ctx, actor, scope) => {
      const body = ctx.body as { content?: unknown; expectedVersion?: unknown };
      if (typeof body.content !== "string") return { error: "soul requires { content: string }" };
      if (body.content.length > MAX_SOUL_CHARS) return { error: `SOUL must be at most ${MAX_SOUL_CHARS} characters` };
      if (body.expectedVersion === undefined) {
        await ctx.deps.config!.setSoulLatest(scope, body.content, actor.id);
        return { ok: true };
      }
      if (typeof body.expectedVersion !== "number")
        return { error: "expectedVersion must be a number", code: "bad_version" };
      const version = await ctx.deps.config!.setSoulIfVersion(scope, body.expectedVersion, body.content, actor.id);
      if (version === null) {
        return {
          error: "SOUL changed after this draft was loaded. Reload before saving.",
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
      const p = await deps.channelPolicy.get(ref).catch(() => undefined);
      if (p === undefined) return undefined;
      return {
        orders: p?.orders ?? "",
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
        orders?: unknown;
        bots?: unknown;
        ambientEnabled?: unknown;
        baseUpdatedAt?: unknown;
      };
      if (typeof b.orders !== "string") return { error: "ambient-policy requires { orders: string }" };
      if (b.orders.length > MAX_ORDERS_CHARS)
        return {
          error: `standing order is capped at ${MAX_ORDERS_CHARS} characters — it is rendered into every ambient judgment`,
        };
      const parsed = parseBotLedger(b.bots);
      if ("error" in parsed) return { error: parsed.error };
      if (b.ambientEnabled !== undefined && b.ambientEnabled !== null && typeof b.ambientEnabled !== "boolean")
        return { error: "ambientEnabled must be a boolean or null (null = default rule)" };
      const current = await deps.channelPolicy.get(ref);
      if (typeof b.baseUpdatedAt === "number" && (current?.updatedAt ?? 0) !== b.baseUpdatedAt) {
        return {
          error: "this channel's policy changed since you loaded it — reload and re-apply your edit",
          code: "conflict",
          status: 409,
        };
      }
      await deps.channelPolicy.set(ref, b.orders, {
        setBy: actor.id,
        bots: parsed.bots,
        ambientEnabled: b.ambientEnabled as boolean | null | undefined,
      });
      audit(ctx.deps, { principalId: actor.id, action: "surface.policy.set", resource: ref, scopeLabel: scope });
      return { ok: true };
    },
  },
  {
    id: "egress",
    kind: "custom",
    readKey: "egress",
    get: (deps, scope) => deps.config!.getEgress(scope),
    apply: generic(
      (body) => {
        const parsed = parseEgressPolicy(body);
        return "error" in parsed ? parsed : { value: parsed.policy };
      },
      (deps, scope, v) => deps.config!.setEgress(scope, v),
    ),
  },
  {
    id: "device-flow-cutover",
    kind: "custom",
    target: "any",
    readKey: "deviceFlowCutover",
    label:
      "Credential-file migration by service. legacy restores resident files; prefer_ephemeral uses the isolated adapter with legacy fallback; ephemeral_only quarantines the stored legacy copy without deleting it; inherit clears a scope override.",
    get: async (deps, scope) => {
      if (!deps.deviceFlowCutover) return undefined;
      const out: Record<string, unknown> = {};
      for (const service of brokeredServices(deps)) {
        out[service] = {
          configured: await deps.deviceFlowCutover.get(scope, service),
          effective: await deps.deviceFlowCutover.resolve(scope, service),
        };
      }
      return out;
    },
    apply: async (ctx, actor, scope) => {
      if (!ctx.deps.deviceFlowCutover) return { error: "not available on this deployment", status: 404 };
      const body = (ctx.body ?? {}) as { service?: unknown; mode?: unknown };
      if (typeof body.service !== "string" || !body.service.trim()) {
        return {
          error: "device-flow-cutover requires { service: string, mode: legacy | prefer_ephemeral | ephemeral_only }",
        };
      }
      const service = body.service;
      if (body.mode !== "inherit" && !brokeredServices(ctx.deps).includes(service)) {
        return { error: `device-flow-cutover has no isolated adapter for service: ${service}` };
      }
      const beforeConfigured = await ctx.deps.deviceFlowCutover.get(scope, service);
      const beforeEffective = await ctx.deps.deviceFlowCutover.resolve(scope, service);
      if (body.mode === "inherit") {
        await ctx.deps.deviceFlowCutover.clear(scope, service);
        const effective = await ctx.deps.deviceFlowCutover.resolve(scope, service);
        audit(ctx.deps, {
          principalId: actor.id,
          action: "credential.cutover.update",
          resource: `${service}:${beforeConfigured?.mode ?? "inherit"}/${beforeEffective}->inherit/${effective}`,
          scopeLabel: scope,
        });
        return { ok: true };
      }
      if (typeof body.mode !== "string" || !(DEVICE_FLOW_CUTOVER_MODES as readonly string[]).includes(body.mode)) {
        return { error: `device-flow-cutover mode must be one of: ${DEVICE_FLOW_CUTOVER_MODES.join(", ")}, inherit` };
      }
      await ctx.deps.deviceFlowCutover.set(scope, service, body.mode as DeviceFlowCutoverMode, actor.id);
      audit(ctx.deps, {
        principalId: actor.id,
        action: "credential.cutover.update",
        resource: `${service}:${beforeConfigured?.mode ?? "inherit"}/${beforeEffective}->${body.mode}/${body.mode}`,
        scopeLabel: scope,
      });
      return { ok: true };
    },
  },
  {
    id: "unfulfilled-insights",
    kind: "boolean",
    readKey: "unfulfilledInsights",
    get: (deps, scope) => deps.config!.getUnfulfilledInsights(scope),
    apply: generic(boolBody, (deps, scope, on) => deps.config!.setUnfulfilledInsights(scope, on)),
  },
  {
    id: "external-slack-participants",
    kind: "boolean",
    target: "org",
    label:
      "Supports external Slack participants: internal members may chat with the agent in Slack rooms whose audience includes an external user (Connect member or guest). Externals themselves still can't interact.",
    readKey: "externalSlackParticipants",
    get: (deps, scope) => deps.config!.getExternalSlackParticipants(scope),
    apply: generic<boolean>(
      (body, { scope }) => {
        const bad = orgOnly(scope, "the external-Slack-participants toggle is org-wide");
        if (bad) return bad;
        return boolBody(body);
      },
      (deps, scope, on) => deps.config!.setExternalSlackParticipants(scope, on),
    ),
  },
  {
    id: "channel-header-pin-default",
    kind: "boolean",
    target: "org",
    label:
      "Channel pinned-header default: on means the agent posts and pins its header message (naming the model in use) in every Slack channel unless a channel explicitly turns it off.",
    readKey: "channelHeaderPinDefault",
    get: (deps, scope) => (parseScopeId(scope).kind === "org" ? deps.config!.getChannelHeaderPin(scope) : undefined),
    apply: generic<boolean>(
      (body, { scope }) => {
        const bad = orgOnly(scope, "the channel pinned-header default is org-wide");
        if (bad) return bad;
        return boolBody(body);
      },
      (deps, scope, on) => deps.config!.setChannelHeaderPinLatest(scope, on),
    ),
  },
  {
    id: "org-ambient",
    kind: "boolean",
    target: "org",
    label:
      "Ambient behavior org-wide: off means the agent never acts on overheard messages anywhere, regardless of per-channel settings.",
    readKey: "orgAmbient",
    get: (deps, scope) => (parseScopeId(scope).kind === "org" ? deps.config!.getOrgAmbient() : undefined),
    apply: generic<boolean>(
      (body, { scope }) => {
        const bad = orgOnly(scope, "the ambient switch here is org-wide");
        if (bad) return bad;
        return boolBody(body);
      },
      (deps, _scope, on) => deps.config!.setOrgAmbient(on),
    ),
  },
  {
    id: "interactive-fast-mode",
    kind: "boolean",
    target: "org",
    label:
      "Fast mode for interactive turns org-wide: on means human turns run in fast mode on fast-capable models unless the turn asks otherwise. Requires fast-mode quota with the provider.",
    readKey: "interactiveFastMode",
    get: (deps, scope) => (parseScopeId(scope).kind === "org" ? deps.config!.getInteractiveFastMode() : undefined),
    apply: generic<boolean>(
      (body, { scope }) => {
        const bad = orgOnly(scope, "the interactive fast-mode switch is org-wide");
        if (bad) return bad;
        return boolBody(body);
      },
      (deps, _scope, on) => deps.config!.setInteractiveFastMode(on),
    ),
  },
  {
    id: "individual-model-auth",
    kind: "boolean",
    target: "org",
    label:
      "Individual authorization for AI usage org-wide: on means each user must connect their own Claude or Codex account (API key or subscription login) before using the assistant; the org's shared model credentials are not used for their turns.",
    readKey: "individualModelAuth",
    get: (deps, scope) => (parseScopeId(scope).kind === "org" ? deps.config!.getIndividualModelAuth() : undefined),
    apply: generic<boolean>(
      (body, { scope }) => {
        const bad = orgOnly(scope, "the individual-authorization switch is org-wide");
        if (bad) return bad;
        return boolBody(body);
      },
      (deps, _scope, on) => deps.config!.setIndividualModelAuth(on),
    ),
  },
  {
    id: "base-model",
    kind: "enum",
    target: "any",
    clearable: true,
    readKey: "baseModel",
    enumValues: SELECTABLE_BASE_MODELS,
    get: (deps, scope) => deps.config!.getBaseModel(scope),
    apply: async (ctx, _actor, scope) => {
      const raw = (ctx.body as { modelId?: unknown }).modelId;
      if (raw !== undefined && raw !== null && typeof raw !== "string")
        return { error: "base-model requires { modelId: string } (empty string clears the override)" };
      const modelId = typeof raw === "string" ? raw.trim() : "";
      if (modelId && !resolveModel(modelId)) return { error: `unknown model id: ${modelId}` };
      const configuredKeys = ctx.deps.providerKeys ?? ALL_PROVIDERS_AVAILABLE;
      const managedKeys = ctx.deps.modelCredentials ? await ctx.deps.modelCredentials.availability() : configuredKeys;
      const unserviceable = (harness: string): { error: string } | null =>
        modelId && !modelServiceable(modelId, modelProviderAvailabilityFor(harness, configuredKeys, managedKeys))
          ? {
              error: `model ${modelId} isn't serviceable on this deployment: its provider key is not configured for the ${harness} harness`,
            }
          : null;
      const runtime = await ctx.deps.config!.getRuntimeSelectionDurable(scope);
      if (!modelId) await ctx.deps.config!.setRuntimeSelectionLatest(scope, null);
      else if (runtime) {
        if (!isHarnessId(runtime.harnessId) || !modelSupportedByHarness(modelId, runtime.harnessId))
          return { error: `model ${modelId} is not supported by ${runtime.harnessId}` };
        const bad = unserviceable(runtime.harnessId);
        if (bad) return bad;
        await ctx.deps.config!.setRuntimeSelectionLatest(scope, { harnessId: runtime.harnessId, modelId });
      } else {
        const harnessId = isHarnessId(ctx.deps.harnessId) ? ctx.deps.harnessId : "pi";
        const effective = await resolveRuntimeChoiceDurable(ctx.deps.config!, scopeId("org", configOrgId()), scope, {
          harnessId,
          modelId: defaultModelForHarness(harnessId, ctx.deps.baseModelDefault),
        });
        if (!modelSupportedByHarness(modelId, effective.harnessId))
          return { error: `model ${modelId} is not supported by ${effective.harnessId}` };
        const bad = unserviceable(effective.harnessId);
        if (bad) return bad;
        await ctx.deps.config!.setRuntimeSelectionLatest(scope, { harnessId: effective.harnessId, modelId });
      }
      return { ok: true };
    },
  },
  {
    id: "runtime",
    kind: "custom",
    target: "any",
    clearable: true,
    readKey: "runtime",
    get: (deps, scope) => deps.config!.getRuntimeSelection(scope),
    apply: async (ctx, _actor, scope) => {
      if ((ctx.body as { inherit?: unknown }).inherit === true) {
        await ctx.deps.config!.setRuntimeSelectionLatest(scope, null);
        return { ok: true };
      }
      const harnessId = (ctx.body as { harnessId?: unknown }).harnessId;
      const modelId = (ctx.body as { modelId?: unknown }).modelId;
      if (!isHarnessId(harnessId)) return { error: `runtime requires harnessId (${HARNESS_IDS.join(" | ")})` };
      const approved = (await ctx.deps.config!.getApprovedHarnessesDurable()) ?? [ctx.deps.harnessId ?? "pi"];
      if (!approved.includes(harnessId)) return { error: `harness ${harnessId} is not approved` };
      if (typeof modelId !== "string" || !modelSupportedByHarness(modelId, harnessId))
        return { error: `model ${String(modelId)} is not supported by ${harnessId}` };
      const runtimeKeys = ctx.deps.providerKeys ?? ALL_PROVIDERS_AVAILABLE;
      if (!modelServiceable(modelId, modelProviderAvailabilityFor(harnessId, runtimeKeys)))
        return {
          error: `model ${modelId} isn't serviceable on this deployment: its provider key is not configured for the ${harnessId} harness`,
        };
      await ctx.deps.config!.setRuntimeSelectionLatest(scope, { harnessId, modelId });
      return { ok: true };
    },
  },
  {
    id: "approved-harnesses",
    kind: "string-list",
    target: "org",
    clearable: true,
    readKey: "approvedHarnesses",
    enumValues: HARNESS_IDS,
    get: (deps) => deps.config!.getApprovedHarnesses(),
    apply: generic(
      (body, { scope }) => {
        const bad = orgOnly(scope, "approved harnesses are org-wide");
        if (bad) return bad;
        const raw = (body as { ids?: unknown }).ids;
        if (!Array.isArray(raw)) return { error: "approved-harnesses requires { ids: string[] }" };
        if (raw.some((id) => !isHarnessId(id)))
          return { error: `unknown harness (expected ${HARNESS_IDS.join(" | ")})` };
        const ids = [...new Set(raw.filter(isHarnessId))];
        return { value: ids.length ? ids : null };
      },
      (deps, _scope, ids) => deps.config!.setApprovedHarnesses(ids),
    ),
  },
  {
    id: "webui-models",
    kind: "string-list",
    target: "org",
    clearable: true,
    label:
      "Web UI model picker (ordered list of model ids; the org base model is the default selection, else the first). Empty restores the built-in set.",
    readKey: "webuiModels",
    enumValues: SELECTABLE_BASE_MODELS,
    get: (deps, scope) => deps.config!.getWebuiModels(scope),
    apply: generic<string[] | null>(
      (body, { scope }) => {
        const bad = orgOnly(scope, "the web UI model picker is org-wide");
        if (bad) return bad;
        const raw = (body as { ids?: unknown }).ids;
        if (raw !== undefined && raw !== null && !Array.isArray(raw)) {
          return { error: "webui-models requires { ids: string[] } (empty list restores the default picker)" };
        }
        const ids = Array.isArray(raw) ? raw.map((v) => (typeof v === "string" ? v.trim() : "")).filter(Boolean) : [];
        for (const id of ids) if (!resolveModel(id)) return { error: `unknown model id: ${id}` };
        const seen = new Set<string>();
        const unique = ids.filter((id) => (seen.has(id) ? false : (seen.add(id), true)));
        return { value: unique.length ? unique : null };
      },
      (deps, scope, ids) => deps.config!.setWebuiModels(scope, ids),
    ),
  },
  {
    id: "people-directory-url",
    kind: "string",
    target: "org",
    clearable: true,
    readKey: "peopleDirectoryUrl",
    get: (deps, scope) => deps.config!.getPeopleDirectoryUrl(scope),
    apply: generic<string | null>(
      (body, { scope }) => {
        const bad = orgOnly(scope, "the people directory is org-wide");
        if (bad) return bad;
        const raw = (body as { url?: unknown }).url;
        if (raw !== undefined && raw !== null && typeof raw !== "string") {
          return { error: "people-directory-url requires { url: string } (empty string clears it)" };
        }
        const url = typeof raw === "string" ? raw.trim() : "";
        if (url && !/^https?:\/\//.test(url))
          return { error: "people-directory-url must start with http:// or https://" };
        return { value: url || null };
      },
      (deps, scope, url) => deps.config!.setPeopleDirectoryUrl(scope, url),
    ),
  },
  {
    id: "ack-emoji",
    kind: "string-list",
    target: "org",
    clearable: true,
    label:
      "Slack ack emoji (names the bot may react with to acknowledge a message). Empty restores the built-in rotation.",
    readKey: "ackEmoji",
    get: (deps, scope) => deps.config!.getAckEmoji(scope),
    apply: generic<string[] | null>(
      (body, { scope }) => {
        const bad = orgOnly(scope, "the ack emoji set is org-wide");
        if (bad) return bad;
        const raw = (body as { names?: unknown }).names;
        if (raw !== undefined && raw !== null && !Array.isArray(raw)) {
          return { error: "ack-emoji requires { names: string[] } (empty list restores the default rotation)" };
        }
        const input = Array.isArray(raw) ? raw.map((v) => (typeof v === "string" ? v : "")).join(",") : "";
        const names = parseAckEmoji(input);
        const supplied = Array.isArray(raw) ? raw.filter((v) => typeof v === "string" && v.trim()).length : 0;
        if (supplied && names.length !== supplied) {
          return { error: "ack-emoji names must be Slack emoji names (lowercase letters, digits, _ + -)" };
        }
        return { value: names.length ? names : null };
      },
      (deps, scope, names) => deps.config!.setAckEmoji(scope, names),
    ),
  },
  {
    id: "branding",
    kind: "custom",
    target: "org",
    clearable: true,
    readKey: "branding",
    get: (deps, scope) => deps.config!.getBranding(scope),
    apply: async (ctx, _actor, scope) => {
      const bad = orgOnly(scope, "branding is org-wide");
      if (bad) return bad;
      const body = (ctx.body ?? {}) as { accent?: unknown; mark?: unknown; selfLabel?: unknown; orgName?: unknown };
      const accentInput = typeof body.accent === "string" ? body.accent.trim() : "";
      const value = sanitizeBranding(body);
      if (accentInput && !value?.accent) {
        return { error: "branding accent must be a hex color (e.g. #4f46e5)" };
      }
      ctx.deps.config!.setBranding(scope, value ?? null);
      return { ok: true };
    },
  },
  {
    id: "turn-wall-clock",
    kind: "string",
    target: "org",
    clearable: true,
    label:
      "Maximum wall-clock time for a turn in seconds. Zero leaves turns uncapped; empty restores the deployment default.",
    readKey: "turnWallClockSec",
    get: (deps, scope) => deps.config!.getTurnWallClockSecDurable(scope),
    apply: generic<number | null>(
      (body, { scope }) => {
        const bad = orgOnly(scope, "the turn wall-clock limit is org-wide");
        if (bad) return bad;
        const raw = (body as { sec?: unknown }).sec;
        const trimmed = typeof raw === "string" ? raw.trim() : raw;
        if (trimmed === undefined || trimmed === null || trimmed === "") return { value: null };
        const sec = typeof trimmed === "number" ? trimmed : Number(trimmed);
        if (!Number.isInteger(sec) || (sec !== 0 && (sec < 60 || sec > 86_400))) {
          return { error: "turn-wall-clock requires { sec: 0 or integer 60-86400 } (empty clears the override)" };
        }
        return { value: sec };
      },
      (deps, scope, sec) => deps.config!.setTurnWallClockSec(scope, sec),
    ),
  },
  {
    id: "browse-model",
    kind: "enum",
    target: "org",
    clearable: true,
    label:
      "The model driving the browser agent in the browse skill, org-wide (empty follows the deployment's base model; fast mode applies only on Opus models).",
    readKey: "browseModel",
    enumValues: SELECTABLE_BASE_MODELS,
    get: (deps, scope) => deps.config!.getBrowseModel(scope),
    apply: async (ctx, _actor, scope) => {
      const bad = orgOnly(scope, "the browse model is org-wide");
      if (bad) return bad;
      const raw = (ctx.body as { modelId?: unknown }).modelId;
      if (raw !== undefined && raw !== null && typeof raw !== "string") {
        return { error: "browse-model requires { modelId: string } (empty string clears the override)" };
      }
      const modelId = typeof raw === "string" ? raw.trim() : "";
      if (modelId && !resolveModel(modelId)) return { error: `unknown model id: ${modelId}` };
      const configuredKeys = ctx.deps.providerKeys ?? ALL_PROVIDERS_AVAILABLE;
      const managedKeys = ctx.deps.modelCredentials ? await ctx.deps.modelCredentials.availability() : configuredKeys;
      const providers = modelProviderAvailabilityFor(ctx.deps.harnessId ?? "pi", configuredKeys, managedKeys);
      if (modelId && !modelServiceable(modelId, providers)) {
        return { error: `model ${modelId} isn't serviceable on this deployment: its provider key is not configured` };
      }
      await Promise.resolve(ctx.deps.config!.setBrowseModel(scope, modelId || null));
      return { ok: true };
    },
  },
  {
    id: "browse-max-steps",
    kind: "string",
    target: "org",
    clearable: true,
    label: "Max browser steps per browse task (empty restores the default of 50).",
    readKey: "browseMaxSteps",
    get: (deps, scope) => deps.config!.getBrowseMaxSteps(scope),
    apply: generic<number | null>(
      (body, { scope }) => {
        const bad = orgOnly(scope, "the browse step limit is org-wide");
        if (bad) return bad;
        const raw = (body as { steps?: unknown }).steps;
        if (raw === undefined || raw === null || raw === "") return { value: null };
        let steps = NaN;
        if (typeof raw === "number") steps = raw;
        else if (typeof raw === "string") steps = Number(raw.trim());
        if (!Number.isInteger(steps) || steps < 1 || steps > 500) {
          return { error: "browse-max-steps requires { steps: integer 1-500 } (empty clears to the default of 50)" };
        }
        return { value: steps };
      },
      (deps, scope, steps) => deps.config!.setBrowseMaxSteps(scope, steps),
    ),
  },
  {
    id: "connectors",
    kind: "custom",
    readKey: "connectors",
    get: (deps, scope) => deps.config!.listConnectorClients(scope),
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
        await deps.config!.deleteConnectorClient(scope, provider);
        return { ok: true };
      }
      if (typeof b.clientId !== "string" || typeof b.clientSecret !== "string") {
        return { error: "connectors requires { provider, clientId, clientSecret }" };
      }
      await deps.config!.setConnectorClient(scope, provider, {
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
    apply: async (ctx, actor, scope) => {
      const { deps } = ctx;
      if (!deps.acl) return { error: "ACL store not wired", code: "not_found", status: 404 };
      if (!deps.serviceCreds) return { error: "credential store not wired", code: "not_found", status: 404 };
      const bad = orgOnly(scope, "service credentials are org-scoped");
      if (bad) return bad;
      const b = ctx.body as {
        slug?: unknown;
        name?: unknown;
        secret?: unknown;
        delivery?: unknown;
        envKey?: unknown;
        host?: unknown;
        injection?: unknown;
        allowedMethods?: unknown;
        allowedPathPrefixes?: unknown;
        enabled?: unknown;
        grantees?: unknown;
        delete?: unknown;
        expectedUpdatedAt?: unknown;
      };
      const slug = typeof b.slug === "string" ? b.slug : "";
      if (!isValidCredentialSlug(slug)) return { error: "slug must be lowercase kebab-case (a-z, 0-9, -)" };
      const ref = encodeRef(serviceCredRef(slug));
      const allCreds = await deps.serviceCreds.listServiceCredentials(scope);
      const existing = allCreds.find((c) => c.slug === slug);
      const conflict = () => ({
        error: "Credential changed after this editor was loaded. Reload it before continuing.",
        code: "version_conflict",
        status: 409,
      });
      if ((existing || b.delete === true) && typeof b.expectedUpdatedAt !== "number") {
        return {
          error: "Existing credential edits and deletes require the version you loaded.",
          code: "version_required",
        };
      }
      if (!existing && typeof b.expectedUpdatedAt === "number") return conflict();
      const grantsBefore = await deps.acl.grantsFor(scope, ref);
      const secretBefore = existing ? await deps.serviceCreds.getServiceCredentialSecret(scope, slug) : null;
      const desiredGrants = (desired: string[]): Grant[] => {
        const desiredSet = new Set(desired);
        const replacement = grantsBefore.filter((grant) => desiredSet.has(grant.granteeScopeId));
        const currentSet = new Set(replacement.map((grant) => grant.granteeScopeId));
        for (const granteeScopeId of desired) {
          if (!currentSet.has(granteeScopeId))
            replacement.push({ ownerScopeId: scope, ref, granteeScopeId, permission: "read", grantedBy: actor.id });
        }
        return replacement;
      };
      const grantChanges = (replacement: readonly Grant[]): Array<{ action: "share" | "unshare"; grantee: string }> => {
        const changes: Array<{ action: "share" | "unshare"; grantee: string }> = [];
        const before = new Set(grantsBefore.map((grant) => grant.granteeScopeId));
        const after = new Set(replacement.map((grant) => grant.granteeScopeId));
        for (const grantee of before) if (!after.has(grantee)) changes.push({ action: "unshare", grantee });
        for (const grantee of after) if (!before.has(grantee)) changes.push({ action: "share", grantee });
        return changes;
      };
      const restoreInput = (
        credential: PublicServiceCredential,
        secret: DecryptedServiceCredential | null,
      ): ServiceCredentialInput => ({
        slug: credential.slug,
        name: credential.name,
        delivery: credential.delivery,
        ...(credential.envKey ? { envKey: credential.envKey } : {}),
        host: credential.host,
        ...(secret?.secret ? { secret: secret.secret } : {}),
        ...(credential.injection ? { injection: credential.injection } : {}),
        ...(credential.allowedMethods ? { allowedMethods: credential.allowedMethods } : {}),
        ...(credential.allowedPathPrefixes ? { allowedPathPrefixes: credential.allowedPathPrefixes } : {}),
        enabled: credential.enabled,
        ...(credential.updatedBy ? { updatedBy: credential.updatedBy } : {}),
      });
      const publicShape = (credential: PublicServiceCredential | undefined) =>
        credential &&
        JSON.stringify({
          slug: credential.slug,
          name: credential.name,
          delivery: credential.delivery,
          envKey: credential.envKey ?? null,
          host: credential.host,
          injection: credential.injection ?? null,
          allowedMethods: credential.allowedMethods ?? null,
          allowedPathPrefixes: credential.allowedPathPrefixes ?? null,
          enabled: credential.enabled,
          hasSecret: credential.hasSecret,
          updatedBy: credential.updatedBy ?? null,
        });
      const grantShape = (grants: readonly Grant[]) =>
        JSON.stringify(
          grants
            .map((grant) => ({
              ownerScopeId: grant.ownerScopeId,
              ref: grant.ref,
              granteeScopeId: grant.granteeScopeId,
              permission: grant.permission,
              grantedBy: grant.grantedBy,
            }))
            .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))),
        );
      let mutationVersion: number | null = null;
      let deletedCredential = false;
      let grantsWritten = grantsBefore;
      const rollback = async (): Promise<boolean> => {
        try {
          let credentialRestored: boolean;
          if (!existing) {
            credentialRestored =
              mutationVersion !== null &&
              (await deps.serviceCreds!.deleteServiceCredentialIfCurrent(scope, slug, mutationVersion));
          } else if (deletedCredential) {
            credentialRestored =
              (await deps.serviceCreds!.setServiceCredentialIfAbsent(scope, restoreInput(existing, secretBefore))) !==
              null;
          } else {
            credentialRestored =
              mutationVersion !== null &&
              (await deps.serviceCreds!.setServiceCredentialIfCurrent(
                scope,
                restoreInput(existing, secretBefore),
                mutationVersion,
              )) !== null;
          }
          if (!credentialRestored) return false;
          const grantsRestored =
            (await deps.acl!.replaceGrantsIfCurrent(scope, ref, grantsWritten, grantsBefore, actor.id)) ||
            grantShape(await deps.acl!.grantsFor(scope, ref)) === grantShape(grantsBefore);
          if (!grantsRestored) return false;
          const restored = (await deps.serviceCreds!.listServiceCredentials(scope)).find(
            (credential) => credential.slug === slug,
          );
          const restoredSecret = restored ? await deps.serviceCreds!.getServiceCredentialSecret(scope, slug) : null;
          const restoredGrants = await deps.acl!.grantsFor(scope, ref);
          return (
            publicShape(restored) === publicShape(existing) &&
            (restoredSecret?.secret ?? null) === (secretBefore?.secret ?? null) &&
            grantShape(restoredGrants) === grantShape(grantsBefore)
          );
        } catch {
          return false;
        }
      };
      const mutationFailed = async (operation: string): Promise<ApplyResult> => {
        const rolledBack = await rollback();
        return {
          error: rolledBack
            ? `Credential ${operation} failed; the previous credential and grants were restored.`
            : `Credential ${operation} failed and rollback could not be verified. Review this credential before retrying.`,
          code: rolledBack ? "credential_mutation_rolled_back" : "credential_mutation_inconsistent",
          status: 500,
        };
      };
      const auditGrantChanges = (changes: Array<{ action: "share" | "unshare"; grantee: string }>) => {
        for (const change of changes)
          audit(deps, {
            principalId: actor.id,
            action: `service_credential.${change.action}`,
            resource: ref,
            scopeLabel: change.grantee,
          });
      };
      if (b.delete === true) {
        if (
          !existing ||
          !(await deps.serviceCreds.deleteServiceCredentialIfCurrent(scope, slug, b.expectedUpdatedAt as number))
        )
          return conflict();
        deletedCredential = true;
        const replacement: Grant[] = [];
        grantsWritten = replacement;
        try {
          if (!(await deps.acl.replaceGrantsIfCurrent(scope, ref, grantsBefore, replacement, actor.id)))
            return mutationFailed("delete");
          auditGrantChanges(grantChanges(replacement));
          return { ok: true };
        } catch (e) {
          console.error("[admin] credential delete failed after conditional mutation:", errMessage(e));
          return mutationFailed("delete");
        }
      }
      const name = typeof b.name === "string" && b.name.trim() ? b.name.trim() : "";
      const deliveryRaw = b.delivery === undefined ? (existing?.delivery ?? "broker") : b.delivery;
      if (deliveryRaw !== "broker" && deliveryRaw !== "env") return { error: 'delivery must be "broker" or "env"' };
      const delivery: "broker" | "env" = deliveryRaw;
      const envKey = typeof b.envKey === "string" && b.envKey.trim() ? b.envKey.trim() : undefined;
      if (delivery === "env") {
        if (!envKey || !isValidServiceCredentialEnvKey(envKey)) {
          return {
            error: "env delivery requires an UPPER_SNAKE_CASE env var name outside the reserved AGENT_* namespace",
          };
        }
        const clash = allCreds.find((c) => c.slug !== slug && c.delivery === "env" && c.envKey === envKey);
        if (clash) return { error: `env var ${envKey} is already delivered by credential "${clash.slug}"` };
      } else if (envKey) {
        return { error: "an env var name only applies to env delivery" };
      }
      const host = typeof b.host === "string" ? b.host.trim().toLowerCase() : "";
      if (!name) return { error: "service-credentials requires { slug, name }" };
      if (delivery === "broker" && (!host || /[/:\s]/.test(host))) {
        return { error: "broker delivery requires { host } (a bare hostname)" };
      }
      if (delivery === "env" && host) return { error: "a pinned host only applies to broker delivery" };
      if (!existing && (typeof b.secret !== "string" || !b.secret)) {
        return { error: "a new credential requires a secret" };
      }
      const methods = Array.isArray(b.allowedMethods)
        ? b.allowedMethods
            .map(String)
            .map((method) => method.trim().toUpperCase())
            .filter(Boolean)
        : undefined;
      if (methods?.some((method) => !/^[A-Z]+$/.test(method)))
        return { error: "allowed methods must be comma-separated HTTP method names" };
      const paths = Array.isArray(b.allowedPathPrefixes)
        ? b.allowedPathPrefixes
            .map(String)
            .map((path) => path.trim())
            .filter(Boolean)
        : undefined;
      if (paths?.some((path) => !path.startsWith("/") || /[\r\n]/.test(path)))
        return { error: "each allowed path prefix must be one line starting with /" };
      const desired = Array.isArray(b.grantees) ? [...new Set(b.grantees.map(String))] : undefined;
      const badGrantee = desired?.find((g) => {
        const parsed = parseScopeId(g);
        return (
          !["org", "personal", "team"].includes(parsed.kind ?? "") ||
          !parsed.ref ||
          parsed.ref.includes(":") ||
          (parsed.kind === "org" && g !== scope)
        );
      });
      if (badGrantee !== undefined)
        return { error: `grantee must be this org or a valid personal:/team: scope (got ${badGrantee})` };
      const injection =
        b.injection && typeof b.injection === "object"
          ? ({
              ...(typeof (b.injection as CredentialInjection).header === "string"
                ? { header: (b.injection as CredentialInjection).header }
                : {}),
              ...(typeof (b.injection as CredentialInjection).scheme === "string"
                ? { scheme: (b.injection as CredentialInjection).scheme }
                : {}),
            } as CredentialInjection)
          : undefined;
      if (injection?.header && !/^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/.test(injection.header))
        return { error: "authentication header must be a valid HTTP header name" };
      if (injection?.scheme && /[\r\n]/.test(injection.scheme))
        return { error: "authentication value prefix must be a single line" };
      const effectiveInjection = b.injection === undefined ? existing?.injection : injection;
      let brokerMethods: { allowedMethods?: string[] } = {};
      if (methods) brokerMethods = { allowedMethods: methods };
      else if (existing?.allowedMethods) brokerMethods = { allowedMethods: existing.allowedMethods };
      let brokerPaths: { allowedPathPrefixes?: string[] } = {};
      if (paths) brokerPaths = { allowedPathPrefixes: paths };
      else if (existing?.allowedPathPrefixes) brokerPaths = { allowedPathPrefixes: existing.allowedPathPrefixes };
      const input = {
        slug,
        name,
        delivery,
        ...(delivery === "env" ? { envKey } : {}),
        host: delivery === "env" ? "" : host,
        ...(typeof b.secret === "string" && b.secret ? { secret: b.secret } : {}),
        ...(delivery === "broker" && effectiveInjection && (effectiveInjection.header || effectiveInjection.scheme)
          ? { injection: effectiveInjection }
          : {}),
        ...(delivery === "broker" ? brokerMethods : {}),
        ...(delivery === "broker" ? brokerPaths : {}),
        enabled: typeof b.enabled === "boolean" ? b.enabled : (existing?.enabled ?? true),
        updatedBy: actor.id,
      };
      if (existing) {
        mutationVersion = await deps.serviceCreds.setServiceCredentialIfCurrent(
          scope,
          input,
          b.expectedUpdatedAt as number,
        );
        if (mutationVersion === null) return conflict();
      } else {
        mutationVersion = await deps.serviceCreds.setServiceCredentialIfAbsent(scope, input);
        if (mutationVersion === null) return conflict();
      }
      const replacement = desiredGrants(
        desired ?? (existing ? grantsBefore.map((grant) => grant.granteeScopeId) : [scope]),
      );
      grantsWritten = replacement;
      try {
        if (!(await deps.acl.replaceGrantsIfCurrent(scope, ref, grantsBefore, replacement, actor.id)))
          return mutationFailed(existing ? "update" : "create");
        auditGrantChanges(grantChanges(replacement));
        return { ok: true };
      } catch (e) {
        console.error("[admin] credential update failed after conditional mutation:", errMessage(e));
        return mutationFailed(existing ? "update" : "create");
      }
    },
  },
];

export const ADMIN_RESOURCE_BY_ID = new Map(ADMIN_RESOURCES.map((r) => [r.id, r]));

export interface AdminResourceManifestEntry {
  id: string;
  kind: AdminResourceKind;
  target?: "org" | "any";
  secret?: boolean;
  clearable?: boolean;
  authz?: "scope-admin" | "org-admin";
  label?: string;
  enumValues?: readonly unknown[];
}

export function adminResourceManifest(): AdminResourceManifestEntry[] {
  return ADMIN_RESOURCES.map((r) => ({
    id: r.id,
    kind: r.kind,
    ...(r.target ? { target: r.target } : {}),
    ...(r.secret ? { secret: true } : {}),
    ...(r.clearable ? { clearable: true } : {}),
    ...(r.authz ? { authz: r.authz } : {}),
    ...(r.label ? { label: r.label } : {}),
    ...(r.enumValues ? { enumValues: r.enumValues } : {}),
  }));
}
