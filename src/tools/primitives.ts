import { join } from "node:path";
import { interpolateSplitEnv } from "../deployment/deployment-layer.ts";
import { BASE_RESIDENT_AUTH_PATHS, residentAuthPaths, type CredentialPathSpec } from "../credentials/resident-paths.ts";
import type { ExecResult, Sandbox, SandboxHandle } from "../sandbox/sandbox.ts";
import { CapabilityUnsupportedError, hasParentPathSegment, supportsAgentComputerBackup } from "../sandbox/sandbox.ts";
import type {
  CommandPolicy,
  CommandRule,
  ConversationKind,
  GrantedHandle,
  Permission,
  Principal,
  ScopeId,
  WorkspaceLayer,
} from "../types.ts";
import { parseScopeId, scopeId } from "../types.ts";
import {
  defaultPublishAudience,
  type PublishAudience,
  type PublishAudienceKind,
} from "../resolution/publish-audience.ts";
import type { WorkspaceStore } from "../workspace/workspace-store.ts";
import type { BotPolicy } from "../surface-cache/channel-policy-store.ts";
import type { GapPhase, GapWork } from "../sessions/session-store.ts";
import { evaluateCommandWithLayer } from "../policy/command-policy.ts";
import { createNullLedger, type ToolLedger } from "../runs/tool-ledger.ts";
import type {
  BackgroundExecBroker,
  BackgroundStartResult,
  BackgroundPollResult,
  BackgroundStopResult,
  BackgroundWriteResult,
  BackgroundJobSummary,
} from "../connectors/background-exec-broker.ts";
import type { MonitorBroker, BackgroundWatchResult, BackgroundUnwatchResult } from "../monitors/monitor-broker.ts";
import type { DeployService, DeployFile } from "../deploy/deploy-service.ts";
import { publicUrlOf, type Deployment } from "../deploy/deploy-store.ts";
import { carriesGitMetadata } from "../deploy/deploy-fs.ts";
import type { AclStore } from "../acl/acl-store.ts";
import type { AuditLog } from "../audit/audit-log.ts";
import { mimeFromName } from "../core/attachments.ts";
import { swallow } from "../util/errors.ts";
import { fileArtifactId, type FileArtifactStore } from "../files/file-artifact-store.ts";
import type { ScopedConfigStore } from "../resolution/config-store.ts";
import { MEMORY_FILE, type MemoryService } from "../memory/memory-service.ts";
import type { McpToolService, McpToolDescriptor } from "../mcp/mcp-tool-service.ts";
import type { ReachResolution } from "../resolution/scope-reach.ts";
import type {
  ControlService,
  CronCreateRequest,
  CronCreateResult,
  CronPatchRequest,
  CronRunsRequest,
  CronRunsResult,
  ControlOk,
  ControlErr,
} from "../api/control-service.ts";
import type { ShareArtifactRequest, ShareArtifactResult } from "../api/artifact-share.ts";
import type { Cron } from "../types.ts";
import type { CapabilityClaims } from "../auth/capability-token.ts";
import type { VisibleCron } from "../api/app.ts";

const SKILL_SKILLMD_RE = /^(?:\.\/)?skills\/([^/]+)\/SKILL\.md$/;
function skillTreeDirFor(path: string): string | null {
  const m = SKILL_SKILLMD_RE.exec(path);
  return m ? m[1]! : null;
}

const SKILL_DIR_IN_COMMAND_RE = /(?:^|[\s'"=(&|;])(?:\.\/)?skills\/([^/\s'"&|;)]+)(?=[/\s'"&|;)]|$)/g;
function skillTreeDirsInCommand(command: string): string[] {
  const dirs = new Set<string>();
  for (const m of command.matchAll(SKILL_DIR_IN_COMMAND_RE)) dirs.add(m[1]!);
  return [...dirs];
}

export interface PublishInput {
  dir?: string;
  entrypoint?: string;
  name?: string;
  renameFrom?: string;
  env?: Record<string, string>;
  rollbackTo?: number;
  share?: Array<{ scope: ScopeId; permission: Permission }>;
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
}

function deploymentEntrypoint(d: Deployment | null): string | undefined {
  if (!d) return undefined;
  return d.versions.find((v) => v.version === d.currentVersion)?.entrypoint || undefined;
}

