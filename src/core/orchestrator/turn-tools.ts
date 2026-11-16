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
import type { OrchestratorDeps, OrchestratorInput } from "./types.ts";
import type { Tenant } from "../../tenants/context.ts";

type TurnResolution = Awaited<ReturnType<OrchestratorDeps["resolution"]["resolve"]>>;
type TurnSandboxes = ReturnType<typeof createTurnSandboxes>;

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
          ...(input.runId ? { runId: input.runId } : {}),
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
  tenant: Tenant;
  deps: OrchestratorDeps;
  input: OrchestratorInput;
  actor: OrchestratorInput["actor"];
  conversation: OrchestratorInput["conversation"];
  session: Session;
  scopeId: ScopeId;
  external: boolean;
  resolution: TurnResolution;
}): ArtifactRegistration {
  const { tenant, deps, input, actor, conversation, session, scopeId, external, resolution } = turn;
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
              await deps.acl.grant(tenant, {
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
        tenant,
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
  tenant: Tenant;
  deps: OrchestratorDeps;
  conversation: OrchestratorInput["conversation"];
  scopeId: ScopeId;
  resolution: TurnResolution;
  provision: TurnSandboxes["provision"];
  provisionResource: TurnSandboxes["provisionResource"];
  ownScopeBotWork: boolean;
}) {
  const { tenant, deps, conversation, scopeId, resolution, provision, provisionResource, ownScopeBotWork } = turn;
  let readableHandles: Awaited<ReturnType<typeof deps.acl.handlesForAudience>> | undefined;
  const mayReadArtifact = async (artifact: FileArtifact, storedById = false): Promise<boolean> => {
    const libraryReach = storedById && ownScopeBotWork;
    if (
      conversation.audience.every((principal) =>
        principalEntitledToScope(principal, artifact.ownerScopeId, scopeId, resolution.orgScopeId, libraryReach),
      )
    )
      return true;
    let handles = storedById ? undefined : readableHandles;
    handles ??= await deps.acl.handlesForAudience(
      tenant,
      conversation.audience,
      scopeId,
      resolution.orgScopeId,
      entitledScopes(libraryReach),
    );
    if (!storedById) readableHandles = handles;
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
