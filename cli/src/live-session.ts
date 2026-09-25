import { randomUUID } from "node:crypto";
import type { BackgroundWorkStatus } from "./background-work.ts";
import { CliError } from "./log.ts";

export interface LiveSessionCohort {
  deploymentId: string;
  taskArns: string[];
  status: BackgroundWorkStatus;
}

function assertReady(cohort: LiveSessionCohort): void {
  const { deploymentId, taskArns, status } = cohort;
  if (
    !status.enabled ||
    status.deploymentId !== deploymentId ||
    status.desiredDeploymentId !== deploymentId ||
    taskArns.length === 0 ||
    new Set(taskArns).size !== taskArns.length ||
    taskArns.some(
      (taskArn) =>
        !status.members.some(
          (member) =>
            member.taskArn === taskArn &&
            member.deploymentId === deploymentId &&
            member.generation === status.generation &&
            member.state === "admitted" &&
            member.ready &&
            !member.retired,
        ),
    ) ||
    status.members.some(
      (member) =>
        !member.retired &&
        member.state === "admitted" &&
        (member.deploymentId !== deploymentId ||
          member.generation !== status.generation ||
          member.taskArn === null ||
          !taskArns.includes(member.taskArn)),
    )
  )
    throw new CliError("live session requires the exact ready deployment cohort to own background work");
}

export async function checkControlledLiveSession(options: {
  before: LiveSessionCohort;
  read: () => Promise<LiveSessionCohort>;
  request: (body: string) => Promise<{ status: number; body: string }>;
}): Promise<void> {
  const { before } = options;
  assertReady(before);
  const requestId = randomUUID();
  let response: { status: number; body: string };
  try {
    response = await options.request(
      JSON.stringify({
        requestId,
        expectedDeploymentId: before.deploymentId,
        expectedGeneration: before.status.generation,
        expectedTaskArns: before.taskArns,
      }),
    );
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
    value.generation !== before.status.generation ||
    !before.status.members.some(
      (member) =>
        member.instanceId === value.instanceId &&
        member.taskArn === value.taskArn &&
        before.taskArns.includes(member.taskArn ?? "") &&
        member.deploymentId === before.deploymentId &&
        member.generation === before.status.generation &&
        member.state === "admitted" &&
        member.ready &&
        !member.retired,
    )
  )
    throw new CliError(
      `live session did not confirm success for the expected request and deployment cohort (${requestId})`,
    );
  const after = await options.read();
  assertReady(after);
  if (
    after.deploymentId !== before.deploymentId ||
    after.status.generation !== before.status.generation ||
    after.taskArns.length !== before.taskArns.length ||
    after.taskArns.some((arn) => !before.taskArns.includes(arn)) ||
    !after.status.members.some(
      (member) =>
        member.instanceId === value.instanceId &&
        member.taskArn === value.taskArn &&
        member.state === "admitted" &&
        member.ready &&
        !member.retired &&
        member.generation === before.status.generation,
    )
  )
    throw new CliError("live session deployment cohort changed during qualification");
}
