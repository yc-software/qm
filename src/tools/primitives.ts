import type { Tenant } from "../tenants/context.ts";
import { trialCronScript, type CronScriptTrial } from "../cron/script.ts";
import type { AdminToolAccess } from "./admin.ts";
import type { SelfApiCall } from "./self-api.ts";
import { parkedOutputKey, TOOL_OUTPUT_RETENTION_DAYS, type ToolOutputStore } from "../sessions/tool-output.ts";
import { rankedSkills } from "../skills/materialize.ts";
import type { SkillResolution } from "../skills/skill-store.ts";
import {
  prepareExecutionFiles,
  processCredentialFiles,
  type ExecutionFileCredential,
} from "../credentials/execute-files.ts";
import type { MemoryCaptureMetadata } from "../memory/facts.ts";
import { disclosedMemory } from "../memory/disclosure.ts";
import { MaskedExecutionError, executionSecretEnv, createExactSecretValueMasker } from "../security/secret-masking.ts";
import { withAbort, withTimeout } from "../util/async.ts";
import type { RuntimeRequest, RuntimeResult } from "../agent/runtime-types.ts";
import { readContextFile } from "../resolution/context-files.ts";
import { type TurnContext } from "../resolution/turn-context.ts";
import { canReadNotebook, readNotebook, searchNotebooks } from "../memory/cross-scope.ts";
import type { SandboxAccessPlan, SandboxResource, SandboxResources } from "../sandbox/sandbox-resources.ts";
import { posix } from "node:path";
import { posixJoin, workspacePathOf } from "../sandbox/exec-file-ops.ts";
import { shq } from "../util/shell.ts";
import { DROPPED_PROXY_ENV } from "../sandbox/sandbox-env.ts";
import { interpolateSplitEnv } from "../deployment/deployment-layer.ts";
import type { CredentialPathSpec } from "../credentials/resident-paths.ts";
import type { ComputerStatus, ExecResult, Sandbox, SandboxHandle } from "../sandbox/sandbox.ts";
import { CapabilityUnsupportedError, hasParentPathSegment, supportsAgentComputerExport } from "../sandbox/sandbox.ts";
import type {
  ApprovalGrantModes,
  ClientToolResult,
  CommandPolicy,
  CommandRule,
  ConversationKind,
  GrantedHandle,
  Permission,
  Principal,
  ScopeId,
} from "../types.ts";
import { parseScopeId, scopeId } from "../types.ts";
import { type PublishAudienceKind } from "../resolution/publish-audience.ts";
import type { BotPolicy } from "../surface-cache/channel-policy-store.ts";
import type { SessionSyscalls } from "../sessions/session-syscalls.ts";
import { evaluateCommandWithLayer } from "../policy/command-policy.ts";
import { waitForClientResult, type RunSignalStore } from "../runs/run-signal-store.ts";
import type {
  BackgroundCredentials,
  BackgroundExecBroker,
  BackgroundStartResult,
  BackgroundPollResult,
  BackgroundStopResult,
  BackgroundWriteResult,
  BackgroundJobSummary,
} from "../connectors/background-exec-broker.ts";
import type { MonitorBroker, BackgroundWatchResult, BackgroundUnwatchResult } from "../monitors/monitor-broker.ts";
import { deploymentEntrypoint, type DeployService, type DeployFile } from "../deploy/deploy-service.ts";
import { appUrlOf } from "../deploy/deploy-store.ts";
import { carriesGitMetadata } from "../deploy/deploy-fs.ts";
import type { LiveEditSaved } from "../deploy/live-edits.ts";
import type { AclStore } from "../acl/acl-store.ts";
import type { AuditLog } from "../audit/audit-log.ts";
import type { OutboundFile } from "../core/attachments.ts";
import { errMessage, withCleanup } from "../util/errors.ts";
import { quotedData, trimTrailingSlashes } from "../util/text.ts";
import type { FileArtifactStore } from "../files/file-artifact-store.ts";
import type { ScopedConfigStore } from "../resolution/config-store.ts";
import { MEMORY_FILE, turnAuthority, type MemoryEdit, type MemoryService } from "../memory/memory-service.ts";
import {
  withProviders,
  writeFacts,
  type MemoryProviderProblem,
  type MemoryWrite,
  type OutcomeReport,
} from "../memory/provider-outcome.ts";
import type { McpToolService } from "../mcp/mcp-tool-service.ts";
import type {
  ControlService,
  CronCreateRequest,
  CronCreateResult,
  CronPatchRequest,
  CronRunsRequest,
  CronRunsResult,
  WebhookCreateRequest,
  WebhookCreateResult,
  ControlOk,
  ControlErr,
} from "../api/control-service.ts";
import type { ShareArtifactRequest, ShareArtifactResult } from "../api/artifact-share.ts";
import type { Cron, Webhook } from "../triggers/types.ts";
import type { CapabilityClaims } from "../auth/capability-token.ts";
import type { VisibleCron } from "../api/app.ts";
import { createPlaygroundArtifact, type PlaygroundArtifact } from "../playgrounds/playground.ts";

export interface PublishInput {
  dir?: string;
  entrypoint?: string;
  name?: string;
  renameFrom?: string;
  env?: Record<string, string>;
  rollbackTo?: number;
  alwaysOn?: boolean;
  embedAncestors?: string[];
  public?: boolean;
  share?: Array<{ scope: ScopeId; permission: Permission }>;
  sandboxId?: string;
}

export interface PublishAudienceDescriptor {
  kind: PublishAudienceKind;
  orgId?: string;
  channelRef?: string;
  memberCount?: number;
  snapshotAt?: number;
  note?: string;
}

interface PublishResult {
  id: string;
  name?: string;
  version: number;
  url: string;
  audience?: PublishAudienceDescriptor;
  dataDir?: string;
  alwaysOn?: boolean;
  embedAncestors?: string[];
  public?: boolean;
  liveEdit?: LiveEditSaved;
}

export class NeedsApproval extends Error {
  command: string;
  approvalReason: string;
  kind: "approval";
  matched?: string;
  approvalKey?: string;
  grantModes?: ApprovalGrantModes;
  constructor(
    command: string,
    reason: string,
    kind: "approval" = "approval",
    matched?: string,
    approvalKey?: string,
    grantModes?: ApprovalGrantModes,
  ) {
    super(`command requires approval: ${command}`);
    this.name = "NeedsApproval";
    this.command = command;
    this.approvalReason = reason;
    this.kind = kind;
    this.matched = matched;
    this.approvalKey = approvalKey;
    this.grantModes = grantModes;
  }
}

export class CommandDenied extends Error {
  constructor(command: string, reason: string) {
    super(`command denied (${reason}): ${command}`);
    this.name = "CommandDenied";
  }
}

interface ReadResult {
  content: string | null;
  sourceScopeId: ScopeId | null;
  shared?: true;
  outsideWorkspace?: true;
}

export interface SkillResult {
  content: string | null;
  sourceScopeId: ScopeId | null;
  dir?: string;
  packDir?: string;
}

export interface CommandCredential {
  handle: string;
  scratchOnly?: boolean;
  env?: Array<{ key: string; value: string; secret?: boolean }>;
  resolve?: () => Promise<{
    commit?: () => Promise<void>;
    singleUse?: boolean;
    files?: ExecutionFileCredential;
    env: Array<{ key: string; value: string; secret?: boolean }>;
  }>;
}

interface AttachedFileMeta {
  name: string;
  mimetype: string;
  sizeBytes: number;
  artifactId?: string;
}

export type AttachResult = { ok: true; files: AttachedFileMeta[]; staged: number } | { ok: false; message: string };

export type AttachFiles = (files: readonly OutboundFile[], sandboxId?: string) => Promise<AttachResult>;