export class NeedsApproval extends Error {
  command: string;
  approvalReason: string;
  kind: "approval";
  matched?: string;
  approvalKey?: string;
  constructor(command: string, reason: string, kind: "approval" = "approval", matched?: string, approvalKey?: string) {
    super(`command requires approval: ${command}`);
    this.name = "NeedsApproval";
    this.command = command;
    this.approvalReason = reason;
    this.kind = kind;
    this.matched = matched;
    this.approvalKey = approvalKey;
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
}

export interface ShareDirective {
  scope: ScopeId | "org";
  permission?: Permission;
}

interface WriteResult {
  shared: Array<{ scope: ScopeId; permission: Permission }>;
}

interface ReachedProvenance {
  scopeId: ScopeId;
  label: string;
}

export interface ToolContext extends SurfaceToolDeps {
  credentialExecServices?: readonly { service: string; binary: string }[];
  credentialExec?(
    service: string,
    args: string[],
    opts?: { timeoutSeconds?: number; signal?: AbortSignal },
  ): Promise<ExecResult>;
  execute(
    command: string,
    opts?: {
      timeoutSeconds?: number;
      scratch?: boolean;
      ownerAuth?: boolean;
      reachTarget?: string;
      signal?: AbortSignal;
    },
  ): Promise<ExecResult & { reached?: ReachedProvenance }>;
  read(path: string): Promise<ReadResult>;
  write(path: string, data?: string, share?: ShareDirective[]): Promise<WriteResult>;
  publish(input: PublishInput): Promise<PublishResult>;
  memorySearch(q: string, limit?: number): Promise<string[] | null>;
  memoryRead(): Promise<string | null>;
  memoryRemember(facts: string[]): Promise<number | null>;
  memoryRewrite(content: string): Promise<true | null>;
  history(q: string, limit?: number): Promise<string[]>;
  mcpToolDefs(): McpToolDescriptor[];
  callMcpTool(name: string, args: Record<string, unknown>): Promise<string>;
  backgroundStart(command: string, opts?: { ttlSeconds?: number }): Promise<BackgroundStartResult>;
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
    | ControlOk<Record<never, never>>
    | ControlErr<"not_found" | "forbidden" | "unavailable" | "bad_request">
    | ControlUnavailable
  >;
  cronRetarget(
    id: string,
    destinationKey: string,
  ): Promise<
    ControlOk<{ cron: Cron }> | ControlErr<"not_found" | "forbidden" | "unknown_destination"> | ControlUnavailable
  >;
  soulRead(): { effectiveSoul: string; soul: string | null; soulVersion: number } | ControlUnavailable;
  soulWrite(
    content: string,
  ): Promise<ControlOk<{ version: number }> | ControlErr<"soul_update_denied"> | ControlUnavailable>;
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

interface SurfaceMembersResult {
  ok: boolean;
  members?: Array<{ displayName: string }>;
  message?: string;
}

interface SurfaceFileResult {
  ok: boolean;
  content?: string;
  name?: string;
  sizeBytes?: number;
  contentType?: string;
  message?: string;
}

type SurfaceStandingOrderResult =
  | { ok: true; orders: string; bots?: Record<string, BotPolicy>; ambientEnabled?: boolean }
  | { ok: false; message: string };

export interface SurfaceToolDeps {
  post(text: string, opts?: SurfacePostOpts, files?: readonly string[]): Promise<SurfacePostResult>;
  reach(text: string, target: SurfaceReachTarget, files?: readonly string[]): Promise<SurfacePostResult>;
  react(input: SurfaceReactInput): Promise<SurfacePostResult>;
  edit(input: SurfaceEditInput): Promise<SurfacePostResult>;
  delete(input: SurfaceDeleteInput): Promise<SurfacePostResult>;
  readThread(opts?: { limit?: number }): Promise<SurfaceReadResult>;
  whatsNew(opts?: { since?: string }): Promise<SurfaceWhatsNewResult>;
  search(query: string, opts?: SurfaceSearchToolOpts): Promise<SurfaceSearchResult>;
  readMembers(): Promise<SurfaceMembersResult>;
  readFile(ref: string): Promise<SurfaceFileResult>;
  getStandingOrder(): Promise<SurfaceStandingOrderResult>;
  setStandingOrder(
    orders: string,
    bots?: Record<string, BotPolicy>,
    ambientEnabled?: boolean | null,
  ): Promise<SurfaceStandingOrderResult>;
  staySilent(reason: string): Promise<{ ok: true; message: string }>;
}

export interface ControlUnavailable {
  ok: false;
  code: "control_unavailable";
  message: string;
}
export const CONTROL_UNAVAILABLE: ControlUnavailable = {
  ok: false,
  code: "control_unavailable",
  message: "the control plane (crons, standing instructions) isn't available on this turn",
};

export interface ToolContextDeps {
  sandbox: Sandbox;
  credentialExecServices?: readonly { service: string; binary: string }[];
  credentialExec?: ToolContext["credentialExec"];
  provision: () => Promise<SandboxHandle>;
  provisionScratch?: () => Promise<SandboxHandle>;
  provisionOwnerAuth?: () => Promise<SandboxHandle>;
  ownerAuthCommand?: (command: string) => string;
  scopedCommand?: (command: string) => string;
  ensureSkillTree?: (skillDir: string) => Promise<void>;
  reach?: {
    resolveChannel(query: string): Promise<ReachResolution>;
    provisionFor(scopeId: ScopeId): Promise<SandboxHandle>;
  };
  layers: WorkspaceLayer[];
  commandPolicy: () => CommandPolicy;
  layerCommandRules?: () => readonly CommandRule[];
  authorizeCommand: (command: string, approvalKey?: string) => boolean;
  grantedHandles: GrantedHandle[];
  sharedMaterializeDir?: string;
  workspace: WorkspaceStore;
  deploy: DeployService;
  acl: AclStore;
  files?: FileArtifactStore;
  auditLog?: AuditLog;
  createdBy: string;
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
  memoryAccess?: { write?: ScopeId; read: ScopeId[] };
  mcp?: McpToolService;
  sessionHistory?: { search(q: string, limit?: number): Promise<string[]> };
  actingSlackUserId?: string;
  layerAuth?: {
    credentialPaths: readonly CredentialPathSpec[];
    splitEnvTemplates: ReadonlyArray<Record<string, string>>;
  };
  execTimeoutMs?: number;
  execTimeoutCeilingMs?: number;
  ledger?: ToolLedger;
  runId?: string;
  attempt?: number;
  backgroundBroker?: BackgroundExecBroker;
  monitorBroker?: MonitorBroker;
  persistWritesToStore?: { excludeDirs: readonly string[] };
  onGapWork?: (work: GapWork) => void;
  control?: ControlService;
  controlClaims?: CapabilityClaims;
  surface?: SurfaceToolDeps;
}

export function createToolContext(deps: ToolContextDeps): ToolContext {
  const writableScopeId = deps.layers.find((l) => l.mode === "rw")?.scopeId ?? null;
  const fallbackMounts = deps.layers.filter((l) => l.mode === "ro" && l.mountPath);
  const persistExclude = deps.persistWritesToStore?.excludeDirs;
  const orgScopeId = deps.layers.find((l) => l.mountPath === "global")?.scopeId ?? null;

  const ledger = deps.ledger ?? createNullLedger();
  const runId = deps.runId;
  const attempt = deps.attempt ?? 1;
  let callIndex = -1;

  async function timed<T>(phase: GapPhase, op: () => Promise<T>): Promise<T> {
    const start = Date.now();
    try {
      return await op();
    } finally {
      try {
        deps.onGapWork?.({ phase, start, end: Date.now() });
      } catch (error) {
        void error;
      }
    }
  }

  async function once<T>(produce: () => Promise<T>, shouldCache: (r: T) => boolean = () => true): Promise<T> {
    callIndex += 1;
    if (runId === undefined) return produce();
    const prior = await timed("tool_ledger", () => ledger.begin(runId, attempt, callIndex));
    if (prior.cached) return JSON.parse(prior.output ?? "null") as T;
    const result = await produce();
    if (shouldCache(result))
      await timed("tool_ledger", () => ledger.record(runId, attempt, callIndex, JSON.stringify(result ?? null)));
    return result;
  }

  function controlOp<R>(
    run: (control: ControlService, claims: CapabilityClaims) => Promise<R>,
    cache?: (r: R) => boolean,
  ): Promise<R | ControlUnavailable> {
    if (!deps.control || !deps.controlClaims) return Promise.resolve(CONTROL_UNAVAILABLE);
    const call = () => run(deps.control!, deps.controlClaims!);
    return cache ? once(call, cache) : call();
  }

  function surfaceOp<R>(
    run: (surface: SurfaceToolDeps) => Promise<R>,
    cache?: (r: R) => boolean,
  ): Promise<R | { ok: false; message: string }> {
    if (!deps.surface) return Promise.resolve({ ok: false, message: SURFACE_UNAVAILABLE_MESSAGE });
    const call = () => run(deps.surface!);
    return cache ? once(call, cache) : call();
  }

  return {
    ...(deps.credentialExecServices ? { credentialExecServices: deps.credentialExecServices } : {}),
    ...(deps.credentialExec ? { credentialExec: deps.credentialExec } : {}),
    async execute(
      command: string,
      execOpts?: {
        timeoutSeconds?: number;
        scratch?: boolean;
        ownerAuth?: boolean;
        reachTarget?: string;
        signal?: AbortSignal;
      },
    ): Promise<ExecResult & { reached?: ReachedProvenance }> {
      const scratch = execOpts?.scratch === true;
      const ownerAuth = execOpts?.ownerAuth === true;
      const reachTarget = execOpts?.reachTarget;
      if ([scratch, ownerAuth, reachTarget !== undefined].filter(Boolean).length > 1) {
        throw new Error("a command runs on one computer — choose scoped, scratch, owner, or a reached room");
      }
      if (scratch && !deps.provisionScratch) {
        throw new Error('scratch execution is not available on this computer — run without scope:"scratch"');
      }
      if (ownerAuth && !deps.provisionOwnerAuth) {
        throw new Error('an owner-auth box is not available on this turn — use scope:"scoped"');
      }
      let reached: ReachedProvenance | undefined;
      if (reachTarget !== undefined) {
        if (!deps.reach) {
          throw new Error(
            "visiting another conversation's computer works from a DM — here, ask in that channel instead",
          );
        }
        const target = await deps.reach.resolveChannel(reachTarget);
        if (target.kind === "error") throw new Error(target.message);
        reached = { scopeId: target.scopeId, label: `#${target.channelName}` };
      }
      const { decision, reason, matched, approvalKey } = evaluateCommandWithLayer(
        command,
        deps.commandPolicy(),
        deps.layerCommandRules?.() ?? [],
      );
      if (decision === "deny") {
        throw new CommandDenied(command, reason ?? "denied by policy");
      }
      if (decision === "require_approval" && !deps.authorizeCommand(command, approvalKey)) {
        throw new NeedsApproval(command, reason ?? "requires approval", "approval", matched, approvalKey);
      }
      let handle;
      if (reached) handle = await deps.reach!.provisionFor(reached.scopeId);
      else if (scratch) handle = await deps.provisionScratch!();
      else if (ownerAuth) handle = await deps.provisionOwnerAuth!();
      else handle = await deps.provision();
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
      const local = !scratch && !ownerAuth && reached === undefined;
      if (local && deps.ensureSkillTree) {
        for (const skillDir of skillTreeDirsInCommand(command)) await deps.ensureSkillTree(skillDir);
      }
      return once(async () => {
        if (reached) {
          deps.auditLog?.record({
            at: Date.now(),
            principalId: deps.createdBy,
            action: "reach_exec",
            resource: command,
            scopeLabel: reached.scopeId,
          });
        }
        return timed("exec", async () => {
          const sandboxCommand = ownerAuth
            ? (deps.ownerAuthCommand?.(command) ?? command)
            : (deps.scopedCommand?.(command) ?? command);
          const r = await deps.sandbox.run(handle, sandboxCommand, opts);
          return reached ? { ...r, reached } : r;
        });
      });
    },

    async read(path: string): Promise<ReadResult> {
      if (path === MEMORY_FILE && deps.memory && deps.memoryScopeId) {
        if (!deps.memoryAccess?.read.includes(deps.memoryScopeId)) {
          throw new Error("memory recall is not enabled for this conversation; use the `memory` tool when enabled");
        }
        const content = await deps.memory.read(deps.memoryScopeId);
        if (content) return { content, sourceScopeId: deps.memoryScopeId };
      }
      const matches = deps.grantedHandles.filter((h) => h.handlePath === path);
      if (matches.length > 0) {
        const distinct = new Set(matches.map((h) => `${h.ownerScopeId}\0${h.ownerPath}`));
        if (distinct.size > 1) {
          return {
            content: `ERROR: ambiguous shared handle "${path}" maps to ${distinct.size} different files`,
            sourceScopeId: null,
          };
        }
        const granted = matches[0]!;
        const bytes = await deps.workspace.readBytes(granted.ownerScopeId, granted.ownerPath);
        if (bytes === null) return { content: null, sourceScopeId: granted.ownerScopeId };
        const asText = tryDecodeUtf8(bytes);
        if (asText !== null) return { content: asText, sourceScopeId: granted.ownerScopeId };
        const handle = await deps.provision();
        const name = granted.handlePath.split(/[\\/]/).pop() ?? granted.handlePath;
        const materializedPath = deps.sharedMaterializeDir
          ? `${deps.sharedMaterializeDir}/${name}`
          : granted.handlePath;
        await deps.sandbox.writeFileBytes(handle, materializedPath, bytes);
        return {
          content:
            `[binary file materialized into the sandbox at ${materializedPath} (${bytes.length} bytes) — ` +
            `to send it, attach it to a message: name \`${materializedPath}\` in the surface \`post\` action's \`files\`]`,
          sourceScopeId: granted.ownerScopeId,
        };
      }
      const skillDir = skillTreeDirFor(path);
      if (skillDir && deps.ensureSkillTree) await deps.ensureSkillTree(skillDir);
      const handle = await deps.provision();
      return timed("file_op", async () => {
        const direct = await deps.sandbox.readFile(handle, path);
        if (direct !== null) return { content: direct, sourceScopeId: writableScopeId };
        for (const mount of fallbackMounts) {
          const v = await deps.sandbox.readFile(handle, join(mount.mountPath, path));
          if (v !== null) return { content: v, sourceScopeId: mount.scopeId };
        }
        return { content: null, sourceScopeId: null };
      });
    },

    async write(path: string, data?: string, share?: ShareDirective[]): Promise<WriteResult> {
      const wantShare = share !== undefined && share.length > 0;
      if (data === undefined && !wantShare) {
        throw new Error("write needs `data` to save content, `share` to grant access, or both");
      }
      if (data !== undefined && deps.memory && deps.memoryScopeId && isUnderAnyDir(path, ["memory"])) {
        throw new Error(
          `your durable memory isn't a file — use the \`memory\` tool instead (action "remember" to add facts, "rewrite" to curate the whole notebook)`,
        );
      }
      const handle = await deps.provision();
      return once(() =>
        timed("file_op", async () => {
          if (data !== undefined) {
            await deps.sandbox.writeFile(handle, path, data);
            if (writableScopeId && persistExclude && !isUnderAnyDir(path, persistExclude)) {
              await deps.workspace.write(writableScopeId, path, data);
            }
          }
          const shared: WriteResult["shared"] = [];
          if (wantShare) {
            if (!writableScopeId) throw new Error("share needs a writable scope that owns the file");
            const bytes = await deps.sandbox.readFileBytes(handle, path);
            if (bytes === null) throw new Error(`no such file to share: ${path}`);
            await deps.workspace.write(writableScopeId, path, bytes);
            const priorRows = deps.files
              ? await deps.files.resolveByOwnerPaths([{ ownerScopeId: writableScopeId, path }])
              : [];
            const priorAuthor = (priorRows.find((r) => r.direction === "out") ?? priorRows[0])?.createdBy;
            const author = data === undefined ? (priorAuthor ?? deps.createdBy) : deps.createdBy;
            if (deps.files) {
              try {
                const name = path.split(/[\\/]/).pop() || path;
                await deps.files.put({
                  id: fileArtifactId(`${writableScopeId}:${path}`, "out", 0),
                  ownerScopeId: writableScopeId,
                  createdBy: author,
                  name,
                  path,
                  mimetype: mimeFromName(name),
                  data: bytes,
                  direction: "out",
                  createdInScope: writableScopeId,
                });
              } catch (e) {
                swallow("tools: persist of outbound file artifact failed", e);
              }
            }
            for (const s of share!) {
              const granteeScopeId = s.scope === "org" ? orgScopeId : s.scope;
              if (!granteeScopeId) throw new Error('cannot resolve "org" — no org scope is mounted in this session');
              if (parseScopeId(granteeScopeId).kind === null) {
                throw new Error(
                  `invalid share target "${s.scope}" — use a scope id like personal:<id>, channel:<id>, team:<id>, or org:<id> (or "org")`,
                );
              }
              const permission: Permission = s.permission ?? "read";
              await deps.acl.grant(
                { ownerScopeId: writableScopeId, ref: path, granteeScopeId, permission, grantedBy: deps.createdBy },
                author,
              );
              deps.auditLog?.record({
                at: Date.now(),
                principalId: deps.createdBy,
                action: "file_share",
                resource: path,
                scopeLabel: granteeScopeId,
              });
              shared.push({ scope: granteeScopeId, permission });
            }
          }
          return { shared };
        }),
      );
    },

    async publish(input: PublishInput): Promise<PublishResult> {
      if (!writableScopeId) throw new Error("publish needs a writable scope to own the app");
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
      const handle = await deps.provision();
      const files: DeployFile[] = effectiveEntrypoint
        ? filesUnder(await collectTree(deps.sandbox, handle, input.dir), input.dir)
        : [];
      if (effectiveEntrypoint && files.length === 0) {
        throw new Error(`publish: no files found under ${input.dir ?? "."} - nothing to deploy`);
      }
      const { authEnv } = effectiveEntrypoint
        ? await captureResidentAuth(deps.sandbox, handle, {
            split: true,
            ...(deps.actingSlackUserId ? { actingSlackUserId: deps.actingSlackUserId } : {}),
            ...(deps.layerAuth ? { layerAuth: deps.layerAuth } : {}),
          })
        : { authEnv: {} };
      const env = { ...input.env, ...authEnv };

      const pc = deps.publishContext;
      const aud: PublishAudience =
        pc && orgScopeId
          ? defaultPublishAudience({
              kind: pc.conversationKind,
              ...(pc.isPrivate !== undefined ? { isPrivate: pc.isPrivate } : {}),
              ...(pc.isMpim !== undefined ? { isMpim: pc.isMpim } : {}),
              ...(pc.publishMembers ? { members: pc.publishMembers } : {}),
              orgScopeId,
              ownerId: deps.createdBy,
            })
          : { kind: "owner", grantees: [] };
      const optOut = Array.isArray(input.share) && input.share.length === 0;
      const desiredDefault = optOut ? [] : aud.grantees;
      const doReconcile = effectiveEntrypoint !== undefined && (optOut || !aud.incomplete);
      const snapshotAt = Date.now();
      const resolvedShare = input.share?.map((s) => {
        const scope = s.scope === "org" ? orgScopeId : s.scope;
        if (!scope) throw new Error('cannot resolve "org" — no org scope is mounted in this session');
        if (parseScopeId(scope).kind === null) {
          throw new Error(`invalid share target "${s.scope}" — use "org" or a scope id like personal:<id> or org:<id>`);
        }
        return { scope, permission: s.permission };
      });
      return once(async () => {
        const d = await deps.deploy.deployOrUpdate({
          ownerScopeId: owner,
          createdBy: deps.createdBy,
          createdInScope,
          files,
          ...(input.entrypoint ? { entrypoint: input.entrypoint } : {}),
          ...(input.name !== undefined ? { name: input.name } : {}),
          ...(input.renameFrom !== undefined ? { renameFrom: input.renameFrom } : {}),
          ...(Object.keys(env).length ? { env } : {}),
          ...(input.rollbackTo !== undefined ? { rollbackTo: input.rollbackTo } : {}),
          ...(doReconcile
            ? {
                defaultAudience: {
                  contextScopeId: createdInScope,
                  granteeScopeIds: desiredDefault,
                  snapshotAt,
                  ...(optOut ? { force: true } : {}),
                },
              }
            : {}),
          ...(resolvedShare?.length ? { share: resolvedShare } : {}),
        });
        const ref = d.name ?? d.id;
        const grantees = await deps.deploy.deploymentGrantees(d.id);
        const base = audienceFromGrantees(
          grantees.map((g) => g.scope),
          d.createdInScope,
        );
        const audience: PublishAudienceDescriptor =
          aud.incomplete && effectiveEntrypoint !== undefined && input.share === undefined && aud.reason
            ? { ...base, note: aud.reason }
            : base;
        const urlBase = deps.publicWebUrl?.replace(/\/$/, "") ?? "";
        const url = publicUrlOf(d.endpoint) ?? `${urlBase}/d/${ref}/`;
        const dataDir = effectiveEntrypoint ? deps.deploy.providerProfile?.dataDir : undefined;
        return {
          id: d.id,
          ...(d.name ? { name: d.name } : {}),
          version: d.currentVersion,
          url,
          audience,
          ...(dataDir ? { dataDir } : {}),
        };
      });
    },

    async memorySearch(q: string, limit?: number): Promise<string[] | null> {
      const read = deps.memoryAccess?.read ?? [];
      if (!deps.memory || read.length === 0) return null;
      return timed("recall", async () => {
        const out: string[] = [];
        for (const scope of read) {
          for (const fact of await deps.memory!.query(scope, q, limit)) {
            out.push(read.length > 1 ? `[${scope}] ${fact}` : fact);
          }
        }
        return out.slice(0, limit ?? 20);
      });
    },

    async memoryRead(): Promise<string | null> {
      const write = deps.memoryAccess?.write;
      if (!deps.memory || !write) return null;
      return timed("recall", () => deps.memory!.read(write));
    },

    async memoryRemember(facts: string[]): Promise<number | null> {
      const write = deps.memoryAccess?.write;
      if (!deps.memory || !write) return null;
      return once(() => timed("memory_write", () => deps.memory!.capture(write, facts, Date.now(), deps.createdBy)));
    },

    async memoryRewrite(content: string): Promise<true | null> {
      const write = deps.memoryAccess?.write;
      if (!deps.memory || !write) return null;
      return once(() =>
        timed("memory_write", async () => {
          await deps.memory!.replace(write, content, deps.createdBy);
          return true as const;
        }),
      );
    },

    async history(q: string, limit?: number): Promise<string[]> {
      if (!deps.sessionHistory) return [];
      return deps.sessionHistory.search(q, limit);
    },

    mcpToolDefs(): McpToolDescriptor[] {
      return deps.mcp?.toolDefs() ?? [];
    },

    async callMcpTool(name: string, args: Record<string, unknown>): Promise<string> {
      if (!deps.mcp) throw new Error("no MCP connectors are configured");
      return deps.mcp.call(name, args, deps.createdBy);
    },

    async backgroundStart(command: string, opts?: { ttlSeconds?: number }): Promise<BackgroundStartResult> {
      if (!deps.backgroundBroker) throw new Error(BACKGROUND_UNAVAILABLE_MESSAGE);
      const handle = await deps.provision();
      const { decision, reason, matched, approvalKey } = evaluateCommandWithLayer(
        command,
        deps.commandPolicy(),
        deps.layerCommandRules?.() ?? [],
      );
      if (decision === "deny") throw new CommandDenied(command, reason ?? "denied by policy");
      if (decision === "require_approval" && !deps.authorizeCommand(command, approvalKey)) {
        throw new NeedsApproval(command, reason ?? "requires approval", "approval", matched, approvalKey);
      }
      if (deps.ensureSkillTree) {
        for (const skillDir of skillTreeDirsInCommand(command)) await deps.ensureSkillTree(skillDir);
      }
      return once(
        () =>
          deps.backgroundBroker!.start(
            handle,
            deps.scopedCommand?.(command) ?? command,
            opts?.ttlSeconds ? opts.ttlSeconds * 1000 : undefined,
          ),
        () => true,
      );
    },

    async backgroundPoll(
      processId: string,
      opts?: { sinceCursor?: number; maxBytes?: number; waitSeconds?: number },
    ): Promise<BackgroundPollResult> {
      if (!deps.backgroundBroker) throw new Error(BACKGROUND_UNAVAILABLE_MESSAGE);
      const handle = await deps.provision();
      return once(
        () =>
          deps.backgroundBroker!.poll(handle, processId, {
            ...(opts?.sinceCursor !== undefined ? { sinceCursor: opts.sinceCursor } : {}),
            ...(opts?.maxBytes !== undefined ? { maxBytes: opts.maxBytes } : {}),
            ...(opts?.waitSeconds !== undefined ? { waitMs: opts.waitSeconds * 1000 } : {}),
          }),
        (r) => r.status.state === "exited",
      );
    },

    async backgroundStop(processId: string, signal?: string): Promise<BackgroundStopResult> {
      if (!deps.backgroundBroker) throw new Error(BACKGROUND_UNAVAILABLE_MESSAGE);
      const handle = await deps.provision();
      return once(
        () => deps.backgroundBroker!.stop(handle, processId, signal),
        () => true,
      );
    },

    async backgroundWrite(processId: string, data: string): Promise<BackgroundWriteResult> {
      if (!deps.backgroundBroker) throw new Error(BACKGROUND_UNAVAILABLE_MESSAGE);
      const handle = await deps.provision();
      return once(
        () => deps.backgroundBroker!.write(handle, processId, data),
        () => true,
      );
    },

    async backgroundList(): Promise<BackgroundJobSummary[]> {
      if (!deps.backgroundBroker) return [];
      return deps.backgroundBroker.list();
    },

    async backgroundWatch(processId, opts) {
      if (!deps.monitorBroker) throw new Error(WATCH_UNAVAILABLE_MESSAGE);
      return once(
        () => deps.monitorBroker!.watch(processId, opts),
        () => true,
      );
    },

    async backgroundUnwatch(monitorId) {
      if (!deps.monitorBroker) throw new Error(WATCH_UNAVAILABLE_MESSAGE);
      return once(
        () => deps.monitorBroker!.unwatch(monitorId),
        () => true,
      );
    },

    cronCreate: (req) =>
      controlOp(
        (c, cl) => c.createCron(req, cl),
        (r) => r.ok,
      ),
    cronList: () => controlOp((c, cl) => c.listCrons(cl)),
    cronGet: (id) => controlOp((c, cl) => c.getCron(id, cl)),
    cronRuns: (id, req) => controlOp((c, cl) => c.getCronRuns(id, req ?? {}, cl)),
    cronPatch: (id, req) =>
      controlOp(
        (c, cl) => c.patchCron(id, req, cl),
        (r) => r.ok,
      ),
    cronDelete: (id) =>
      controlOp(
        (c, cl) => c.deleteCron(id, cl),
        (r) => r.ok,
      ),
    cronSetEnabled: (id, enabled) =>
      controlOp(
        (c, cl) => c.setCronEnabled(id, enabled, cl),
        (r) => r.ok,
      ),
    cronRun: (id) =>
      controlOp(
        (c, cl) => c.runCron(id, cl),
        (r) => r.ok,
      ),
    cronRetarget: (id, destinationKey) =>
      controlOp(
        (c, cl) => c.retargetCron(id, destinationKey, cl),
        (r) => r.ok,
      ),
    soulRead() {
      if (!deps.control || !deps.controlClaims) return CONTROL_UNAVAILABLE;
      return deps.control.readSoul(deps.controlClaims);
    },
    soulWrite: (content) =>
      controlOp(
        async (c, cl) => c.writeSoul(content, cl),
        (r) => r.ok,
      ),
    shareArtifact: (req) =>
      controlOp(
        (c, cl) => c.shareArtifact(req, cl),
        (r) => r.ok,
      ),

    post: (text, opts, files) =>
      surfaceOp(
        (s) => s.post(text, opts, files),
        (r) => r.ok,
      ),
    reach: (text, target, files) =>
      surfaceOp(
        (s) => s.reach(text, target, files),
        (r) => r.ok,
      ),
    react: (input) =>
      surfaceOp(
        (s) => s.react(input),
        (r) => r.ok,
      ),
    edit: (input) =>
      surfaceOp(
        (s) => s.edit(input),
        (r) => r.ok,
      ),
    delete: (input) =>
      surfaceOp(
        (s) => s.delete(input),
        (r) => r.ok,
      ),
    readThread: (opts) => surfaceOp((s) => s.readThread(opts)),
    whatsNew: (opts) => surfaceOp((s) => s.whatsNew(opts)),
    search: (query, opts) => surfaceOp((s) => s.search(query, opts)),
    readMembers: () => surfaceOp((s) => s.readMembers()),
    readFile: (ref) => surfaceOp((s) => s.readFile(ref)),
    getStandingOrder: () => surfaceOp((s) => s.getStandingOrder()),
    setStandingOrder: (orders, bots, ambientEnabled) =>
      surfaceOp((s) => s.setStandingOrder(orders, bots, ambientEnabled)),
    staySilent: (reason) =>
      deps.surface
        ? deps.surface.staySilent(reason)
        : Promise.resolve({ ok: true as const, message: "[staying silent]" }),
  };
}

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
    memberCount: granteeScopeIds.length,
  };
}

