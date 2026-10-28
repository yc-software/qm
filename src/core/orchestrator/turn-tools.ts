import { surfaceHas } from "../../surfaces/surface.ts";
import type { TurnCtx } from "./turn-context.ts";
import type { ApprovalLedger } from "./approvals.ts";
import type { buildCredentialCatalog } from "./credential-catalog.ts";
import type { frameTurnPrompt } from "./turn-prompt.ts";
import type { Session } from "../../types.ts";
import type { MemoryProvenance } from "../../memory/facts.ts";
import { createAdminCall } from "../../tools/admin.ts";
import { externalTools } from "./external-tools.ts";
import { type DeliveryProvenance, type Destination, type ScopeId } from "../../types.ts";
import { scopeId as toScopeId, personalScope } from "../../types.ts";
import { desktopClientForTurn } from "../turn-origin.ts";
import { resolveTurnContext } from "../../resolution/turn-context.ts";
import { resolveReachableChannel } from "../../resolution/scope-reach.ts";
import { reachPost } from "../../reach/reach.ts";
import { turnPostProvenance } from "../../surfaces/outbound.ts";
import { supportsProcessSessions } from "../../sandbox/sandbox.ts";
import { createBackgroundBroker } from "../../connectors/background-exec-broker.ts";
import { createMonitorBroker, readBackgroundOutputTail } from "../../monitors/monitor-broker.ts";
import { finishProcessCredentials } from "../../credentials/execute-files.ts";
import type { GapWork } from "../../harness/harness.ts";
import { forSearchView } from "../../harness/context-compaction.ts";
import { createToolContext } from "../../tools/tool-context.ts";
import { type CommandCredential } from "../../tools/primitives.ts";
import type { FileArtifact } from "../../files/file-artifact-store.ts";
import { principalEntitledToScope } from "../../resolution/context-filter.ts";
import { openSessionItem, searchSessionItems } from "../../sessions/history-search.ts";
import { defaultPublishAudience } from "../../resolution/publish-audience.ts";
import { type ArtifactRegistration } from "../attachments.ts";
import { errMessage, swallow, swallowAs } from "../../util/errors.ts";
import { randomUUID } from "node:crypto";
import type { OrchestratorDeps } from "./types.ts";
import { turnPostKeys } from "./turn-helpers.ts";
import { createTurnSandboxes } from "./sandboxes.ts";
import { createSurfaceToolDeps, type SpineState } from "./surface-tools.ts";
import { createAttachStaging } from "./attach-tool.ts";

/** What the turn's tool context is built from: the session, prompt framing, credentials, sandboxes and approvals. */
export interface TurnToolsInput {
  session: Session;
  strictReadOnly: boolean;
  context: Awaited<ReturnType<typeof resolveTurnContext>>;
  framed: Awaited<ReturnType<typeof frameTurnPrompt>>;
  catalog: Awaited<ReturnType<typeof buildCredentialCatalog>>;
  sandboxes: ReturnType<typeof createTurnSandboxes>;
  approvalLedger: ApprovalLedger;
  commandPolicy: TurnCtx["resolution"]["commandPolicy"];
  layerCommandRules: NonNullable<OrchestratorDeps["deploymentLayer"]>["commandRules"];
  reachAvailable: boolean;
  turnSandboxResources: OrchestratorDeps["sandboxResources"];
  gapWork: { listener?: (work: GapWork) => void };
  turnAbort: AbortController;
  captureDependencies: () => MemoryProvenance[];
  blobTransfer: OrchestratorDeps["blobTransfer"];
}