export interface ToolContext extends SurfaceToolDeps {
  withdrawApproval?: (card: string) => Promise<{ withdrawn: string[] }>;
  admin?: AdminToolAccess;
  selfApi?: SelfApiCall;
  runtime?(request: RuntimeRequest, signal?: AbortSignal): Promise<RuntimeResult>;
  attach: AttachFiles;
  sessionSyscalls?: SessionSyscalls;
  humanTurn?: boolean;
  toolOutput?: Pick<ToolOutputStore, "inlineTokens" | "save">;
  execute(
    command: string,
    opts?: {
      timeoutSeconds?: number;
      sandboxId?: string;
      scratch?: boolean;
      signal?: AbortSignal;
      credentials?: string[];
    },
  ): Promise<ExecResult & { scratchReroute?: boolean }>;
  sandboxResources?(
    action: "list" | "create" | "default" | "retire",
    input?: { backend?: string; name?: string; sandboxId?: string | null; memoryGb?: number },
  ): Promise<unknown>;
  computerStatus(sandboxId?: string): Promise<ComputerStatus>;
  restartComputer(sandboxId?: string, memoryGb?: number): Promise<void>;
  read(path: string, signal?: AbortSignal, sandboxId?: string): Promise<ReadResult>;
  listSkills(
    query?: string,
    offset?: number,
    limit?: number,
    source?: string,
  ): Promise<{
    sourceScopeId: ScopeId | null;
    skills: Array<{ name: string; description: string; source?: string }>;
    nextOffset?: number;
  }>;
  skill(
    name: string,
    opts?: { path?: string; sandboxId?: string; source?: string; signal?: AbortSignal },
  ): Promise<SkillResult>;
  write(path: string, data: string, sandboxId?: string): Promise<void>;
  publish(input: PublishInput): Promise<PublishResult>;
  setDeploymentPublic(id: string, isPublic: boolean): Promise<{ id: string; name?: string; public: boolean }>;
  createPlayground(input: { title: string; html: string }): Promise<PlaygroundArtifact>;
  memorySearch(
    q: string,
    limit?: number,
    scope?: ScopeId,
  ): Promise<{ hits: string[]; problems: MemoryProviderProblem[] } | null>;
  memoryRead(scope?: ScopeId): Promise<string | null>;
  memoryAdd(facts: string[]): Promise<MemoryWrite | null>;
  memoryEdit(edits: MemoryEdit[]): Promise<true | null>;
  memoryDelete(ids: string[]): Promise<true | null>;
  history(q: string, limit?: number): Promise<string[]>;
  historyOpen(seq: number): Promise<string | null>;
  callMcpTool(name: string, args: Record<string, unknown>, approval?: string): Promise<string>;
  mcpToolNeedsApproval(name: string, args: Record<string, unknown>): Promise<boolean>;
  awaitClientResult(
    callId: string,
    timeoutMs: number,
    signal?: AbortSignal,
    toolName?: string,
  ): Promise<ClientToolResult | "timeout" | "cancelled">;
  backgroundStart(
    command: string,
    opts: { purpose: string; ttlSeconds?: number; sandboxId?: string; credentials?: string[] },
  ): Promise<BackgroundStartResult & { jobComputer?: boolean }>;
  backgroundPoll(
    processId: string,
    opts?: { sinceCursor?: number; maxBytes?: number; waitSeconds?: number },
  ): Promise<BackgroundPollResult>;
  backgroundStop(processId: string, signal?: string): Promise<BackgroundStopResult>;
  backgroundWrite(processId: string, data: string): Promise<BackgroundWriteResult>;
  backgroundList(): Promise<BackgroundJobSummary[]>;
  backgroundWatch(
    processId: string,
    opts?: { instructions?: string; pattern?: string; sinceCursor?: number },
  ): Promise<BackgroundWatchResult>;
  backgroundUnwatch(monitorId: string): Promise<BackgroundUnwatchResult>;
  cronCreate(req: CronCreateRequest): Promise<CronCreateResult | ControlUnavailable>;
  cronList(): Promise<{ crons: Cron[]; visible: VisibleCron[] } | ControlUnavailable>;
  cronGet(id: string): Promise<ControlOk<{ cron: Cron }> | ControlErr<"not_found" | "forbidden"> | ControlUnavailable>;
  cronRuns(
    id: string,
    req?: CronRunsRequest,
  ): Promise<ControlOk<CronRunsResult> | ControlErr<"not_found" | "forbidden" | "bad_request"> | ControlUnavailable>;
  cronPatch(
    id: string,
    req: CronPatchRequest,
  ): Promise<
    | ControlOk<{ cron: Cron }>
    | ControlErr<"not_found" | "forbidden" | "bad_request" | "cron_update_failed">
    | ControlUnavailable
  >;
  cronNote(
    id: string,
    note: string,
  ): Promise<
    ControlOk<{ applied: boolean }> | ControlErr<"not_found" | "forbidden" | "bad_request"> | ControlUnavailable
  >;
  cronDelete(
    id: string,
  ): Promise<ControlOk<Record<never, never>> | ControlErr<"not_found" | "forbidden"> | ControlUnavailable>;
  cronSetEnabled(
    id: string,
    enabled: boolean,
  ): Promise<ControlOk<{ cron: Cron }> | ControlErr<"not_found" | "forbidden"> | ControlUnavailable>;
  cronRun(
    id: string,
  ): Promise<
    | ControlOk<{ fireKey: string }>
    | ControlErr<"not_found" | "forbidden" | "unavailable" | "bad_request" | "already_running">
    | ControlUnavailable
  >;
  cronRetarget(
    id: string,
    destinationKey: string,
  ): Promise<
    ControlOk<{ cron: Cron }> | ControlErr<"not_found" | "forbidden" | "unknown_destination"> | ControlUnavailable
  >;
  webhookCreate(req: WebhookCreateRequest): Promise<WebhookCreateResult | ControlUnavailable>;
  webhookList(): Promise<Webhook[] | ControlUnavailable>;
  webhookDisable(
    id: string,
  ): Promise<ControlOk<Record<never, never>> | ControlErr<"not_found" | "forbidden"> | ControlUnavailable>;
  webhookUpdate(
    id: string,
    action: string,
  ): Promise<
    ControlOk<{ webhook: Webhook }> | ControlErr<"not_found" | "forbidden" | "bad_request"> | ControlUnavailable
  >;
  soulRead(): { effectiveSoul: string; soul: string | null; soulVersion: number } | ControlUnavailable;
  soulWrite(
    content: string,
    expectedVersion?: number,
  ): Promise<
    | ControlOk<{ version: number }>
    | ControlErr<"soul_update_denied" | "soul_version_conflict" | "soul_update_failed">
    | ControlUnavailable
  >;
  shareArtifact(req: ShareArtifactRequest): Promise<ShareArtifactResult | ControlUnavailable>;
}

interface SurfaceSearchToolOpts {
  limit?: number;
  source?: "mirror" | "slack";
}

interface SurfacePostOpts {
  ts?: string;
  broadcast?: boolean;
}

interface SurfaceReachTarget {
  channel?: string;
  recipient?: string;
  participants?: readonly string[];
}

export interface SurfaceReactInput {
  ts: string;
  emoji: string;
  channel?: string;
  participants?: readonly string[];
}

export interface SurfaceEditInput {
  ref: string;
  text: string;
  channel?: string;
  participants?: readonly string[];
}

export interface SurfaceDeleteInput {
  ref: string;
  channel?: string;
  participants?: readonly string[];
}

export interface PostedFileMeta {
  name: string;
  mimetype: string;
  sizeBytes: number;
  artifactId?: string;
}

export interface SurfacePostResult {
  ok: boolean;
  deliveryId?: string;
  message?: string;
  matched?: string;
  attachments?: PostedFileMeta[];
}

