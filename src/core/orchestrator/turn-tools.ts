import { createBackgroundBroker } from "../../connectors/background-exec-broker.ts";
import type { FileArtifact } from "../../files/file-artifact-store.ts";
import { createMonitorBroker, readBackgroundOutputTail } from "../../monitors/monitor-broker.ts";
import { entitledScopes, principalEntitledToScope } from "../../resolution/context-filter.ts";
import { defaultPublishAudience } from "../../resolution/publish-audience.ts";
import { supportsProcessSessions } from "../../sandbox/sandbox.ts";
import { isSubagentThreadRef } from "../../sessions/session-syscalls.ts";
import { scopeId as toScopeId, type Destination, type ScopeId, type Session } from "../../types.ts";
import { errMessage } from "../../util/errors.ts";
import type { ArtifactRegistration } from "../attachments.ts";
import type { createTurnSandboxes } from "./sandboxes.ts";
import { createToolContext } from "../../tools/primitives.ts";
import { createAdminCall } from "../../tools/admin.ts";
import { createSelfApiCall } from "../../tools/self-api.ts";
import { forSearchView } from "../../agent/context-compaction.ts";
import { openSessionItem, searchSessionItems } from "../../sessions/history-search.ts";
import type { Item } from "../../sessions/items.ts";
import type { MemoryProvenance } from "../../memory/facts.ts";
import type { resolveTurnContext } from "../../resolution/turn-context.ts";
import type { createSurfaceToolDeps } from "../../surfaces/surface-tools.ts";
import { desktopClientForTurn } from "../turn-origin.ts";
import type { createApprovalLedger } from "./approvals.ts";
import type { StagedAttachments } from "./attach-tool.ts";
import type { mintTurnCapabilities } from "./capability-tokens.ts";
import { createCommandCredentialResolver, type CredentialCatalog } from "./credential-catalog.ts";
import type { createSkillScreen } from "./security-screen.ts";
import type { OrchestratorDeps, OrchestratorInput } from "./types.ts";

type TurnResolution = Awaited<ReturnType<OrchestratorDeps["resolution"]["resolve"]>>;
type TurnSandboxes = ReturnType<typeof createTurnSandboxes>;
type ToolContextOptions = Parameters<typeof createToolContext>[0];
type ApprovalLedger = Awaited<ReturnType<typeof createApprovalLedger>>;
type TurnCapabilities = Awaited<ReturnType<typeof mintTurnCapabilities>>;

export function createTurnBrokers(turn: {
  deps: OrchestratorDeps;
  input: OrchestratorInput;
  actor: OrchestratorInput["actor"];
  conversation: OrchestratorInput["conversation"];
  session: Session;
  scopeId: ScopeId;
  memoryScopeId: ScopeId;
  defaultDestination: Destination | undefined;
  provision: TurnSandboxes["provision"];
  provisionJobSandbox: TurnSandboxes["provisionJobSandbox"];
  finishProcess: TurnSandboxes["finishProcess"];
  assertDefaultUsable: TurnSandboxes["assertDefaultUsable"];
}) {
  const {
    deps,
    input,
    actor,
    conversation,
    session,
    scopeId,
    memoryScopeId,
    defaultDestination,
    provision,
    provisionJobSandbox,
    finishProcess,
    assertDefaultUsable,
  } = turn;
  const backgroundBroker =
    deps.processes && supportsProcessSessions(deps.sandbox)
      ? createBackgroundBroker({
          sandbox: deps.sandbox,
          registry: deps.processes,
          provisionSandbox: provisionJobSandbox,
          onExit: finishProcess,
          scopeId: memoryScopeId,
          sessionRef: conversation.threadRef,
          ttlMs: deps.backgroundJobTtlMs,
          ttlMaxMs: deps.backgroundJobTtlMaxMs,
          assertComputerUsable: assertDefaultUsable,
        })
      : undefined;

  const readOutputTail = backgroundBroker
    ? async (processId: string, maxBytes: number) => {
        const handle = (await backgroundBroker.handleFor?.(processId)) ?? (await provision());
        return readBackgroundOutputTail(maxBytes, async (cursor, readMaxBytes) => {
          const read = await backgroundBroker.poll(handle, processId, {
            sinceCursor: cursor,
            maxBytes: readMaxBytes,
            waitMs: 0,
          });
          return {
            chunks: read.chunks,
            cursor: read.cursor,
            ...(read.status.state === "exited" ? { exitCode: read.status.code } : {}),
          };
        });
      }
    : undefined;

  const monitorBroker =
    deps.monitors && deps.processes && readOutputTail
      ? createMonitorBroker({
          store: deps.monitors,
          registry: deps.processes,
          readOutputTail,
          scopeId: memoryScopeId,
          owner: actor.id,
          ownerScopeId: scopeId,
          ...(input.botActor ? { botActor: true } : {}),
          threadRef: conversation.threadRef,
          ...(defaultDestination ? { destination: defaultDestination } : {}),
          returnsToParent: isSubagentThreadRef(conversation.threadRef) && Boolean(session.parentSessionId),
          assertComputerUsable: assertDefaultUsable,
        })
      : undefined;
  return { backgroundBroker, monitorBroker };
}