/** Builds the turn's tool context and the state the delivery and segment phases share with it. */
export async function buildTurnTools(ctx: TurnCtx, turn: TurnToolsInput) {
  const { deps, input, actor, conversation, external, humanInput, liveTurn, scopeId } = ctx;
  const { session, strictReadOnly, blobTransfer } = turn;
  const { defaultDestination } = turn.framed;
  const { provision, accessResource, provisionResource } = turn.sandboxes;
  const { backgroundBroker, monitorBroker } = createProcessBrokers(ctx, turn);

  const spine: SpineState = {
    surfaceOutboundCount: 0,
    crossConversationPosts: 0,
    turnUserEntrySeq: undefined,
  };
  const turnKey = input.runId ?? randomUUID();
  const postKeys = turnPostKeys(turnKey);
  const spineFirst: { block: string; open: boolean; ackText?: string } = { block: "", open: true };
  const fileRegistration = createFileRegistration(ctx, session);
  const postProvenance = (deliveryKey: string): DeliveryProvenance =>
    turnPostProvenance({
      origin: input.origin,
      surface: input.surface,
      fireKey: deliveryKey,
      sourceScopeId: scopeId as ScopeId,
      sourceThreadRef: session.threadRef,
      sourceSessionId: session.id,
    });
  const earlyTaskAck =
    surfaceHas(input.surface, "earlyAck") &&
    humanInput &&
    conversation.kind === "dm" &&
    !input.approval &&
    !input.botActor;
  const mayReadArtifact = artifactReadCheck(ctx);
  const provisionOutbound = (sandboxId?: string) =>
    sandboxId !== undefined ? provisionResource(sandboxId) : provision();
  const openStoredOutbound = async (id: string) => {
    const artifact = await deps.files.get(id);
    if (!artifact || !(await mayReadArtifact(artifact, true))) return null;
    const opened = await deps.files.open(id);
    return opened ? { ...artifact, sizeBytes: opened.sizeBytes, stream: opened.stream } : null;
  };
  const surfaceToolDeps = createSurfaceToolDeps({
    deps,
    input,
    actor,
    conversation,
    session,
    scopeId,
    strictReadOnly,
    defaultDestination,
    blobTransfer,
    fileRegistration,
    provision: provisionOutbound,
    openStored: openStoredOutbound,
    postProvenance,
    postKeys,
    spine,
  });
  const attachStaging = createAttachStaging({
    sandbox: deps.sandbox,
    provision: provisionOutbound,
    openStored: openStoredOutbound,
    blobTransfer,
    fileRegistration,
  });
  if (input.surfaceTools && input.origin.kind === "automation" && input.origin.destination && !surfaceToolDeps)
    console.error(
      `[orchestrator] trigger delivery has no surface tools (no outbound sender?) — reply would be lost session=${session.id}`,
    );

  const canInstallCanvas =
    deps.installSharedCanvas &&
    liveTurn &&
    (await deps.featureFlags?.enabled("ui_canvas", personalScope(actor.id))) === true;
  const baseTools = await createTurnToolContext(ctx, turn, {
    canInstallCanvas,
    surfaceToolDeps,
    attachStaging,
    backgroundBroker,
    monitorBroker,
  });

  const tools = external ? externalTools(baseTools, accessResource) : baseTools;
  return {
    spine,
    postKeys,
    spineFirst,
    fileRegistration,
    postProvenance,
    earlyTaskAck,
    turnKey,
    mayReadArtifact,
    surfaceToolDeps,
    attachStaging,
    tools,
  };
}