interface SurfaceReadResult {
  ok: boolean;
  messages?: unknown[];
  message?: string;
}

interface SurfaceWhatsNewResult {
  ok: boolean;
  hereNew?: number;
  activeSubConversations?: number;
  latest?: string;
  coverageSince?: string;
  message?: string;
}

interface SurfaceSearchHit {
  ref?: string;
  author?: string;
  when?: string;
  snippet: string;
}
export interface SurfaceSearchResult {
  ok: boolean;
  hits?: SurfaceSearchHit[];
  source?: "cache" | "live" | "slack";
  coverageSince?: string;
  message?: string;
}

type SurfaceStandingOrderResult =
  | { ok: true; orders: string; bots?: Record<string, BotPolicy>; ambientEnabled?: boolean }
  | { ok: false; message: string };

export interface SurfaceToolDeps {
  post(
    text: string,
    opts?: SurfacePostOpts,
    files?: readonly OutboundFile[],
    sandboxId?: string,
  ): Promise<SurfacePostResult>;
  reach(
    text: string,
    target: SurfaceReachTarget,
    files?: readonly OutboundFile[],
    sandboxId?: string,
  ): Promise<SurfacePostResult>;
  react(input: SurfaceReactInput): Promise<SurfacePostResult>;
  edit(input: SurfaceEditInput): Promise<SurfacePostResult>;
  delete(input: SurfaceDeleteInput): Promise<SurfacePostResult>;
  readThread(opts?: { limit?: number }): Promise<SurfaceReadResult>;
  whatsNew(opts?: { since?: string }): Promise<SurfaceWhatsNewResult>;
  search(query: string, opts?: SurfaceSearchToolOpts): Promise<SurfaceSearchResult>;
  getStandingOrder(): Promise<SurfaceStandingOrderResult>;
  setStandingOrder(
    orders: string | undefined,
    bots?: Record<string, BotPolicy>,
    ambientEnabled?: boolean | null,
    expectedOrders?: string,
  ): Promise<SurfaceStandingOrderResult>;
}

export interface ControlUnavailable {
  ok: false;
  code: "control_unavailable";
  message: string;
}
export const CONTROL_UNAVAILABLE: ControlUnavailable = {
  ok: false,
  code: "control_unavailable",
  message: "the control plane (crons, webhooks, standing instructions) isn't available on this turn",
};

export interface ToolContextDeps {
  tenant: Tenant;
  desktopClientId?: string;
  admin?: AdminToolAccess;
  selfApi?: SelfApiCall;
  sandbox: Sandbox;
  commandCredentials?: readonly CommandCredential[];
  resolveCommandCredentials?: (handles: readonly string[]) => Promise<readonly CommandCredential[]>;
  provision: () => Promise<SandboxHandle>;
  provisionScratch?: () => Promise<SandboxHandle>;
  provisionJobComputer?: () => Promise<SandboxHandle>;
  provisionResource?: (
    input: string | SandboxAccessPlan,
    authorize?: (access: SandboxAccessPlan) => void,
  ) => Promise<SandboxHandle>;
  accessSandboxResource?: (id: string) => Promise<SandboxAccessPlan>;
  assertDefaultSandboxUsable?: () => Promise<void>;
  boundSandboxId?: string;
  workdir?: string;
  listSkills?: (source?: string) => Promise<SkillResolution[]>;
  useSkill?: (name: string, path: string, sandboxId?: string, source?: string) => Promise<SkillResult>;
  writableScopeId: ScopeId;
  readOnlyScopeIds: ScopeId[];
  commandPolicy: () => CommandPolicy;
  layerCommandRules?: () => readonly CommandRule[];
  authorizeCommand: (command: string, approvalKey?: string, exactApprovalKey?: boolean) => boolean;
  restoreCommand?: (command: string) => void;
  grantedHandles: GrantedHandle[];
  context?: TurnContext;
  sandboxResources?: SandboxResources;
  invalidateProvision?: () => void;
  deploy: DeployService;
  acl: AclStore;
  files?: FileArtifactStore;
  auditLog?: AuditLog;
  createdBy: string;
  botActor?: boolean;
  publicWebUrl?: string;
  publishContext?: {
    conversationKind: ConversationKind;
    channelRef?: string;
    isPrivate?: boolean;
    isMpim?: boolean;
    publishMembers?: Principal[];
  };
  config?: ScopedConfigStore;
  memory?: MemoryService;
  memoryScopeId?: ScopeId;
  memoryCaptureMetadata?: () => MemoryCaptureMetadata;
  memoryAccess?: { write?: ScopeId; read: ScopeId[]; notebookOnly?: true };
  mcp?: McpToolService;
  audienceScopeId?: ScopeId;
  actAsActor?: boolean;
  sessionHistory?: {
    search(q: string, limit?: number): Promise<string[]>;
    open(seq: number): Promise<string | null>;
  };
  actingSlackUserId?: string;
  layerAuth?: {
    credentialPaths: readonly CredentialPathSpec[];
    splitEnvTemplates: ReadonlyArray<Record<string, string>>;
  };
  execTimeoutMs?: number;
  execTimeoutCeilingMs?: number;
  signals?: RunSignalStore;
  runId?: string;
  backgroundBroker?: BackgroundExecBroker;
  monitorBroker?: MonitorBroker;
  control?: ControlService;
  controlClaims?: CapabilityClaims;
  webhookPublicUrl?: string;
  surface?: SurfaceToolDeps;
  attach?: AttachFiles;
  sessionSyscalls?: SessionSyscalls;
  humanTurn?: boolean;
  toolOutput?: ToolOutputStore;
  sessionId?: string;
}

const scratchOnlyHandles = (credentials: readonly CommandCredential[]): string =>
  credentials
    .filter((credential) => credential.scratchOnly)
    .map((credential) => credential.handle)
    .join(", ");

