import type { EgressPolicy, WorkspaceLayer } from "../types.ts";

export interface SandboxHandle {
  resourceId?: string;
  id: string;
  rootDir: string;
  homeDir?: string;
  coldStart?: boolean;
  env?: Record<string, string>;
  scratch?: boolean;
  backend?: string;
  scopeId?: string;
}

export function hasParentPathSegment(path: string): boolean {
  return path.split("/").includes("..");
}

type WritablePersistence = "snapshot_to_workspace" | "resident_disk" | "provider_managed";
export type EgressEnforcement = "none" | "ip_port" | "domain";

export interface AgentComputerSpec {
  os?: string;
  runtimes?: string[];
  tools?: string[];
  notInstalled?: string[];
  cpus?: number;
  memoryMb?: number;
  diskGb?: number;
  homeDir?: string;
  workdir?: string;
}

export interface AgentComputerProfile {
  backend: string;
  writablePersistence: WritablePersistence;
  processSessions: boolean;
  egressEnforcement?: EgressEnforcement;
  spec?: AgentComputerSpec;
}

export function effectiveEgressEnforcement(
  profile: AgentComputerProfile,
  controlPlane: { signingSecret?: string; apiBaseUrl?: string },
): EgressEnforcement {
  return controlPlane.signingSecret && controlPlane.apiBaseUrl ? (profile.egressEnforcement ?? "none") : "none";
}

export function visibleNotInstalled(notInstalled: readonly string[], extraTools: readonly string[]): string[] {
  const advertised = new Set(extraTools.map((line) => line.trim().split(/\s+/)[0]).filter(Boolean));
  return notInstalled.filter((name) => !advertised.has(name));
}

export function visibleTools(tools: readonly string[]): string[] {
  const seen = new Set<string>();
  return tools.filter((line) => {
    const binary = line.trim().split(/\s+/)[0];
    if (!binary || seen.has(binary)) return false;
    seen.add(binary);
    return true;
  });
}

export interface ProvisionOptions {
  sandboxId?: string;
  env?: Record<string, string>;
  egress?: EgressPolicy;
  egressToken?: string;
  scratch?: { key: string };
  routeScopeId?: string;
  onStatus?: (text: string) => void;
}

export interface ExecPressure {
  ioFull10: number;
  ioFull60: number;
  load1: number;
}

export interface ExecResult {
  stdout: string;
  stderr: string;
  code: number;
  timedOut: boolean;
  pressure?: ExecPressure;
}

export interface ExecOptions {
  timeoutMs?: number;
  signal?: AbortSignal;
}

export const execFailureDetail = (result: ExecResult, timeoutSec: number): string =>
  result.stderr.trim() ||
  result.stdout.trim() ||
  (result.timedOut ? `timed out after ${timeoutSec}s with no output` : `exit ${result.code} with no output`);

export type AgentComputerExportArea = "workspace" | "home";

export interface AgentComputerExportEntry {
  area: AgentComputerExportArea;
  path: string;
  data: Uint8Array;
  mode?: number;
}

export interface AgentComputerExportOptions {
  include?: AgentComputerExportArea[];
  exclude?: (entry: Pick<AgentComputerExportEntry, "area" | "path">) => boolean;
  followSymlinks?: boolean;
  includePaths?: readonly string[];
  keepContentCaches?: boolean;
}

export type ProcessState = { state: "running" } | { state: "exited"; code: number };

export interface StartProcessOptions {
  cwd?: string;
  env?: Record<string, string>;
}

export interface ReadProcessOptions {
  sinceCursor?: number;
  maxBytes?: number;
  waitMs?: number;
}

export interface ReadProcessResult {
  chunks: string;
  cursor: number;
  status: ProcessState;
}

export interface ProcessSession {
  processId: string;
  command: string;
  startedAt: number;
  status: ProcessState;
}

export interface ComputerStatus {
  lifecycleState?: "running" | "paused";
  expiresAtMs?: number;
  recovery?: {
    strategy: "provider_snapshot" | "provider_pause" | "workspace_snapshot";
    checkpointId?: string;
    checkpointAtMs?: number;
    checkpointExpiresAtMs?: number | null;
    state?: string;
    error?: string;
  };
  machine: string;
  listed?: string;
  provisioned?: boolean;
  guestResponsive: boolean;
  probeError?: string;
  pressure?: ExecPressure;
}

export type ComputerVerdict = "ok" | "wedged" | "down";

export function computerVerdict(s: ComputerStatus): ComputerVerdict {
  if (s.guestResponsive || s.lifecycleState === "paused") return "ok";
  return s.provisioned ? "wedged" : "down";
}

export interface StageOptions {
  timeoutSec?: number;
}

export interface TeardownOptions {
  keepWarm?: boolean;
  destroy?: boolean;
  homeUnchanged?: boolean;
}