function tryDecodeUtf8(bytes: Uint8Array): string | null {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
}

const RESIDENT_AUTH_PATHS = BASE_RESIDENT_AUTH_PATHS;

function isResidentAuthPath(path: string, paths: readonly string[] = RESIDENT_AUTH_PATHS): boolean {
  const p = path.replace(/^\.?\/+/, "");
  return paths.some((a) => p === a || p.startsWith(`${a}/`));
}

async function captureResidentAuth(
  sandbox: Sandbox,
  handle: SandboxHandle,
  opts: {
    split: boolean;
    actingSlackUserId?: string;
    layerAuth?: {
      credentialPaths: readonly CredentialPathSpec[];
      splitEnvTemplates: ReadonlyArray<Record<string, string>>;
    };
  },
): Promise<{ homeFiles: DeployFile[]; authEnv: Record<string, string> }> {
  if (opts.split) {
    const authEnv: Record<string, string> = {};
    for (const template of opts.layerAuth?.splitEnvTemplates ?? []) {
      Object.assign(
        authEnv,
        interpolateSplitEnv(template, opts.actingSlackUserId ? { actingSlackUserId: opts.actingSlackUserId } : {}),
      );
    }
    return { homeFiles: [], authEnv };
  }
  if (!supportsAgentComputerBackup(sandbox)) return { homeFiles: [], authEnv: {} };
  const authPaths = residentAuthPaths(opts.layerAuth?.credentialPaths);
  try {
    const entries = await sandbox.backupComputer(handle, {
      include: ["home"],
      includePaths: authPaths,
      exclude: (e) => e.area !== "home" || !isResidentAuthPath(e.path, authPaths),
      followSymlinks: true,
    });
    return { homeFiles: entries.map((e) => ({ path: e.path, data: e.data })), authEnv: {} };
  } catch (e) {
    if (e instanceof CapabilityUnsupportedError) {
      console.warn(`[publish] ${e.message}; skipping resident auth backup`);
      return { homeFiles: [], authEnv: {} };
    }
    throw e;
  }
}

async function collectTree(
  sandbox: Sandbox,
  handle: SandboxHandle,
  dir?: string,
): Promise<Array<{ path: string; data: Uint8Array }>> {
  const base = (dir ?? "").replace(/^\.?\/+/, "").replace(/\/+$/, "");
  if (supportsAgentComputerBackup(sandbox)) {
    try {
      const entries = await sandbox.backupComputer(handle, {
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
  const p = path.replace(/^\.?\/+/, "").replace(/\/+$/, "");
  return dirs.some((raw) => {
    const dir = raw.replace(/^\.?\/+/, "").replace(/\/+$/, "");
    return dir !== "" && (p === dir || p.startsWith(`${dir}/`));
  });
}

function filesUnder(snapshot: Array<{ path: string; data: Uint8Array }>, dir?: string): DeployFile[] {
  const d = (dir ?? "").replace(/^\.?\/+/, "").replace(/\/+$/, "");
  if (!d || d === ".") return snapshot.map((f) => ({ path: f.path, data: f.data }));
  const prefix = `${d}/`;
  return snapshot
    .filter((f) => f.path.startsWith(prefix))
    .map((f) => ({ path: f.path.slice(prefix.length), data: f.data }));
}
