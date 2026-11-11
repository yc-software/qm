import { SANDBOX_MODEL_PREFIX } from "../../api/contract.ts";
import {
  BROWSER_MODEL_AUD,
  CAPABILITY_TTL_MS,
  CONTROL_PLANE_AUD,
  EGRESS_PROXY_AUD,
  OAUTH_CONSENT_AUD,
  SANDBOX_CAPABILITY_TTL_MS,
  SANDBOX_MODEL_AUD,
  mintCapabilityToken,
  type CapabilityClaims,
} from "../../auth/capability-token.ts";
import type { MemoryPolicy } from "../../memory/policy.ts";
import type { resolveTurnContext } from "../../resolution/turn-context.ts";
import type { EgressPolicy, ScopeId, Session } from "../../types.ts";
import { ambientTenant } from "../../tenants/context.ts";
import { swallow } from "../../util/errors.ts";
import { trimTrailingSlashes } from "../../util/text.ts";
import type { SystemContextBlocks } from "./prompt-blocks.ts";
import { egressClaimAllowingControlPlane, type deliveryCandidatesFor } from "./turn-helpers.ts";
import type { OrchestratorDeps, OrchestratorInput } from "./types.ts";

type TurnContext = Awaited<ReturnType<typeof resolveTurnContext>>;

export interface CapabilityTurn {
  deps: OrchestratorDeps;
  input: OrchestratorInput;
  actor: OrchestratorInput["actor"];
  conversation: OrchestratorInput["conversation"];
  session: Session;
  scopeId: ScopeId;
  audienceScopeId: ScopeId | undefined;
  resolution: Awaited<ReturnType<OrchestratorDeps["resolution"]["resolve"]>>;
  external: boolean;
  strictReadOnly: boolean;
  allInternal: boolean;
  liveTurn: boolean;
  liveAuthorTurn: boolean;
  automatedTurn: boolean;
  actAsActor: boolean;
  useMemory: boolean;
  memoryPolicy: MemoryPolicy;
  memoryScopeId: TurnContext["memoryScopeId"];
  memoryAccess: TurnContext["memoryAccess"];
  baseRecallScopes: TurnContext["baseRecallScopes"];
  ownCredentialsAllowed: boolean;
  turnTimezone: string | undefined;
  delivery: ReturnType<typeof deliveryCandidatesFor>;
  defaultDestination: CapabilityClaims["destination"];
  origin: CapabilityClaims["origin"];
  browserModel: string | undefined;
  sessionAuth: { account: NonNullable<CapabilityClaims["browserAccount"]> } | undefined;
  connectorEnv: Record<string, string>;
  turnContextBlocks: SystemContextBlocks;
}

export async function mintTurnCapabilities(turn: CapabilityTurn) {
  const {
    deps,
    input,
    actor,
    conversation,
    scopeId,
    audienceScopeId,
    resolution,
    external,
    strictReadOnly,
    liveTurn,
    actAsActor,
  } = turn;
  const sandboxTokenTtlMs = deps.sandboxCapabilityTtlMs ?? SANDBOX_CAPABILITY_TTL_MS;
  const sandboxTokenExpiry = sandboxTokenTtlMs === 0 ? 0 : Date.now() + sandboxTokenTtlMs;
  const scopeAttestation = {
    ...(external ? { externalSlack: true as const } : {}),
    actorId: actor.id,
    scopeId,
    ...(audienceScopeId ? { audienceScopeId } : {}),
    ...(input.scopeVersion ? { scopeVersion: input.scopeVersion } : {}),
    ...(conversation.publishMembers ? { members: conversation.publishMembers } : {}),
    ...(liveTurn ? { liveActor: true } : {}),
    ...(input.botActor ? { botActor: true } : {}),
    ...(actAsActor ? { actAsActor: true } : {}),
  };
  const tenant = ambientTenant();
  const { actorIsOrgAdmin, orgMemoryWritable, controlClaims } = await mintControlPlaneTokens(
    tenant,
    turn,
    scopeAttestation,
    sandboxTokenExpiry,
  );
  const securityPolicy = resolution.securityPolicy;
  const egressSecret = deps.capabilitySecret ?? deps.signingSecret;
  const egressTokenForPolicy = async (egress: EgressPolicy): Promise<string | undefined> => {
    if (strictReadOnly || !egressSecret) return undefined;
    return mintCapabilityToken(
      {
        ...scopeAttestation,
        aud: EGRESS_PROXY_AUD,
        egress: egressClaimAllowingControlPlane(egress, deps.apiBaseUrl ?? "", securityPolicy.denyPrivateNetworks),
        exp: sandboxTokenExpiry,
      },
      egressSecret,
      deps.capabilityTokenCompression,
    );
  };
  return {
    actorIsOrgAdmin,
    orgMemoryWritable,
    tenant,
    controlClaims,
    sandboxTokenExpiry,
    scopeAttestation,
    egressTokenForPolicy,
  };
}