export function createToolContext(deps: ToolContextDeps): ToolContext {
  const inWorkdir = (handle: SandboxHandle, command: string): string =>
    deps.workdir ? `cd ${shq(posixJoin(handle.rootDir, deps.workdir))} || exit 1\n${command}` : command;
  const { writableScopeId } = deps;
  const memory =
    deps.context?.memory ??
    (deps.memory
      ? disclosedMemory(deps.memory, {
          actor: { id: deps.createdBy, type: "internal" },
          targetScope: writableScopeId,
          nativeScopes: [
            writableScopeId,
            ...deps.readOnlyScopeIds,
            ...(deps.memoryAccess?.read ?? []).filter((scope) => scope.startsWith("org:")),
          ],
          audience: deps.publishContext?.publishMembers ?? [{ id: deps.createdBy, type: "internal" }],
          open: false,
          ...(deps.memoryAccess?.notebookOnly ? { notebookOnly: true } : {}),
        })
      : undefined);

  const accessSandbox = async (id: string): Promise<SandboxAccessPlan> => {
    if (!deps.sandboxResources || !deps.accessSandboxResource) throw new Error("sandbox inventory unavailable");
    if (!id.trim()) throw new Error("sandbox_id must name a sandbox; omit it to use the default");
    return deps.accessSandboxResource(id);
  };

  const machine = async (
    id: string | undefined,
  ): Promise<{
    handle: SandboxHandle;
    resource?: SandboxResource;
    crossScope: boolean;
  }> => {
    if (id === undefined) {
      const handle = await deps.provision();
      const resource = handle.resourceId ? await deps.sandboxResources?.get(handle.resourceId) : undefined;
      return { handle, ...(resource ? { resource } : {}), crossScope: false };
    }
    let access = await accessSandbox(id);
    if (!deps.provisionResource) throw new Error("sandbox inventory unavailable");
    const handle = await deps.provisionResource(access, (current) => {
      access = current;
    });
    const resource = access.resource;
    return { handle, resource, crossScope: access.crossScope };
  };

  const authorizeExecution = (command: string, access?: SandboxAccessPlan, policy = deps.commandPolicy()): boolean => {
    const source = evaluateCommandWithLayer(command, policy, deps.layerCommandRules?.() ?? []);
    if (source.decision === "deny") throw new CommandDenied(command, source.reason ?? "denied by policy");
    if (!access?.crossScope) {
      if (source.decision !== "require_approval") return false;
      if (!deps.authorizeCommand(command, source.approvalKey))
        throw new NeedsApproval(
          command,
          source.reason ?? "requires approval",
          "approval",
          source.matched,
          source.approvalKey,
        );
      return true;
    }
    const target = access.commandPolicy
      ? evaluateCommandWithLayer(command, access.commandPolicy, [])
      : { decision: "allow" as const };
    if (target.decision === "deny")
      throw new CommandDenied(command, target.reason ?? "denied by target sandbox policy");
    if (source.decision !== "require_approval" && target.decision !== "require_approval") return false;
    const approvalKey = `sandbox:${JSON.stringify([
      access.resource.ownerScopeId,
      source.approvalKey ?? command,
      target.approvalKey ?? command,
    ])}`;
    const required = target.decision === "require_approval" ? target : source;
    const grantModes = { session: false, always: false };
    if (!deps.authorizeCommand(command, approvalKey, true))
      throw new NeedsApproval(
        command,
        required.reason ?? "requires sandbox approval",
        "approval",
        required.matched,
        approvalKey,
        grantModes,
      );
    return true;
  };
  const provisionAuthorized = async <T>(command: string, gated: boolean, open: () => Promise<T>): Promise<T> => {
    try {
      return await open();
    } catch (err) {
      if (gated) deps.restoreCommand?.(command);
      throw err;
    }
  };

  const runId = deps.runId;

  const trialOn =
    (tools: Pick<ToolContext, "execute">): CronScriptTrial =>
    (script) =>
      trialCronScript(script, (command, opts) => tools.execute(command, opts), deps.toolOutput);

  function controlOp<R>(
    run: (control: ControlService, claims: CapabilityClaims) => Promise<R>,
  ): Promise<R | ControlUnavailable> {
    if (!deps.control || !deps.controlClaims) return Promise.resolve(CONTROL_UNAVAILABLE);
    return run(deps.control, deps.controlClaims);
  }

  function surfaceOp<R>(run: (surface: SurfaceToolDeps) => Promise<R>): Promise<R | { ok: false; message: string }> {
    if (!deps.surface) return Promise.resolve({ ok: false, message: SURFACE_UNAVAILABLE_MESSAGE });
    return run(deps.surface);
  }

  const selectCredentials = async (handles: readonly string[]) => {
    const available = new Map(
      (
        (handles.length ? await deps.resolveCommandCredentials?.(handles) : undefined) ??
        deps.commandCredentials ??
        []
      ).map((credential) => [credential.handle, credential] as const),
    );
    return handles.map((handle) => {
      const credential = available.get(handle);
      if (!credential) throw new Error(`credential handle is not available on this turn: ${handle}`);
      return credential;
    });
  };

  const stageCredentials = async (
    requested: readonly CommandCredential[],
    handle: SandboxHandle,
    use: "command" | "background",
    signal?: AbortSignal,
  ) => {
    const commandEnv: Record<string, string> = {};
    const addCommandEnv = (key: string, value: string) => {
      if (DROPPED_PROXY_ENV.has(key) || Object.hasOwn(handle.env ?? {}, key))
        throw new Error(`requested credentials may not override the computer's environment key: ${key}`);
      if (Object.hasOwn(commandEnv, key) && commandEnv[key] !== value)
        throw new Error(`requested credentials provide conflicting environment key: ${key}`);
      commandEnv[key] = value;
    };
    const prepared: Array<{
      commit?: () => Promise<void>;
      singleUse?: boolean;
      files?: ExecutionFileCredential;
      env: Array<{ key: string; value: string; secret?: boolean }>;
    }> = [];
    for (const credential of new Set(requested)) {
      const materialized = credential.resolve ? await credential.resolve() : { env: credential.env ?? [] };
      prepared.push(materialized);
      for (const { key, value } of materialized.env) addCommandEnv(key, value);
      deps.auditLog?.record(deps.tenant, {
        at: Date.now(),
        principalId: deps.createdBy,
        action: "keychain.materialize",
        resource: `${credential.handle} (${use})`,
        scopeLabel: writableScopeId,
      });
    }
    signal?.throwIfAborted();
    const singleUse = prepared.filter((credential) => credential.singleUse);
    if (singleUse.length > 1) throw new Error("An execution may use at most one single-use grant");
    for (const credential of prepared.filter((credential) => !credential.singleUse)) await credential.commit?.();
    signal?.throwIfAborted();
    for (const credential of singleUse) await credential.commit?.();
    const fileCredentials = prepared.flatMap((credential) => (credential.files ? [credential.files] : []));
    const fileExecution = fileCredentials.length
      ? await prepareExecutionFiles(deps.sandbox, handle, fileCredentials)
      : undefined;
    for (const [key, value] of Object.entries(fileExecution?.env ?? {})) {
      try {
        addCommandEnv(key, value);
      } catch (error) {
        return withCleanup(
          () => Promise.reject(error),
          async () => {
            const note = await fileExecution!.finish();
            if (note) console.warn(`${note} The command could not start.`);
          },
        );
      }
    }
    return {
      commandEnv,
      secretValues: prepared.flatMap((credential) => credential.env),
      fileExecution,
      fileCredentials,
    };
  };

  return {
    ...(deps.admin ? { admin: deps.admin } : {}),
    ...(deps.selfApi ? { selfApi: deps.selfApi } : {}),
    ...(deps.toolOutput ? { toolOutput: deps.toolOutput } : {}),
    ...(deps.sandboxResources && deps.accessSandboxResource
      ? {
          async sandboxResources(
            action: "list" | "create" | "default" | "retire",
            input?: { backend?: string; name?: string; sandboxId?: string | null; memoryGb?: number },
          ): Promise<unknown> {
            const resources = deps.sandboxResources!;
            if (action === "list") {
              const listed = await resources.list(deps.createdBy, writableScopeId);
              return {
                ...listed,
                sandboxes: (
                  await Promise.all(
                    listed.sandboxes.map(async (record) =>
                      deps.accessSandboxResource!(record.id)
                        .then((access) => access.resource)
                        .catch(() => null),
                    ),
                  )
                ).filter((record) => record !== null),
              };
            }
            if (action === "retire") {
              if (!input?.sandboxId) throw new Error("retire requires sandbox_id");
              const { resource } = await accessSandbox(input.sandboxId);
              await resources.retire(deps.createdBy, resource.id);
              return { retired: resource.id };
            }
            if (action === "default") {
              if (input?.sandboxId === undefined) throw new Error("default requires sandbox_id or null");
              if (input.sandboxId !== null) await accessSandbox(input.sandboxId);
              await resources.setDefault(deps.createdBy, writableScopeId, input.sandboxId);
              deps.invalidateProvision?.();
              return { defaultSandboxId: input.sandboxId };
            }
            if (!input?.backend || !deps.provisionResource) throw new Error("create requires an available backend");
            const record = await resources.create(
              deps.createdBy,
              writableScopeId,
              input.backend,
              input.name,
              undefined,
              undefined,
              input.memoryGb,
            );
            await deps.provisionResource(record.id);
            return record;
          },
        }
      : {}),
    async computerStatus(requested?: string): Promise<ComputerStatus> {
      const sandboxId = requested ?? deps.boundSandboxId;
      const probe = async (status: ComputerStatus, provision: () => Promise<SandboxHandle>) => {
        if (!status.provisioned || status.lifecycleState === "paused") return status;
        try {
          const code = await withTimeout(
            async () =>
              (await deps.sandbox.run(await provision(), "true", { timeoutMs: COMMAND_PATH_PROBE_TIMEOUT_MS })).code,
            COMMAND_PATH_PROBE_TIMEOUT_MS * 2,
            "command probe",
          );
          return { ...status, guestResponsive: code === 0 };
        } catch (e) {
          return { ...status, guestResponsive: false, probeError: errMessage(e) };
        }
      };
      if (sandboxId !== undefined) {
        const resources = deps.sandboxResources;
        if (!resources || !deps.provisionResource) throw new Error("sandbox inventory unavailable");
        const access = await accessSandbox(sandboxId);
        return probe(await resources.status(deps.createdBy, sandboxId), () => deps.provisionResource!(access));
      }
      await deps.assertDefaultSandboxUsable?.();
      if (!deps.sandbox.computerStatus) {
        throw new CapabilityUnsupportedError(deps.sandbox.profile.backend, "reporting computer status");
      }
      return probe(await deps.sandbox.computerStatus(writableScopeId), deps.provision);
    },
    async restartComputer(requested?: string, memoryGb?: number): Promise<void> {
      const sandboxId =
        requested ??
        deps.boundSandboxId ??
        (memoryGb === undefined ? undefined : (await deps.sandboxResources?.resolve(writableScopeId))?.id);
      if (sandboxId !== undefined) {
        const resources = deps.sandboxResources;
        if (!resources) throw new Error("sandbox inventory unavailable");
        await accessSandbox(sandboxId);
        return resources.restart(deps.createdBy, sandboxId, memoryGb);
      }
      if (memoryGb !== undefined) throw new Error("a memory size needs a computer from sandbox list");
      await deps.assertDefaultSandboxUsable?.();
      if (!deps.sandbox.restartComputer) {
        throw new CapabilityUnsupportedError(deps.sandbox.profile.backend, "restarting the computer");
      }
      await deps.sandbox.restartComputer(writableScopeId);
    },
    async execute(
      command: string,
      execOpts?: {
        timeoutSeconds?: number;
        sandboxId?: string;
        scratch?: boolean;
        signal?: AbortSignal;
        credentials?: string[];
      },
    ): Promise<ExecResult & { scratchReroute?: boolean }> {
      const scratch = execOpts?.scratch === true;
      const requestedCredentials = execOpts?.credentials ?? [];
      const requested = await selectCredentials(requestedCredentials);
      const scratchOnly = scratchOnlyHandles(requested);
      if (scratch && execOpts?.sandboxId !== undefined) {
        throw new Error('a command runs on one computer — pass `sandbox_id` or `scope: "scratch"`, not both');
      }
      if ((scratch || scratchOnly) && !deps.provisionScratch) {
        throw new Error('scratch execution is not available on this computer — run without scope:"scratch"');
      }
      const scratchReroute = Boolean(scratchOnly) && !scratch;
      const executionPolicy = deps.commandPolicy;
      let handle;
      let script = command;
      if (execOpts?.sandboxId !== undefined && !scratchOnly) {
        if (!deps.sandboxResources || !deps.provisionResource) throw new Error("sandbox inventory unavailable");
        const access = await accessSandbox(execOpts.sandboxId);
        handle = await deps.provisionResource(access, (current) => {
          if (current.crossScope && requestedCredentials.length)
            throw new Error("command credentials cannot be copied to another scope's computer");
          authorizeExecution(command, current, executionPolicy());
        });
      } else {
        const gated = authorizeExecution(command, undefined, executionPolicy());
        if (scratch || scratchOnly) handle = await provisionAuthorized(command, gated, () => deps.provisionScratch!());
        else {
          handle = await provisionAuthorized(command, gated, () => deps.provision());
          script = inWorkdir(handle, command);
        }
      }
      const resolvedMs = execOpts?.timeoutSeconds != null ? execOpts.timeoutSeconds * 1000 : deps.execTimeoutMs;
      const timeoutMs =
        resolvedMs != null && deps.execTimeoutCeilingMs != null
          ? Math.min(resolvedMs, deps.execTimeoutCeilingMs)
          : resolvedMs;
      const opts =
        timeoutMs !== undefined || execOpts?.signal
          ? {
              ...(timeoutMs !== undefined ? { timeoutMs } : {}),
              ...(execOpts?.signal ? { signal: execOpts.signal } : {}),
            }
          : undefined;
      execOpts?.signal?.throwIfAborted();
      const { commandEnv, secretValues, fileExecution } = await stageCredentials(
        requested,
        handle,
        "command",
        execOpts?.signal,
      );
      let credentialNote: string | undefined;
      const r = await withCleanup(
        async (): Promise<ExecResult> => {
          const commandHandle = Object.keys(commandEnv).length
            ? { ...handle, env: { ...handle.env, ...commandEnv } }
            : handle;
          const secretEnv = executionSecretEnv(commandHandle.env, secretValues);
          const mask = createExactSecretValueMasker(Object.values(secretEnv));
          try {
            const result = await deps.sandbox.run(commandHandle, script, opts);
            return { ...result, stdout: mask(result.stdout), stderr: mask(result.stderr) };
          } catch (error) {
            const message = errMessage(error);
            const masked = mask(message);
            if (masked !== message) throw new MaskedExecutionError(error, mask, masked);
            throw error;
          }
        },
        async () => {
          credentialNote = await fileExecution?.finish();
        },
      ).catch((error: unknown) => {
        if (credentialNote) console.warn(`${credentialNote} The command itself failed.`);
        throw error;
      });
      return {
        ...r,
        ...(credentialNote ? { stderr: r.stderr ? `${r.stderr}\n${credentialNote}` : credentialNote } : {}),
        ...(scratchReroute ? { scratchReroute } : {}),
      };
    },

    async read(path: string, signal?: AbortSignal, sandboxId?: string): Promise<ReadResult> {
      signal?.throwIfAborted();
      if (path === MEMORY_FILE && memory && deps.memoryScopeId) {
        if (!deps.memoryAccess?.read.includes(deps.memoryScopeId)) {
          throw new Error("memory recall is not enabled for this conversation; use the `memory` tool when enabled");
        }
        const content = await withAbort(() => memory.read(deps.memoryScopeId!), signal);
        return { content, sourceScopeId: deps.memoryScopeId };
      }
      if (posix.normalize(`${path}/`) === "shared/") {
        const names = [...new Set(deps.grantedHandles.map((handle) => handle.handlePath))].sort();
        return { content: names.length ? names.join("\n") : "[no files are shared with you]", sourceScopeId: null };
      }
      const sharedFile = deps.context
        ? await withAbort(() => deps.context!.readFile(path), signal)
        : await withAbort(() => readContextFile(path, deps.grantedHandles, deps.files), signal);
      if (sharedFile && "error" in sharedFile) return { content: sharedFile.error, sourceScopeId: null };
      if (sharedFile) {
        const { grant: granted, bytes } = sharedFile;
        if (bytes === null) return { content: null, sourceScopeId: granted.ownerScopeId };
        const asText = tryDecodeUtf8(bytes);
        if (asText !== null) return { content: asText, sourceScopeId: granted.ownerScopeId, shared: true };
        return {
          content: `[binary file ${granted.handlePath.split("/").pop()}, Files ID ${granted.fileId}; send it by ID]`,
          sourceScopeId: granted.ownerScopeId,
          shared: true,
        };
      }
      if (path.startsWith("shared/open-")) return { content: null, sourceScopeId: null };
      const parkedKey = parkedOutputKey(path);
      if (parkedKey && deps.toolOutput && deps.sessionId) {
        const parked = await withAbort(() => deps.toolOutput!.read(deps.sessionId!, parkedKey), signal);
        if (parked && "expired" in parked)
          return {
            content: `[the full output in ${path} expired after ${TOOL_OUTPUT_RETENTION_DAYS} days; only the cut shown in the transcript remains]`,
            sourceScopeId: writableScopeId,
          };
        if (parked) {
          const { handle } = await machine(sandboxId);
          await withAbort(() => deps.sandbox.writeFile(handle, path, parked.text), signal);
          return {
            content: `[copied the full output (${parked.text.length} chars) to ${path} on the computer; read the parts you need with execute, e.g. sed -n or grep]`,
            sourceScopeId: writableScopeId,
          };
        }
      }
      signal?.throwIfAborted();
      const { handle, resource } = await machine(sandboxId);
      const rel = path.startsWith("/") ? workspacePathOf(handle.rootDir, path) : path;
      if (rel === null) return { content: null, sourceScopeId: null, outsideWorkspace: true };
      const direct = await withAbort(() => deps.sandbox.readFile(handle, rel), signal);
      if (direct !== null) return { content: direct, sourceScopeId: resource?.ownerScopeId ?? writableScopeId };
      return { content: null, sourceScopeId: null };
    },

    async createPlayground(input: { title: string; html: string }): Promise<PlaygroundArtifact> {
      if (!deps.files) throw new Error("playgrounds require a writable artifact store");
      return createPlaygroundArtifact(deps.files!, {
        ...input,
        ownerScopeId: writableScopeId,
        createdBy: deps.createdBy,
      });
    },

    async listSkills(query = "", offset = 0, limit = 50, source?: string) {
      const available = (await deps.listSkills?.(source)) ?? [];
      const matches = rankedSkills(available, query, Boolean(query));
      const start = Math.max(0, Math.floor(offset));
      const selected = matches.slice(start, start + Math.max(1, Math.min(100, Math.floor(limit))));
      const sourceScopeId = selected.length && source ? selected[0]!.skill!.scopeId : null;
      const end = start + selected.length;
      return {
        sourceScopeId,
        skills: selected.map(({ skill }) => ({
          id: skill!.id,
          name: skill!.manifest.name,
          description: skill!.manifest.description,
          source: skill!.scopeId,
        })),
        ...(end < matches.length ? { nextOffset: end } : {}),
      };
    },

    async skill(
      name: string,
      opts?: { path?: string; sandboxId?: string; source?: string; signal?: AbortSignal },
    ): Promise<SkillResult> {
      opts?.signal?.throwIfAborted();
      if (!deps.useSkill) return { content: null, sourceScopeId: null };
      if (opts?.sandboxId !== undefined && (!deps.sandboxResources || !deps.provisionResource))
        throw new Error("named sandboxes are not available here");
      return withAbort(
        () => deps.useSkill!(name, opts?.path ?? "SKILL.md", opts?.sandboxId, opts?.source),
        opts?.signal,
      );
    },

    async write(path: string, data: string, sandboxId?: string): Promise<void> {
      if (deps.memory && deps.memoryScopeId && isUnderAnyDir(path, ["memory"])) {
        throw new Error(
          `your durable memory isn't a file — use the \`memory\` tool instead (actions "add", "edit" and "delete")`,
        );
      }
      const { handle, crossScope } = await machine(sandboxId);
      if (crossScope) throw new Error("files write needs a computer owned by this conversation");
      const rel = path.startsWith("/") ? workspacePathOf(handle.rootDir, path) : path;
      if (rel === null)
        throw new Error(
          `${path} is not in the computer's workspace; only workspace files can be written, so name it relative to the workspace`,
        );
      await deps.sandbox.writeFile(handle, rel, data);
    },

    async publish(input: PublishInput): Promise<PublishResult> {
      if (input.share !== undefined || input.public !== undefined)
        throw new Error("publish does not accept sharing options; use apps action share to change access");
      const owner: ScopeId = scopeId("personal", deps.createdBy);
      const createdInScope: ScopeId = writableScopeId;
      let effectiveEntrypoint = input.entrypoint;
      if (effectiveEntrypoint === undefined && input.rollbackTo === undefined) {
        const shouldInheritForRename = input.renameFrom !== undefined && input.dir !== undefined;
        const priorName =
          input.renameFrom === undefined || shouldInheritForRename ? (input.renameFrom ?? input.name) : undefined;
        const prior = priorName ? await deps.deploy.getDeployment(priorName) : null;
        effectiveEntrypoint = deploymentEntrypoint(prior);
        if (!effectiveEntrypoint && input.renameFrom === undefined) {
          throw new Error('publish requires an entrypoint, e.g. "node server.js"');
        }
      }
      if (effectiveEntrypoint && input.dir && hasParentPathSegment(input.dir)) {
        throw new Error("publish directory must stay inside the workspace — no .. path segments");
      }
      if (!effectiveEntrypoint && input.sandboxId !== undefined) await accessSandbox(input.sandboxId);
      const files: DeployFile[] = effectiveEntrypoint
        ? filesUnder(await collectTree(deps.sandbox, (await machine(input.sandboxId)).handle, input.dir), input.dir)
        : [];
      if (effectiveEntrypoint && files.length === 0) {
        throw new Error(`publish: no files found under ${input.dir ?? "."} - nothing to deploy`);
      }
      const authEnv = effectiveEntrypoint
        ? Object.assign(
            {},
            ...(deps.layerAuth?.splitEnvTemplates ?? []).map((template) =>
              interpolateSplitEnv(template, { actingSlackUserId: deps.actingSlackUserId }),
            ),
          )
        : {};

      const d = await deps.deploy.deployOrUpdate({
        ownerScopeId: owner,
        createdBy: deps.createdBy,
        botActor: deps.botActor,
        createdInScope,
        files,
        ...(input.entrypoint ? { entrypoint: input.entrypoint } : {}),
        ...(input.name !== undefined ? { name: input.name } : {}),
        ...(input.renameFrom !== undefined ? { renameFrom: input.renameFrom } : {}),
        ...(input.env !== undefined ? { env: input.env } : {}),
        ...(Object.keys(authEnv).length ? { stampEnv: authEnv } : {}),
        ...(input.rollbackTo !== undefined ? { rollbackTo: input.rollbackTo } : {}),
        ...(input.alwaysOn !== undefined ? { alwaysOn: input.alwaysOn } : {}),
        ...(input.embedAncestors !== undefined ? { embedAncestors: input.embedAncestors } : {}),
      });
      const ref = d.name ?? d.id;
      const grantees = await deps.deploy.deploymentGrantees(d.id);
      const audience = audienceFromGrantees(
        grantees.map((g) => g.scope),
        d.createdInScope,
      );
      const url =
        deps.deploy.appUrl?.(d) ??
        appUrlOf(d, { sharedWebUrl: deps.publicWebUrl, appsDomain: undefined }) ??
        `/d/${ref}/`;
      const dataDir = effectiveEntrypoint ? deps.deploy.providerProfile?.dataDir : undefined;
      return {
        id: d.id,
        ...(d.name ? { name: d.name } : {}),
        version: d.currentVersion,
        url,
        audience,
        ...(dataDir ? { dataDir } : {}),
        ...(d.alwaysOn ? { alwaysOn: true } : {}),
        ...(d.embedAncestors?.length ? { embedAncestors: d.embedAncestors } : {}),
        ...(d.public ? { public: true } : {}),
        ...(d.liveEdit ? { liveEdit: d.liveEdit } : {}),
      };
    },

    async setDeploymentPublic(id: string, isPublic: boolean) {
      const d = await deps.deploy.setDeploymentPublic(id, isPublic, { createdBy: deps.createdBy });
      return { id: d.id, ...(d.name ? { name: d.name } : {}), public: d.public === true };
    },

    async memorySearch(q: string, limit?: number, scope?: ScopeId) {
      const context = deps.context;
      const search = context
        ? (report: OutcomeReport) => context.searchMemory(q, limit, scope, report, deps.sessionId)
        : memory &&
          ((report: OutcomeReport) =>
            searchNotebooks(memory, deps.memoryAccess?.read ?? [], q, limit, scope, {
              actorId: deps.createdBy,
              ...(deps.audienceScopeId ? { audienceScopeId: deps.audienceScopeId } : {}),
              ...(deps.sessionId ? { sessionId: deps.sessionId } : {}),
              report,
            }));
      if (!search) return null;
      const { value: hits, problems } = await withProviders("search", search);
      return hits === null ? null : { hits: hits ?? [], problems };
    },

    async memoryRead(scope?: ScopeId): Promise<string | null> {
      const target = scope ?? deps.memoryAccess?.write ?? deps.memoryScopeId;
      if (!memory || !target || !canReadNotebook(deps.memoryAccess ?? { read: [] }, target)) return null;
      const body =
        deps.context && deps.memoryAccess?.read.includes(target)
          ? await deps.context.readMemory(target)
          : await readNotebook(memory, target);
      if (body === null || !body.trim()) return body;
      return scope !== undefined ? `### ${target}\n${quotedData(body)}` : quotedData(body);
    },

    async memoryAdd(facts: string[]) {
      const write = deps.memoryAccess?.write;
      if (!memory || !write) return null;
      return writeFacts(
        memory,
        write,
        facts,
        turnAuthority(deps.createdBy, deps.memoryAccess),
        {
          ...deps.memoryCaptureMetadata?.(),
          mode: "explicit",
          ...(deps.audienceScopeId ? { audienceScopeId: deps.audienceScopeId } : {}),
          conversationScopeId: writableScopeId,
        },
        deps.runId,
      );
    },

    async memoryEdit(edits: MemoryEdit[]): Promise<true | null> {
      const write = deps.memoryAccess?.write;
      if (!memory?.edit || !write) return null;
      await memory.edit(write, edits, turnAuthority(deps.createdBy, deps.memoryAccess), {
        ...deps.memoryCaptureMetadata?.(),
        conversationScopeId: writableScopeId,
      });
      return true;
    },

    async memoryDelete(ids: string[]): Promise<true | null> {
      const write = deps.memoryAccess?.write;
      if (!memory?.delete || !write) return null;
      await memory.delete(write, ids, turnAuthority(deps.createdBy, deps.memoryAccess));
      return true;
    },

    ...(deps.humanTurn ? { humanTurn: true } : {}),
    ...(deps.sessionSyscalls ? { sessionSyscalls: deps.sessionSyscalls } : {}),

    async history(q: string, limit?: number): Promise<string[]> {
      if (!deps.sessionHistory) return [];
      return deps.sessionHistory.search(q, limit);
    },

    async historyOpen(seq: number): Promise<string | null> {
      if (!deps.sessionHistory) return null;
      return deps.sessionHistory.open(seq);
    },

    async callMcpTool(name: string, args: Record<string, unknown>, approval?: string): Promise<string> {
      if (!deps.mcp) throw new Error("no MCP connectors are configured");
      return deps.mcp.call(name, args, deps.createdBy, approval, deps.audienceScopeId, deps.actAsActor);
    },

    async mcpToolNeedsApproval(name: string, args: Record<string, unknown>): Promise<boolean> {
      if (!deps.mcp) throw new Error("no MCP connectors are configured");
      return deps.mcp.needsApproval(name, args, deps.createdBy, deps.audienceScopeId, deps.actAsActor);
    },

    async awaitClientResult(callId, timeoutMs, signal, toolName) {
      if (toolName === "desktop" && !deps.desktopClientId)
        return { content: "Computer access unavailable; continue from QM desktop.", isError: true };
      if (!deps.signals || runId === undefined) throw new Error("client tools need a queued run");
      return waitForClientResult(deps.signals, runId, callId, { timeoutMs, ...(signal ? { signal } : {}) });
    },

    async backgroundStart(
      command: string,
      opts: { purpose: string; ttlSeconds?: number; sandboxId?: string; credentials?: string[] },
    ): Promise<BackgroundStartResult & { jobComputer?: boolean }> {
      if (!deps.backgroundBroker) throw new Error(BACKGROUND_UNAVAILABLE_MESSAGE);
      const requestedCredentials = opts.credentials ?? [];
      const requested = await selectCredentials(requestedCredentials);
      const scratchOnly = scratchOnlyHandles(requested);
      if (scratchOnly && !deps.provisionJobComputer)
        throw new Error(`background jobs here cannot use ${scratchOnly}; run the command in the foreground`);
      const policy = deps.commandPolicy;
      let handle: SandboxHandle;
      let script = command;
      if (scratchOnly) {
        const gated = authorizeExecution(command, undefined, policy());
        handle = await provisionAuthorized(command, gated, () => deps.provisionJobComputer!());
      } else if (opts?.sandboxId !== undefined) {
        if (!deps.sandboxResources || !deps.provisionResource) throw new Error("sandbox inventory unavailable");
        const access = await accessSandbox(opts.sandboxId);
        handle = await deps.provisionResource(access, (current) => {
          if (current.crossScope && requestedCredentials.length)
            throw new Error("command credentials cannot be copied to another scope's computer");
          authorizeExecution(command, current, policy());
        });
      } else {
        const gated = authorizeExecution(command, undefined, policy());
        handle = await provisionAuthorized(command, gated, () => deps.provision());
        script = inWorkdir(handle, command);
      }
      const staged = requested.length ? await stageCredentials(requested, handle, "background") : undefined;
      const release = async () => {
        await staged?.fileExecution?.finish();
      };
      let credentials: BackgroundCredentials | undefined;
      try {
        credentials = staged && {
          env: staged.commandEnv,
          secrets: Object.values(executionSecretEnv(staged.commandEnv, staged.secretValues)),
          ...(staged.fileExecution
            ? { files: processCredentialFiles(staged.fileExecution.plan, staged.fileCredentials) }
            : {}),
          release,
        };
      } catch (error) {
        return withCleanup(() => Promise.reject(error), release);
      }
      const started = await deps.backgroundBroker!.start(
        handle,
        script,
        opts.purpose,
        opts?.ttlSeconds ? opts.ttlSeconds * 1000 : undefined,
        credentials,
      );
      return scratchOnly ? { ...started, jobComputer: true } : started;
    },

    async backgroundPoll(
      processId: string,
      opts?: { sinceCursor?: number; maxBytes?: number; waitSeconds?: number },
    ): Promise<BackgroundPollResult> {
      if (!deps.backgroundBroker) throw new Error(BACKGROUND_UNAVAILABLE_MESSAGE);
      const handle = (await deps.backgroundBroker.handleFor?.(processId)) ?? (await deps.provision());
      return deps.backgroundBroker!.poll(handle, processId, {
        ...(opts?.sinceCursor !== undefined ? { sinceCursor: opts.sinceCursor } : {}),
        ...(opts?.maxBytes !== undefined ? { maxBytes: opts.maxBytes } : {}),
        ...(opts?.waitSeconds !== undefined ? { waitMs: opts.waitSeconds * 1000 } : {}),
      });
    },

    async backgroundStop(processId: string, signal?: string): Promise<BackgroundStopResult> {
      if (!deps.backgroundBroker) throw new Error(BACKGROUND_UNAVAILABLE_MESSAGE);
      const handle = (await deps.backgroundBroker.handleFor?.(processId)) ?? (await deps.provision());
      return deps.backgroundBroker!.stop(handle, processId, signal);
    },

    async backgroundWrite(processId: string, data: string): Promise<BackgroundWriteResult> {
      if (!deps.backgroundBroker) throw new Error(BACKGROUND_UNAVAILABLE_MESSAGE);
      const handle = (await deps.backgroundBroker.handleFor?.(processId)) ?? (await deps.provision());
      if (handle.resourceId && (await deps.sandboxResources?.get(handle.resourceId))?.jobOnly)
        throw new Error("a background job that uses private credentials does not accept input");
      return deps.backgroundBroker!.write(handle, processId, data);
    },

    async backgroundList(): Promise<BackgroundJobSummary[]> {
      if (!deps.backgroundBroker) return [];
      return deps.backgroundBroker.list();
    },

    async backgroundWatch(processId, opts) {
      if (!deps.monitorBroker) throw new Error(WATCH_UNAVAILABLE_MESSAGE);
      return deps.monitorBroker!.watch(processId, opts);
    },

    async backgroundUnwatch(monitorId) {
      if (!deps.monitorBroker) throw new Error(WATCH_UNAVAILABLE_MESSAGE);
      return deps.monitorBroker!.unwatch(monitorId);
    },

    cronCreate(req) {
      return controlOp((c, cl) => c.createCron(req, cl, trialOn(this)));
    },
    cronList: () => controlOp((c, cl) => c.listCrons(cl)),
    cronGet: (id) => controlOp((c, cl) => c.getCron(id, cl)),
    cronRuns: (id, req) => controlOp((c, cl) => c.getCronRuns(id, req ?? {}, cl)),
    cronPatch(id, req) {
      return controlOp((c, cl) => c.patchCron(id, req, cl, trialOn(this)));
    },
    cronNote: (id, note) => controlOp((c, cl) => c.noteCron(id, note, cl)),
    cronDelete: (id) => controlOp((c, cl) => c.deleteCron(id, cl)),
    cronSetEnabled: (id, enabled) => controlOp((c, cl) => c.setCronEnabled(id, enabled, cl)),
    cronRun: (id) => controlOp((c, cl) => c.runCron(id, cl)),
    cronRetarget: (id, destinationKey) => controlOp((c, cl) => c.retargetCron(id, destinationKey, cl)),
    webhookCreate: (req) => controlOp((c, cl) => c.createWebhook(req, cl, deps.webhookPublicUrl)),
    webhookList: () => controlOp((c, cl) => c.listWebhooks(cl)),
    webhookDisable: (id) => controlOp((c, cl) => c.disableWebhook(id, cl)),
    webhookUpdate: (id, action) => controlOp((c, cl) => c.updateWebhook(id, { action }, cl)),
    soulRead() {
      if (!deps.control || !deps.controlClaims) return CONTROL_UNAVAILABLE;
      return deps.control.readSoul(deps.controlClaims);
    },
    soulWrite: (content, expectedVersion) => controlOp(async (c, cl) => c.writeSoul(content, cl, expectedVersion)),
    shareArtifact: (req) => controlOp((c, cl) => c.shareArtifact(req, cl)),

    post: (text, opts, files, sandboxId) => surfaceOp((s) => s.post(text, opts, files, sandboxId)),
    reach: (text, target, files, sandboxId) => surfaceOp((s) => s.reach(text, target, files, sandboxId)),
    react: (input) => surfaceOp((s) => s.react(input)),
    edit: (input) => surfaceOp((s) => s.edit(input)),
    delete: (input) => surfaceOp((s) => s.delete(input)),
    readThread: (opts) => surfaceOp((s) => s.readThread(opts)),
    whatsNew: (opts) => surfaceOp((s) => s.whatsNew(opts)),
    search: (query, opts) => surfaceOp((s) => s.search(query, opts)),
    getStandingOrder: () => surfaceOp((s) => s.getStandingOrder()),
    setStandingOrder: (orders, bots, ambientEnabled, expectedOrders) =>
      surfaceOp((s) => s.setStandingOrder(orders, bots, ambientEnabled, expectedOrders)),
    attach: (files, sandboxId) =>
      deps.attach
        ? deps.attach(files, sandboxId)
        : Promise.resolve({ ok: false as const, message: ATTACH_UNAVAILABLE_MESSAGE }),
  };
}

