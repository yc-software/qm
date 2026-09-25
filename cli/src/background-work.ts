import { randomUUID } from "node:crypto";
import { CliError } from "./log.ts";
import { sleep } from "./util.ts";

export interface BackgroundWorkMember {
  instanceId: string;
  taskArn: string | null;
  deploymentId: string;
  generation: number;
  state: "admitted" | "relinquished" | "drained";
  retired: boolean;
  ready: boolean;
}

export interface BackgroundWorkStatus {
  protocol: 1;
  enabled: boolean;
  deploymentId: string;
  instanceId: string;
  generation: number;
  desiredDeploymentId: string | null;
  lastRequestId: string | null;
  members: BackgroundWorkMember[];
}

export type BackgroundWorkTransport = (
  method: "GET" | "POST",
  body?: string,
) => Promise<{ status: number; body: string }>;

export type BackgroundWorkMutation = {
  expectedGeneration: number;
  requestId: string;
} & (
  | { desiredDeploymentId: string | null; bootstrapTaskArns?: string[]; expectedLastRequestId?: string | null }
  | { terminatedMembers: Array<Pick<BackgroundWorkMember, "instanceId" | "taskArn" | "generation">> }
);

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function text(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function generation(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

export function parseBackgroundWorkStatus(body: string, deploymentId: string): BackgroundWorkStatus {
  let value: unknown;
  try {
    value = JSON.parse(body);
  } catch {
    throw new CliError("background ownership returned invalid JSON");
  }
  if (
    !record(value) ||
    value.protocol !== 1 ||
    typeof value.enabled !== "boolean" ||
    value.deploymentId !== deploymentId ||
    !text(value.instanceId) ||
    !generation(value.generation) ||
    !(value.desiredDeploymentId === null || text(value.desiredDeploymentId)) ||
    !(value.lastRequestId === null || text(value.lastRequestId)) ||
    !Array.isArray(value.members)
  ) {
    throw new CliError("background ownership response does not match the requested deployment and protocol");
  }
  const members = value.members;
  for (const member of members) {
    if (
      !record(member) ||
      !text(member.instanceId) ||
      !(member.taskArn === null || text(member.taskArn)) ||
      !text(member.deploymentId) ||
      !generation(member.generation) ||
      member.generation > value.generation ||
      !["admitted", "relinquished", "drained"].includes(String(member.state)) ||
      typeof member.retired !== "boolean" ||
      typeof member.ready !== "boolean"
    ) {
      throw new CliError("background ownership returned an invalid member");
    }
  }
  const identities = members.map((member) => member.instanceId);
  if (new Set(identities).size !== identities.length)
    throw new CliError("background ownership returned duplicate instance identities");
  if (
    !members.some(
      (member) => member.instanceId === value.instanceId && member.deploymentId === deploymentId && !member.retired,
    )
  )
    throw new CliError("background ownership responder is not enrolled in its durable membership");
  return value as unknown as BackgroundWorkStatus;
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

function mutationCommitted(state: BackgroundWorkStatus, mutation: BackgroundWorkMutation): boolean {
  if (state.lastRequestId !== mutation.requestId) return false;
  if ("desiredDeploymentId" in mutation) {
    return (
      state.generation === mutation.expectedGeneration + 1 &&
      state.desiredDeploymentId === mutation.desiredDeploymentId &&
      state.enabled
    );
  }
  return (
    state.generation === mutation.expectedGeneration &&
    mutation.terminatedMembers.every((retired) =>
      state.members.some(
        (member) =>
          member.instanceId === retired.instanceId &&
          member.taskArn === retired.taskArn &&
          member.generation === retired.generation &&
          member.retired,
      ),
    )
  );
}

export async function mutateBackgroundWork(
  transport: BackgroundWorkTransport,
  deploymentId: string,
  mutation: BackgroundWorkMutation,
): Promise<BackgroundWorkStatus> {
  const body = JSON.stringify(mutation);
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
        if (mutationCommitted(state, mutation)) return state;
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
    if (observed && mutationCommitted(observed, mutation)) return observed;
    if (observed && observed.generation !== mutation.expectedGeneration)
      throw new CliError("background ownership changed concurrently; refusing to replace another ownership generation");
    if (response && response.status >= 400 && response.status < 500 && response.status !== 429) break;
  }
  throw new CliError(
    `background ownership mutation is unconfirmed${response ? ` (HTTP ${response.status})` : ""}; retry the same request ID ${mutation.requestId} after reading ownership; automatic compensation is unsafe`,
  );
}

export function backgroundWorkMutation(
  expectedGeneration: number,
  desiredDeploymentId: string | null,
): BackgroundWorkMutation {
  return { expectedGeneration, desiredDeploymentId, requestId: randomUUID() };
}

export async function awaitBackgroundWork(
  transport: BackgroundWorkTransport,
  deploymentId: string,
  expected: {
    generation: number;
    desiredDeploymentId: string | null;
    taskArns: string[];
    lastRequestId?: string | null;
  },
  options: { timeoutMs: number; pollMs: number },
): Promise<BackgroundWorkStatus> {
  const deadline = Date.now() + options.timeoutMs;
  for (;;) {
    const state = await readBackgroundWork(transport, deploymentId);
    if (
      !state.enabled ||
      state.generation !== expected.generation ||
      state.desiredDeploymentId !== expected.desiredDeploymentId ||
      (expected.lastRequestId !== undefined && state.lastRequestId !== expected.lastRequestId)
    ) {
      throw new CliError("background ownership changed while awaiting acknowledgment");
    }
    const priorOwners = state.members.filter(
      (member) => !member.retired && member.generation < expected.generation && member.state === "admitted",
    );
    const ready =
      expected.desiredDeploymentId === null
        ? state.members.every((member) => member.retired || member.state !== "admitted")
        : expected.taskArns.length > 0 &&
          expected.taskArns.every((taskArn) =>
            state.members.some(
              (member) =>
                member.taskArn === taskArn &&
                member.deploymentId === expected.desiredDeploymentId &&
                member.generation === expected.generation &&
                member.state === "admitted" &&
                member.ready &&
                !member.retired,
            ),
          );
    const unexpectedOwner = state.members.some(
      (member) =>
        !member.retired && member.state === "admitted" && member.deploymentId !== expected.desiredDeploymentId,
    );
    if (priorOwners.length === 0 && !unexpectedOwner && ready) return state;
    if (Date.now() >= deadline)
      throw new CliError("timed out awaiting background ownership acknowledgment; no member was inferred dead");
    await sleep(options.pollMs);
  }
}
