import { CliError } from "./log.ts";
import { sleep } from "./util.ts";

export interface BackgroundWorkStatus {
  protocol: 2;
  deploymentId: string;
  instanceId: string;
  ownerDeploymentId: string | null;
  setAt: string | null;
  setBy: string | null;
  active: boolean;
}

export interface BackgroundOwnerChange {
  ownerDeploymentId: string | null;
  expectedOwnerDeploymentId: string | null;
}

export type BackgroundWorkTransport = (
  method: "GET" | "POST",
  body?: string,
) => Promise<{ status: number; body: string }>;

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function text(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function nullableText(value: unknown): value is string | null {
  return value === null || text(value);
}

function memberProtocolStatus(value: Record<string, unknown>): BackgroundWorkStatus | undefined {
  if (
    typeof value.enabled !== "boolean" ||
    !nullableText(value.desiredDeploymentId) ||
    !Array.isArray(value.members) ||
    !value.members.every(record)
  )
    return undefined;
  const self = value.members.find((member) => member.instanceId === value.instanceId);
  return {
    protocol: 2,
    deploymentId: value.deploymentId as string,
    instanceId: value.instanceId as string,
    ownerDeploymentId: value.enabled ? value.desiredDeploymentId : null,
    setAt: null,
    setBy: null,
    active: self?.state === "admitted" && self.ready === true && self.retired === false,
  };
}

export function parseBackgroundWorkStatus(body: string, deploymentId: string): BackgroundWorkStatus {
  let value: unknown;
  try {
    value = JSON.parse(body);
  } catch {
    throw new CliError("background ownership returned invalid JSON");
  }
  if (!record(value) || value.deploymentId !== deploymentId || !text(value.instanceId))
    throw new CliError("background ownership response does not match the requested deployment");
  const legacy = value.protocol === 1 ? memberProtocolStatus(value) : undefined;
  if (legacy) return legacy;
  if (
    value.protocol !== 2 ||
    !nullableText(value.ownerDeploymentId) ||
    !nullableText(value.setAt) ||
    !nullableText(value.setBy) ||
    typeof value.active !== "boolean"
  )
    throw new CliError("background ownership response does not match the single-owner protocol");
  return {
    protocol: 2,
    deploymentId,
    instanceId: value.instanceId,
    ownerDeploymentId: value.ownerDeploymentId,
    setAt: value.setAt,
    setBy: value.setBy,
    active: value.active,
  };
}

export async function readBackgroundWork(
  transport: BackgroundWorkTransport,
  deploymentId: string,
): Promise<BackgroundWorkStatus> {
  const response = await transport("GET");
  if (response.status !== 200)
    throw new CliError(`background ownership read failed with HTTP ${response.status}; legacy fallback is forbidden`);
  return parseBackgroundWorkStatus(response.body, deploymentId);
}

export async function setBackgroundOwner(
  transport: BackgroundWorkTransport,
  deploymentId: string,
  change: BackgroundOwnerChange,
): Promise<BackgroundWorkStatus> {
  const body = JSON.stringify(change);
  let response: { status: number; body: string } | undefined;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      response = await transport("POST", body);
    } catch {
      response = undefined;
    }
    if (response?.status === 200) {
      try {
        const state = parseBackgroundWorkStatus(response.body, deploymentId);
        if (state.ownerDeploymentId === change.ownerDeploymentId) return state;
      } catch {
        response = undefined;
      }
    }
    let observed: BackgroundWorkStatus | undefined;
    try {
      observed = await readBackgroundWork(transport, deploymentId);
    } catch {
      observed = undefined;
    }
    if (observed?.ownerDeploymentId === change.ownerDeploymentId) return observed;
    if (observed && observed.ownerDeploymentId !== change.expectedOwnerDeploymentId)
      throw new CliError("background ownership changed concurrently; refusing to replace another owner");
    if (response && response.status >= 400 && response.status < 500 && response.status !== 429) break;
  }
  throw new CliError(
    `background ownership change is unconfirmed${response ? ` (HTTP ${response.status})` : ""}; read ownership before retrying`,
  );
}

export async function awaitBackgroundWork(
  transport: BackgroundWorkTransport,
  deploymentId: string,
  expected: { ownerDeploymentId: string | null; active: boolean; instances: number },
  options: { timeoutMs: number; pollMs: number },
): Promise<BackgroundWorkStatus> {
  const deadline = Date.now() + options.timeoutMs;
  const confirmed = new Set<string>();
  for (;;) {
    const state = await readBackgroundWork(transport, deploymentId);
    if (state.ownerDeploymentId !== expected.ownerDeploymentId)
      throw new CliError("background ownership changed while awaiting acknowledgment");
    if (state.active === expected.active) confirmed.add(state.instanceId);
    else confirmed.clear();
    if (confirmed.size >= expected.instances) return state;
    if (Date.now() >= deadline)
      throw new CliError(
        `timed out awaiting ${expected.instances} ${deploymentId} process(es) to ${expected.active ? "start" : "stop"} background work; ${confirmed.size} confirmed`,
      );
    await sleep(options.pollMs);
  }
}