export function createFileRegistration(turn: {
  deps: OrchestratorDeps;
  input: OrchestratorInput;
  actor: OrchestratorInput["actor"];
  conversation: OrchestratorInput["conversation"];
  session: Session;
  scopeId: ScopeId;
  external: boolean;
  resolution: TurnResolution;
}): ArtifactRegistration {
  const { deps, input, actor, conversation, session, scopeId, external, resolution } = turn;
  const fileAudience =
    !external && resolution.orgScopeId
      ? defaultPublishAudience({
          kind: conversation.kind,
          ...(conversation.isPrivate !== undefined ? { isPrivate: conversation.isPrivate } : {}),
          ...(conversation.isMpim !== undefined ? { isMpim: conversation.isMpim } : {}),
          ...(conversation.publishMembers ? { members: conversation.publishMembers } : {}),
          orgScopeId: resolution.orgScopeId,
          ownerId: actor.id,
        }).grantees
      : [];
  const fileOwnerScopeId = external ? scopeId : toScopeId("personal", actor.id);
  const fileGrantees = [...fileAudience];
  if ((conversation.kind === "group" || conversation.kind === "dm") && scopeId !== fileOwnerScopeId) {
    fileGrantees.push(scopeId);
  }
  const fileRegistration: ArtifactRegistration = {
    store: deps.files,
    ownerScopeId: fileOwnerScopeId,
    createdBy: actor.id,
    createdInScope: scopeId,
    seed: input.runId ?? `${session.id}:${Date.now()}`,
    ...(fileGrantees.length
      ? {
          onRegistered: async ({ ownerScopeId, id }) => {
            for (const granteeScopeId of fileGrantees) {
              await deps.acl.grant({
                ownerScopeId,
                ref: id,
                granteeScopeId,
                permission: "read",
                grantedBy: actor.id,
              });
            }
          },
        }
      : {}),
    onError: (e) =>
      deps.errors.record(
        {
          category: "file_store",
          code: "register_failed",
          message: errMessage(e),
          scopeLabel: scopeId,
          sessionId: session.id,
        },
        e,
      ),
  };
  return fileRegistration;
}

export function createArtifactAccess(turn: {
  deps: OrchestratorDeps;
  conversation: OrchestratorInput["conversation"];
  scopeId: ScopeId;
  resolution: TurnResolution;
  provision: TurnSandboxes["provision"];
  provisionResource: TurnSandboxes["provisionResource"];
}) {
  const { deps, conversation, scopeId, resolution, provision, provisionResource } = turn;
  let readableHandles: Awaited<ReturnType<typeof deps.acl.handlesForAudience>> | undefined;
  const mayReadArtifact = async (artifact: FileArtifact, fresh = false): Promise<boolean> => {
    if (
      conversation.audience.every((principal) =>
        principalEntitledToScope(principal, artifact.ownerScopeId, scopeId, resolution.orgScopeId),
      )
    )
      return true;
    let handles = fresh ? undefined : readableHandles;
    handles ??= await deps.acl.handlesForAudience(
      conversation.audience,
      scopeId,
      resolution.orgScopeId,
      entitledScopes,
    );
    if (!fresh) readableHandles = handles;
    return handles.some((handle) => handle.ownerScopeId === artifact.ownerScopeId && handle.fileId === artifact.id);
  };
  const provisionOutbound = (sandboxId?: string) =>
    sandboxId !== undefined ? provisionResource(sandboxId) : provision();
  const openStoredOutbound = async (id: string) => {
    const artifact = await deps.files.get(id);
    if (!artifact || !(await mayReadArtifact(artifact, true))) return null;
    const opened = await deps.files.open(id);
    return opened ? { ...artifact, sizeBytes: opened.sizeBytes, stream: opened.stream } : null;
  };
  return { mayReadArtifact, provisionOutbound, openStoredOutbound };
}