const ATTACH_UNAVAILABLE_MESSAGE =
  "files can't be attached from this turn — name the file in the surface `post` action's `files` instead";

const SURFACE_UNAVAILABLE_MESSAGE =
  "the chat surface isn't reachable from this turn — there's no conversation to post to or read here";

const BACKGROUND_UNAVAILABLE_MESSAGE =
  "Background execution isn't available on this computer — run the command with `execute` (up to 300s) instead.";
const WATCH_UNAVAILABLE_MESSAGE =
  "Watching background jobs isn't available on this computer — `background poll` the job from a later turn instead.";

function audienceFromGrantees(
  granteeScopeIds: readonly ScopeId[],
  createdInScope?: ScopeId,
): PublishAudienceDescriptor {
  if (granteeScopeIds.length === 0) return { kind: "owner" };
  const orgGrant = granteeScopeIds.find((g) => parseScopeId(g).kind === "org");
  if (orgGrant) return { kind: "org", orgId: parseScopeId(orgGrant).ref };
  const origin = createdInScope ? parseScopeId(createdInScope) : { kind: null, ref: "" };
  return {
    kind: "members",
    ...(origin.kind === "channel" ? { channelRef: origin.ref } : {}),
    ...(granteeScopeIds.every((g) => parseScopeId(g).kind === "personal")
      ? { memberCount: granteeScopeIds.length }
      : {}),
  };
}

