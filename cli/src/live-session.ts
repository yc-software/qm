import { randomUUID } from "node:crypto";
import type { BackgroundWorkStatus } from "./background-work.ts";
import { CliError } from "./log.ts";

export interface LiveSessionOwner {
  deploymentId: string;
  status: BackgroundWorkStatus;
}

function assertActiveOwner({ deploymentId, status }: LiveSessionOwner): void {
  if (status.deploymentId !== deploymentId || status.ownerDeploymentId !== deploymentId || !status.active)
    throw new CliError("live session requires an active deployment that owns background work");
}

export async function checkControlledLiveSession(options: {
  before: LiveSessionOwner;
  read: () => Promise<LiveSessionOwner>;
  request: (body: string) => Promise<{ status: number; body: string }>;
}): Promise<void> {
  const { before } = options;
  assertActiveOwner(before);
  const requestId = randomUUID();
  let response: { status: number; body: string };
  try {
    response = await options.request(JSON.stringify({ requestId, expectedDeploymentId: before.deploymentId }));
  } catch {
    throw new CliError(
      `live session result is unconfirmed for request ${requestId}; no automatic replay or fallback was attempted`,
    );
  }
  if (response.status !== 200) throw new CliError(`live session rejected with HTTP ${response.status}`);
  let result: unknown;
  try {
    result = JSON.parse(response.body);
  } catch {
    throw new CliError(`live session returned no valid final result for request ${requestId}`);
  }
  if (!result || typeof result !== "object" || Array.isArray(result))
    throw new CliError("live session returned an invalid final result");
  const value = result as Record<string, unknown>;
  if (
    value.ok !== true ||
    value.requestId !== requestId ||
    value.deploymentId !== before.deploymentId ||
    typeof value.instanceId !== "string" ||
    !value.instanceId
  )
    throw new CliError(`live session did not confirm success for the expected request and deployment (${requestId})`);
  const after = await options.read();
  assertActiveOwner(after);
  if (after.deploymentId !== before.deploymentId)
    throw new CliError("live session deployment changed during qualification");
}