interface ToolContextTurn {
  deps: OrchestratorDeps;
  input: OrchestratorInput;
  actor: OrchestratorInput["actor"];
  conversation: OrchestratorInput["conversation"];
  session: Session;
  scopeId: ScopeId;
  resolution: TurnResolution;
  external: boolean;
  humanInput: boolean;
  strictReadOnly: boolean;
  securityPolicy: TurnResolution["securityPolicy"];
  surface: ReturnType<OrchestratorDeps["surfaces"]["get"]>;
  context: Awaited<ReturnType<typeof resolveTurnContext>>;
  memoryScopeId: ScopeId;
  memoryAccess: ToolContextOptions["memoryAccess"];
  audienceScopeId: ScopeId | undefined;
  actAsActor: boolean;
  turnSandboxResources: ToolContextOptions["sandboxResources"];
  invalidateProvision: TurnSandboxes["invalidateProvision"];
  provision: TurnSandboxes["provision"];
  provisionScratch: TurnSandboxes["provisionScratch"];
  provisionJobComputer: TurnSandboxes["provisionJobComputer"];
  provisionResource: TurnSandboxes["provisionResource"];
  accessResource: TurnSandboxes["accessResource"];
  assertDefaultUsable: TurnSandboxes["assertDefaultUsable"];
  boundSandboxId: TurnSandboxes["boundSandboxId"];
  workdir: TurnSandboxes["workdir"];
  useSkill: TurnSandboxes["useSkill"];
  visibleSkillsForTurn: ReturnType<typeof createSkillScreen>;
  commandPolicy: TurnResolution["commandPolicy"];
  layerCommandRules: NonNullable<OrchestratorDeps["deploymentLayer"]>["commandRules"][number][];
  authorizeCommand: ApprovalLedger["authorizeCommand"];
  restoreCommand: ApprovalLedger["restoreCommand"];
  credentialCatalog: CredentialCatalog;
  commandCredentials: CredentialCatalog["commandCredentials"];
  connectorEnv: CredentialCatalog["connectorEnv"];
  actorIsOrgAdmin: TurnCapabilities["actorIsOrgAdmin"];
  controlClaims: TurnCapabilities["controlClaims"];
  scopeAttestation: TurnCapabilities["scopeAttestation"];
  sandboxTokenExpiry: TurnCapabilities["sandboxTokenExpiry"];
  captureDependencies: () => MemoryProvenance[];
  filterHistory: (items: Item[]) => Item[];
  attachStaging: StagedAttachments;
  surfaceToolDeps: ReturnType<typeof createSurfaceToolDeps>;
  turnSessionSyscalls: ToolContextOptions["sessionSyscalls"];
  backgroundBroker: ReturnType<typeof createTurnBrokers>["backgroundBroker"];
  monitorBroker: ReturnType<typeof createTurnBrokers>["monitorBroker"];
}