export interface Sandbox {
  readonly profile: AgentComputerProfile;
  profileFor?(scopeId: string): Promise<AgentComputerProfile>;
  provision(layers: WorkspaceLayer[], opts?: ProvisionOptions): Promise<SandboxHandle>;
  run(handle: SandboxHandle, command: string, opts?: ExecOptions): Promise<ExecResult>;
  readFile(handle: SandboxHandle, relPath: string): Promise<string | null>;
  writeFile(handle: SandboxHandle, relPath: string, data: string): Promise<void>;
  writeFileBytes(handle: SandboxHandle, relPath: string, data: Uint8Array): Promise<void>;
  readFileBytes(handle: SandboxHandle, relPath: string): Promise<Uint8Array | null>;
  stageIn?(handle: SandboxHandle, destRelPath: string, blobId: string, opts?: StageOptions): Promise<void>;
  stageOut?(handle: SandboxHandle, srcRelPath: string, opts?: StageOptions): Promise<string>;
  importFiles?(handle: SandboxHandle, entries: ReadonlyArray<{ path: string; data: Uint8Array }>): Promise<void>;
  listDir(handle: SandboxHandle, relDir: string): Promise<string[]>;
  removeDir(handle: SandboxHandle, relDir: string): Promise<void>;
  exportFiles?(handle: SandboxHandle, opts?: AgentComputerExportOptions): Promise<AgentComputerExportEntry[]>;
  startRegisteredProcess?(
    handle: SandboxHandle,
    command: string,
    register: (processId: string) => Promise<void>,
    opts?: StartProcessOptions,
  ): Promise<{ processId: string }>;
  startProcess?(handle: SandboxHandle, command: string, opts?: StartProcessOptions): Promise<{ processId: string }>;
  readProcess?(handle: SandboxHandle, processId: string, opts?: ReadProcessOptions): Promise<ReadProcessResult>;
  writeStdin?(handle: SandboxHandle, processId: string, data: string): Promise<void>;
  signalProcess?(handle: SandboxHandle, processId: string, signal: string): Promise<void>;
  listProcesses?(handle: SandboxHandle): Promise<ProcessSession[]>;
  adoptHomeSnapshot?(scopeId: string, blobId: string): Promise<void>;
  persistHomeSnapshot?(scopeId: string): Promise<void>;
  computerStatus?(scopeId: string): Promise<ComputerStatus>;
  restartComputer?(scopeId: string): Promise<void>;
  teardown(handle: SandboxHandle, opts?: TeardownOptions): Promise<void>;
  destroyScope?(scopeId: string): Promise<void>;
  reapDeepIdle?(idleMs: number, devIdleMs?: number): Promise<{ reaped: number }>;
}

export class CapabilityUnsupportedError extends Error {
  readonly backend: string;
  readonly capability: string;
  constructor(backend: string, capability: string) {
    super(`this computer's substrate (${backend}) does not support ${capability}`);
    this.name = "CapabilityUnsupportedError";
    this.backend = backend;
    this.capability = capability;
  }
}

export function supportsAgentComputerExport(
  sandbox: Sandbox,
): sandbox is Sandbox & Required<Pick<Sandbox, "exportFiles">> {
  return typeof sandbox.exportFiles === "function";
}

export function supportsScopeProfile(sandbox: Sandbox): sandbox is Sandbox & Required<Pick<Sandbox, "profileFor">> {
  return typeof sandbox.profileFor === "function";
}

export function supportsBlobStaging(
  sandbox: Sandbox,
): sandbox is Sandbox & Required<Pick<Sandbox, "stageIn" | "stageOut" | "importFiles">> {
  return (
    typeof sandbox.stageIn === "function" &&
    typeof sandbox.stageOut === "function" &&
    typeof sandbox.importFiles === "function"
  );
}

export type ProcessSandbox = Sandbox &
  Required<Pick<Sandbox, "startProcess" | "readProcess" | "writeStdin" | "signalProcess" | "listProcesses">>;

export function supportsProcessSessions(sandbox: Sandbox): sandbox is ProcessSandbox {
  return (
    sandbox.profile.processSessions === true &&
    typeof sandbox.startProcess === "function" &&
    typeof sandbox.readProcess === "function" &&
    typeof sandbox.writeStdin === "function" &&
    typeof sandbox.signalProcess === "function" &&
    typeof sandbox.listProcesses === "function"
  );
}

const SANDBOX_CAPABILITIES: ReadonlyArray<{ label: string; supported: (s: Sandbox) => boolean }> = [
  { label: "process sessions (background work, dev servers)", supported: supportsProcessSessions },
  { label: "home export (publish, resident-auth capture)", supported: supportsAgentComputerExport },
];

const ENFORCEMENT_RANK: Record<EgressEnforcement, number> = { none: 0, ip_port: 1, domain: 2 };

export function capabilitiesLostMovingTo(from: Sandbox, to: Sandbox): string[] {
  const lost = SANDBOX_CAPABILITIES.filter((c) => c.supported(from) && !c.supported(to)).map((c) => c.label);
  const fromEgress = from.profile.egressEnforcement ?? "none";
  const toEgress = to.profile.egressEnforcement ?? "none";
  if (ENFORCEMENT_RANK[toEgress] < ENFORCEMENT_RANK[fromEgress]) {
    lost.push(`egress enforcement (${fromEgress} on the source, ${toEgress} on the target)`);
  }
  return lost;
}