function tryDecodeUtf8(bytes: Uint8Array): string | null {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
}

const COMMAND_PATH_PROBE_TIMEOUT_MS = 10_000;

async function collectTree(
  sandbox: Sandbox,
  handle: SandboxHandle,
  dir?: string,
): Promise<Array<{ path: string; data: Uint8Array }>> {
  const base = trimTrailingSlashes((dir ?? "").replace(/^\.?\/+/, ""));
  if (supportsAgentComputerExport(sandbox)) {
    try {
      const entries = await sandbox.exportFiles(handle, {
        include: ["workspace"],
        ...(base && base !== "." ? { includePaths: [base] } : {}),
        exclude: (entry) => carriesGitMetadata(entry.path),
        keepContentCaches: true,
      });
      return entries.filter((e) => !carriesGitMetadata(e.path)).map((e) => ({ path: e.path, data: e.data }));
    } catch (e) {
      if (!(e instanceof CapabilityUnsupportedError)) throw e;
      console.warn(`[publish] ${e.message}; falling back to per-file reads`);
    }
  }
  const out: Array<{ path: string; data: Uint8Array }> = [];
  for (const path of await sandbox.listDir(handle, base || ".")) {
    if (carriesGitMetadata(path)) continue;
    const data = await sandbox.readFileBytes(handle, path);
    if (data === null) throw new Error(`publish: could not read ${path} from the app tree`);
    out.push({ path, data });
  }
  return out;
}

function isUnderAnyDir(path: string, dirs: readonly string[]): boolean {
  const p = trimTrailingSlashes(path.replace(/^\.?\/+/, ""));
  return dirs.some((raw) => {
    const dir = trimTrailingSlashes(raw.replace(/^\.?\/+/, ""));
    return dir !== "" && (p === dir || p.startsWith(`${dir}/`));
  });
}

function filesUnder(snapshot: Array<{ path: string; data: Uint8Array }>, dir?: string): DeployFile[] {
  const d = trimTrailingSlashes((dir ?? "").replace(/^\.?\/+/, ""));
  if (!d || d === ".") return snapshot.map((f) => ({ path: f.path, data: f.data }));
  const prefix = `${d}/`;
  return snapshot
    .filter((f) => f.path.startsWith(prefix))
    .map((f) => ({ path: f.path.slice(prefix.length), data: f.data }));
}