export function buildToolContext(turn: ToolContextTurn) {
  const {
    deps,
    input,
    actor,
    conversation,
    session,
    scopeId,
    resolution,
    external,
    humanInput,
    strictReadOnly,
    securityPolicy,
    surface,
    context,
    memoryScopeId,
    memoryAccess,
    audienceScopeId,
    actAsActor,
    turnSandboxResources,
    invalidateProvision,
    provision,
    provisionScratch,
    provisionJobComputer,
    provisionResource,
    accessResource,
    assertDefaultUsable,
    boundSandboxId,
    workdir,
    useSkill,
    visibleSkillsForTurn,
    commandPolicy,
    layerCommandRules,
    authorizeCommand,
    restoreCommand,
    credentialCatalog,
    commandCredentials,
    connectorEnv,
    actorIsOrgAdmin,
    controlClaims,
    scopeAttestation,
    sandboxTokenExpiry,
    captureDependencies,
    filterHistory,
    attachStaging,
    surfaceToolDeps,
    turnSessionSyscalls,
    backgroundBroker,
    monitorBroker,
  } = turn;
  return createToolContext({
    desktopClientId: desktopClientForTurn(input),
    sandbox: deps.sandbox,
    sandboxResources: turnSandboxResources,
    invalidateProvision,
    provision,
    provisionScratch,
    provisionJobComputer,
    provisionResource,
    accessSandboxResource: accessResource,
    assertDefaultSandboxUsable: assertDefaultUsable,
    boundSandboxId,
    workdir,
    useSkill,
    listSkills: (source) => visibleSkillsForTurn(source ? [source] : [scopeId, resolution.orgScopeId]),
    writableScopeId: resolution.writableScopeId,
    readOnlyScopeIds: resolution.readOnlyScopeIds,
    commandPolicy: () => commandPolicy,
    layerCommandRules: () => layerCommandRules,
    authorizeCommand,
    restoreCommand,
    grantedHandles: resolution.grantedHandles,
    context,
    deploy: deps.deploy,
    acl: deps.acl,
    files: deps.files,
    auditLog: deps.auditLog,
    createdBy: actor.id,
    botActor: input.botActor,
    commandCredentials,
    resolveCommandCredentials: createCommandCredentialResolver(credentialCatalog, {
      scopeAttestation,
      sandboxTokenExpiry,
    }),
    ...(deps.publicWebUrl ? { publicWebUrl: deps.publicWebUrl } : {}),
    publishContext: {
      conversationKind: conversation.kind,
      ...(conversation.channelRef ? { channelRef: conversation.channelRef } : {}),
      ...(conversation.isPrivate !== undefined ? { isPrivate: conversation.isPrivate } : {}),
      ...(conversation.isMpim !== undefined ? { isMpim: conversation.isMpim } : {}),
      ...(conversation.publishMembers ? { publishMembers: conversation.publishMembers } : {}),
    },
    config: deps.config,
    ...(deps.control && controlClaims ? { control: deps.control, controlClaims } : {}),
    ...(deps.apiBaseUrl && connectorEnv.AGENT_API_TOKEN
      ? {
          ...(securityPolicy.posture !== "strict"
            ? { selfApi: createSelfApiCall(deps.apiBaseUrl, connectorEnv.AGENT_API_TOKEN) }
            : {}),
          admin: {
            call: createAdminCall(deps.apiBaseUrl, connectorEnv.AGENT_API_TOKEN),
            operationsAvailable:
              actorIsOrgAdmin || Boolean(controlClaims?.grants?.some((grant) => grant.startsWith("admin."))),
          },
        }
      : {}),
    ...(deps.webhookPublicUrl ? { webhookPublicUrl: deps.webhookPublicUrl } : {}),
    ...(humanInput && !external && !input.botActor ? { humanTurn: true } : {}),
    toolOutput: deps.toolOutput,
    sessionId: session.id,
    ...(surfaceToolDeps ? { surface: surfaceToolDeps } : {}),
    ...(turnSessionSyscalls ? { sessionSyscalls: turnSessionSyscalls } : {}),
    ...(strictReadOnly ? {} : { attach: attachStaging.attach }),
    memory: context.memory,
    memoryCaptureMetadata: () => ({ sessionId: session.id, inheritedFacts: captureDependencies() }),
    memoryScopeId,
    ...(memoryAccess ? { memoryAccess } : {}),
    ...(!external && deps.mcp ? { mcp: deps.mcp, actAsActor } : {}),
    ...(audienceScopeId ? { audienceScopeId } : {}),
    ...(surface?.capabilities.nativeActor ? { actingSlackUserId: actor.id } : {}),
    ...(deps.deploymentLayer
      ? {
          layerAuth: {
            credentialPaths: deps.deploymentLayer.credentialPaths,
            splitEnvTemplates: deps.deploymentLayer.splitEnvTemplates,
          },
        }
      : {}),
    sessionHistory: (() => {
      const historyView = async () => filterHistory(forSearchView(await deps.sessions.getItems(session.id)));
      return {
        search: async (q: string, limit?: number) => searchSessionItems(await historyView(), q, limit),
        open: async (seq: number) => openSessionItem(await historyView(), seq),
      };
    })(),
    execTimeoutMs: deps.execTimeoutMs,
    execTimeoutCeilingMs: deps.execTimeoutCeilingMs,
    signals: deps.signals,
    ...(input.runId ? { runId: input.runId } : {}),
    ...(backgroundBroker ? { backgroundBroker } : {}),
    ...(monitorBroker ? { monitorBroker } : {}),
  });
}
