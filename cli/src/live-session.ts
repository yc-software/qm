import { randomUUID } from "node:crypto";
import { CliError } from "./log.ts";

export async function checkControlledLiveSession(
  deploymentId: string,
  request: (body: string) => Promise<{ status: number; body: string }>,
): Promise<void> {
  const requestId = randomUUID();
  let response: { status: number; body: string };
  try {
    response = await request(JSON.stringify({ requestId, expectedDeploymentId: deploymentId }));
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
  if (value.ok !== true || value.requestId !== requestId || value.deploymentId !== deploymentId)
    throw new CliError(`live session did not confirm success for the expected request and deployment (${requestId})`);
}