/** The turn's background-process and monitor brokers, when the sandbox supports process sessions. */
function createProcessBrokers(ctx: TurnCtx, turn: TurnToolsInput) {
  const { deps, input, actor, conversation, scopeId } = ctx;
  const { memoryScopeId } = turn.context;
  const { defaultDestination } = turn.framed;
  const { provision, provisionJobSandbox } = turn.sandboxes;
  const backgroundBroker =
    deps.processes && supportsProcessSessions(deps.sandbox)
      ? createBackgroundBroker({
          sandbox: deps.sandbox,
          registry: deps.processes,
          provisionSandbox: provisionJobSandbox,
          onExit: (handle, processId) =>
            finishProcessCredentials(
              {
                sandbox: deps.sandbox,
                processes: deps.processes!,
                ...(deps.keychain ? { keychain: deps.keychain } : {}),
              },
              handle,
              processId,
            ),
          scopeId: memoryScopeId,
          sessionRef: conversation.threadRef,
          ...(input.runId ? { runId: input.runId } : {}),
          ...(deps.backgroundJobTtlMs !== undefined ? { ttlMs: deps.backgroundJobTtlMs } : {}),
          ...(deps.backgroundJobTtlMaxMs !== undefined ? { ttlMaxMs: deps.backgroundJobTtlMaxMs } : {}),
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
    deps.monitors && deps.processes && supportsProcessSessions(deps.sandbox)
      ? createMonitorBroker({
          store: deps.monitors,
          registry: deps.processes,
          readOutputTail: readOutputTail ?? (async () => ({ outputTail: "" })),
          scopeId: memoryScopeId,
          owner: actor.id,
          ownerScopeId: scopeId,
          threadRef: conversation.threadRef,
          ...(defaultDestination ? { destination: defaultDestination } : {}),
        })
      : undefined;
  return { backgroundBroker, monitorBroker };
}

/** Where files the turn registers are owned, and who is granted read access to them. */
function createFileRegistration(ctx: TurnCtx, session: Session): ArtifactRegistration {
  const { deps, input, actor, conversation, external, resolution, scopeId } = ctx;
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
      deps.errors?.record(
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

/** Whether everyone in the conversation may read an artifact; ACL handles are cached unless asked fresh. */
function artifactReadCheck(ctx: TurnCtx): (artifact: FileArtifact, fresh?: boolean) => Promise<boolean> {
  const { deps, conversation, resolution, scopeId } = ctx;
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
      principalEntitledToScope,
    );
    if (!fresh) readableHandles = handles;
    return handles.some((handle) => handle.ownerScopeId === artifact.ownerScopeId && handle.fileId === artifact.id);
  };
  return mayReadArtifact;
}

/** Re-resolves the command credentials for a set of handles, rejecting handle collisions. */
function commandCredentialResolver(catalog: TurnToolsInput["catalog"]) {
  const {
    commandCredentials,
    credentialBroker,
    registerKeychainCredentials,
    registerConnectorCredentials,
    registerServiceCredentials,
    placeCredential,
  } = catalog;
  return async (handles: Parameters<typeof credentialBroker>[0]) => {
    const refreshed = new Map<string, CommandCredential>();
    const identities = new Map<string, string>();
    const add: Parameters<typeof registerKeychainCredentials>[0] = (
      credential,
      _description,
      identity = credential.handle,
    ) => {
      const prior = identities.get(credential.handle);
      if (prior !== undefined) {
        if (prior !== identity) throw new Error(`credential handle collision: ${credential.handle}`);
        return;
      }
      identities.set(credential.handle, identity);
      refreshed.set(credential.handle, placeCredential(credential));
    };
    const broker = credentialBroker(handles);
    await registerKeychainCredentials(add, broker);
    await registerConnectorCredentials(add, broker);
    await registerServiceCredentials(add, broker);
    for (const credential of commandCredentials.filter((candidate) => candidate.handle.startsWith("broker_")))
      add(credential, "");
    return [...refreshed.values()];
  };
}

/** The session-history search/open tools over the turn's filtered transcript. */
function sessionHistoryTools(ctx: TurnCtx, session: Session) {
  const { deps, filterHistory } = ctx;
  const historyView = async () => filterHistory(forSearchView(await deps.sessions.getItems(session.id)));
  return {
    search: async (q: string, limit?: number) => searchSessionItems(await historyView(), q, limit),
    open: async (seq: number) => {
      const item = await deps.sessions.getItem(session.id, seq);
      if (!item) return null;
      const view = item.kind === "ContextCompaction" ? await historyView() : filterHistory(forSearchView([item]));
      return openSessionItem(view, seq);
    },
  };
}

/** The turn's tool context: sandboxes, credentials, publishing, memory, session tools and brokers. */
function createTurnToolContext(
  ctx: TurnCtx,
  turn: TurnToolsInput,
  parts: {
    surfaceToolDeps: ReturnType<typeof createSurfaceToolDeps>;
    attachStaging: ReturnType<typeof createAttachStaging>;
    canInstallCanvas: boolean | undefined;
  } & ReturnType<typeof createProcessBrokers>,
) {
  const { deps, input, actor, conversation, external, humanInput, liveTurn, resolution, scopeId } = ctx;
  const {
    session,
    strictReadOnly,
    context,
    commandPolicy,
    layerCommandRules,
    reachAvailable,
    turnSandboxResources,
    gapWork,
    turnAbort,
    captureDependencies,
  } = turn;
  const { memoryScopeId, memoryAccess } = turn.context;
  const { sessionSyscalls, visibleSkillsForTurn } = turn.framed;
  const { connectorEnv, commandCredentials, actorIsOrgAdmin, controlClaims } = turn.catalog;
  const {
    provision,
    provisionScratch,
    accessResource,
    provisionResource,
    provisionJobComputer,
    useSkill,
    provisionForReach,
    invalidateProvision,
  } = turn.sandboxes;
  const { authorizeCommand } = turn.approvalLedger;
  const { surfaceToolDeps, attachStaging, backgroundBroker, monitorBroker, canInstallCanvas } = parts;
  return createToolContext({
    desktopClientId: desktopClientForTurn(input),
    ...(canInstallCanvas
      ? {
          installSharedCanvas: (fileId: string) =>
            deps.installSharedCanvas!(actor.id, fileId, {
              threadRef: conversation.threadRef,
              sessionId: session.id,
            }),
        }
      : {}),
    sandbox: deps.sandbox,
    sandboxResources: turnSandboxResources,
    invalidateProvision,
    provision,
    provisionScratch,
    provisionJobComputer,
    provisionResource,
    accessSandboxResource: accessResource,
    useSkill,
    listSkills: (source) => visibleSkillsForTurn(source ? [source] : [scopeId, resolution.orgScopeId]),
    ...(reachAvailable
      ? {
          reach: {
            resolveChannel: (q: string) =>
              resolveReachableChannel(q, { directory: deps.directory!, actorId: actor.id }),
            provisionFor: provisionForReach,
          },
        }
      : {}),
    layers: resolution.layers,
    commandPolicy: () => commandPolicy,
    layerCommandRules: () => layerCommandRules,
    authorizeCommand,
    grantedHandles: resolution.grantedHandles,
    context,
    workspace: deps.workspace,
    deploy: deps.deploy,
    acl: deps.acl,
    files: deps.files,
    auditLog: deps.auditLog,
    createdBy: actor.id,
    commandCredentials,
    resolveCommandCredentials: commandCredentialResolver(turn.catalog),
    ...(deps.publicWebUrl ? { publicWebUrl: deps.publicWebUrl } : {}),
    publishContext: publishContextFor(conversation),
    ...(deps.config ? { config: deps.config } : {}),
    ...(deps.control && controlClaims ? { control: deps.control, controlClaims } : {}),
    ...(deps.apiBaseUrl && connectorEnv.AGENT_API_TOKEN
      ? {
          admin: {
            call: createAdminCall(deps.apiBaseUrl, connectorEnv.AGENT_API_TOKEN),
            operationsAvailable:
              actorIsOrgAdmin || Boolean(controlClaims?.grants?.some((grant) => grant.startsWith("admin."))),
          },
        }
      : {}),
    ...(deps.webhookPublicUrl ? { webhookPublicUrl: deps.webhookPublicUrl } : {}),
    ...(humanInput && !external ? { humanTurn: true } : {}),
    ...(deps.toolOutput ? { toolOutput: deps.toolOutput, sessionId: session.id } : {}),
    ...(surfaceToolDeps ? { surface: surfaceToolDeps } : {}),
    ...(sessionSyscalls
      ? {
          sessionSyscalls: sessionSyscalls.forTurn({
            session,
            scopeId: scopeId as ScopeId,
            orgScopeId: resolution.orgScopeId,
            liveTurn,
            request: { ...input, readOnly: strictReadOnly, cancel: turnAbort.signal },
          }),
        }
      : {}),
    ...(strictReadOnly ? {} : { attach: attachStaging.attach }),
    memory: context.memory,
    memoryCaptureMetadata: () => ({ sessionId: session.id, inheritedFacts: captureDependencies() }),
    memoryScopeId,
    ...(memoryAccess ? { memoryAccess } : {}),
    ...(!external && deps.mcp ? { mcp: deps.mcp } : {}),
    ...(surfaceHas(input.surface, "nativeActorIds") ? { actingSlackUserId: actor.id } : {}),
    ...(deps.deploymentLayer
      ? {
          layerAuth: {
            credentialPaths: deps.deploymentLayer.credentialPaths,
            splitEnvTemplates: deps.deploymentLayer.splitEnvTemplates,
          },
        }
      : {}),
    sessionHistory: sessionHistoryTools(ctx, session),
    ...(deps.execTimeoutMs !== undefined ? { execTimeoutMs: deps.execTimeoutMs } : {}),
    ...(deps.execTimeoutCeilingMs !== undefined ? { execTimeoutCeilingMs: deps.execTimeoutCeilingMs } : {}),
    ...(deps.ledger ? { ledger: deps.ledger } : {}),
    ...(deps.signals ? { signals: deps.signals } : {}),
    ...(input.runId ? { runId: input.runId } : {}),
    attempt: input.attempt ?? 1,
    ...(backgroundBroker ? { backgroundBroker } : {}),
    ...(monitorBroker ? { monitorBroker } : {}),
    onGapWork: (work) => {
      try {
        gapWork.listener?.(work);
      } catch (e) {
        swallow("gap-work forward", e);
      }
    },
  });
}

export function firstAckPublisher(
  ctx: TurnCtx,
  turn: {
    turnTools: Awaited<ReturnType<typeof buildTurnTools>>;
    defaultDestination: Destination | undefined;
    isPollFire: boolean;
    resume: unknown;
    approvalReplay: boolean;
  },
): (deliberatePost: boolean) => void {
  const { deps, input, sessionTurn } = ctx;
  const { spineFirst, postProvenance, turnKey } = turn.turnTools;
  const { defaultDestination, isPollFire, resume, approvalReplay } = turn;
  return (deliberatePost: boolean) => {
    if (!input.runId || !input.addressed || sessionTurn || isPollFire || !spineFirst.open || resume || approvalReplay)
      return;
    spineFirst.open = false;
    const ack = spineFirst.block.trim();
    if (deliberatePost || !ack || !defaultDestination || !deps.outbound) return;
    spineFirst.ackText = ack;
    const runId = input.runId;
    const ackKey = `ack:${turnKey}`;
    void reachPost({
      outbound: deps.outbound,
      destination: defaultDestination,
      text: ack,
      idempotencyKey: ackKey,
      provenance: postProvenance(ackKey),
    })
      .then(() => deps.turnStream?.markSurfacePosted(runId))
      .catch(swallowAs("orchestrator: first-block ack", undefined));
  };
}

/** How the conversation looks to the publish tools when they pick a default audience. */
function publishContextFor(conversation: TurnCtx["conversation"]) {
  return {
    conversationKind: conversation.kind,
    ...(conversation.channelRef ? { channelRef: conversation.channelRef } : {}),
    ...(conversation.isPrivate !== undefined ? { isPrivate: conversation.isPrivate } : {}),
    ...(conversation.isMpim !== undefined ? { isMpim: conversation.isMpim } : {}),
    ...(conversation.publishMembers ? { publishMembers: conversation.publishMembers } : {}),
  };
}