async function mintControlPlaneTokens(
  tenant: ReturnType<typeof ambientTenant>,
  turn: CapabilityTurn,
  scopeAttestation: Omit<CapabilityClaims, "exp">,
  sandboxTokenExpiry: number,
) {
  const {
    deps,
    input,
    actor,
    conversation,
    session,
    resolution,
    external,
    strictReadOnly,
    allInternal,
    liveTurn,
    liveAuthorTurn,
    automatedTurn,
    useMemory,
    memoryPolicy,
    memoryScopeId,
    memoryAccess,
    baseRecallScopes,
    ownCredentialsAllowed,
    turnTimezone,
    delivery,
    defaultDestination,
    origin,
    browserModel,
    sessionAuth,
    connectorEnv,
    turnContextBlocks,
  } = turn;
  const securityPolicy = resolution.securityPolicy;
  let actorIsOrgAdmin = false;
  let orgMemoryWrite: ScopeId | undefined;
  const orgMemoryWritable = useMemory && memoryPolicy.capture !== "off" && resolution.orgScopeId !== memoryScopeId;
  let controlClaims: CapabilityClaims | undefined;
  if (!strictReadOnly && deps.signingSecret && deps.apiBaseUrl) {
    const destination = defaultDestination;
    connectorEnv.AGENT_API_URL = deps.apiBaseUrl;
    if (deps.admin && liveAuthorTurn) {
      try {
        actorIsOrgAdmin = (await deps.admin.adminStatusOf(tenant, actor)).isAdmin;
      } catch (e) {
        swallow("orchestrator: admin status for turn", e);
      }
      if (actorIsOrgAdmin && liveTurn && orgMemoryWritable) orgMemoryWrite = resolution.orgScopeId;
    }
    const memoryClaim = memoryAccess
      ? { ...memoryAccess, read: baseRecallScopes, ...(orgMemoryWrite ? { orgWrite: orgMemoryWrite } : {}) }
      : undefined;
    const turnSurface = input.surface === "web" ? "web" : (session.surface ?? input.surface);
    controlClaims = {
      ...scopeAttestation,
      aud: CONTROL_PLANE_AUD,
      ...(!external && allInternal && ownCredentialsAllowed ? { ownerConnections: true } : {}),
      exp: sandboxTokenExpiry,
      ...(turnTimezone ? { timezone: turnTimezone } : {}),
      ...(destination ? { destination } : {}),
      ...(delivery.candidates.length > 0 ? { destinations: delivery.candidates } : {}),
      ...(delivery.defaultKey ? { defaultDestinationKey: delivery.defaultKey } : {}),
      ...(!external && conversation.kind !== "dm"
        ? { keychainMembers: conversation.audience.filter((p) => p.type === "internal") }
        : {}),
      ...(conversation.kind === "dm" ||
      conversation.kind === "group" ||
      conversation.isPrivate === true ||
      conversation.isMpim === true
        ? { privateScope: true }
        : {}),
      ...(memoryClaim ? { memory: memoryClaim } : {}),
      ...(liveAuthorTurn ? { liveAuthor: true } : {}),
      ...(automatedTurn ? { triggered: true } : {}),
      ...(!liveTurn && input.unattendedGrants ? { grants: input.unattendedGrants } : {}),
      ...(input.runId ? { runId: input.runId } : {}),
      sessionId: session.id,
      origin,
      runAttempt: input.attempt,
      runLeaseToken: input.runLeaseToken,
      threadRef: conversation.threadRef,
      ...(turnSurface ? { surface: turnSurface } : {}),
    };
    connectorEnv.AGENT_API_TOKEN = await mintCapabilityToken(
      controlClaims,
      deps.capabilitySecret ?? deps.signingSecret,
      deps.capabilityTokenCompression,
    );
    if (browserModel) {
      connectorEnv.BROWSE_LAB_BASE_URL = `${trimTrailingSlashes(deps.apiBaseUrl)}/v1/browser-model`;
      connectorEnv.BROWSE_LAB_MODEL_TOKEN = await mintCapabilityToken(
        {
          ...scopeAttestation,
          aud: BROWSER_MODEL_AUD,
          browserModel,
          browserAccount: sessionAuth?.account ?? "company",
          sessionId: session.id,
          origin,
          exp: Date.now() + CAPABILITY_TTL_MS,
        },
        deps.capabilitySecret ?? deps.signingSecret,
      );
    }
    if (
      deps.sandboxModels &&
      allInternal &&
      securityPolicy.posture !== "strict" &&
      (sessionAuth?.account ?? "company") === "company"
    ) {
      connectorEnv.MODEL_GATEWAY_URL = `${trimTrailingSlashes(deps.apiBaseUrl)}${SANDBOX_MODEL_PREFIX}`;
      connectorEnv.MODEL_GATEWAY_TOKEN = await mintCapabilityToken(
        { ...scopeAttestation, aud: SANDBOX_MODEL_AUD, exp: sandboxTokenExpiry },
        deps.capabilitySecret ?? deps.signingSecret,
        deps.capabilityTokenCompression,
      );
      turnContextBlocks["Model access"] =
        "## Model access\nAn OpenAI-compatible model gateway is at `$MODEL_GATEWAY_URL` in the sandbox; authenticate with `Authorization: Bearer $MODEL_GATEWAY_TOKEN`. `GET $MODEL_GATEWAY_URL/v1/models` lists the usable models. The token is bound to this turn and expires with it; never send it anywhere but the gateway.";
    }
    connectorEnv.AGENT_OAUTH_CONSENT_TOKEN = await mintCapabilityToken(
      {
        ...scopeAttestation,
        aud: OAUTH_CONSENT_AUD,
        exp: sandboxTokenExpiry,
      },
      deps.capabilitySecret ?? deps.signingSecret,
      deps.capabilityTokenCompression,
    );
  }
  return { actorIsOrgAdmin, orgMemoryWritable, controlClaims };
}
