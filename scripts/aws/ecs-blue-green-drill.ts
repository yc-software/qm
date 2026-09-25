import { loadConfigAt, type QmConfig } from "../../cli/src/config.ts";
import { assertAwsCaller, awsJson, awsText, discoverCoreTask, requireAwsConfig } from "./deployment.ts";

interface Args {
  configPath: string;
}

interface Service {
  serviceArn?: string;
  status?: string;
  taskDefinition?: string;
  desiredCount?: number;
  runningCount?: number;
  pendingCount?: number;
  deploymentController?: { type?: string };
  deploymentConfiguration?: { strategy?: string };
  deployments?: Array<{ status?: string; rolloutState?: string }>;
}

interface DeploymentSummary {
  serviceDeploymentArn?: string;
  status?: string;
  statusReason?: string;
  targetServiceRevisionArn?: string;
  deploymentConfiguration?: {
    deploymentCircuitBreaker?: { enable?: boolean; rollback?: boolean };
  };
}

const ACTIVE_DEPLOYMENT_STATES = new Set([
  "PENDING",
  "IN_PROGRESS",
  "ROLLBACK_REQUESTED",
  "ROLLBACK_IN_PROGRESS",
  "STOP_REQUESTED",
]);

function parseArgs(argv: string[]): Args {
  let configPath = "";
  let yes = false;
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (arg === "--yes") {
      yes = true;
      continue;
    }
    const value = argv[++index];
    if (!value) throw new Error(`${arg} requires a value`);
    if (arg === "--config") configPath = value;
    else throw new Error(`unknown argument ${arg}`);
  }
  if (!configPath || !yes) throw new Error("usage: ecs-blue-green-drill.ts --config <file> --yes");
  return { configPath };
}

function describeService(config: QmConfig, cluster: string, service: string): Service {
  const result = awsJson<{ services?: Service[]; failures?: unknown[] }>(config, [
    "ecs",
    "describe-services",
    "--cluster",
    cluster,
    "--services",
    service,
  ]);
  if (result.failures?.length || !result.services?.[0]) throw new Error(`could not describe ECS service ${service}`);
  return result.services[0];
}

function assertHealthyBlueGreen(service: Service, expectedTaskDefinition?: string): void {
  if (
    service.status !== "ACTIVE" ||
    service.deploymentController?.type !== "ECS" ||
    service.deploymentConfiguration?.strategy !== "BLUE_GREEN" ||
    !service.serviceArn ||
    !service.taskDefinition ||
    !service.desiredCount ||
    service.runningCount !== service.desiredCount ||
    service.pendingCount !== 0 ||
    (expectedTaskDefinition && service.taskDefinition !== expectedTaskDefinition)
  ) {
    throw new Error("core staging service is not a stable native ECS blue/green deployment");
  }
}

function assertSettledHealthyBlueGreen(service: Service, expectedTaskDefinition: string): void {
  assertHealthyBlueGreen(service, expectedTaskDefinition);
  if (
    service.deployments?.length !== 1 ||
    service.deployments[0]?.status !== "PRIMARY" ||
    service.deployments[0]?.rolloutState !== "COMPLETED"
  ) {
    throw new Error("core staging rollback is healthy but its failed task set has not finished draining");
  }
}

const TASK_DEFINITION_FIELDS = [
  "family",
  "taskRoleArn",
  "executionRoleArn",
  "networkMode",
  "containerDefinitions",
  "volumes",
  "placementConstraints",
  "requiresCompatibilities",
  "cpu",
  "memory",
  "tags",
  "pidMode",
  "ipcMode",
  "proxyConfiguration",
  "inferenceAccelerators",
  "ephemeralStorage",
  "runtimePlatform",
  "enableFaultInjection",
] as const;

export function brokenTaskDefinition(source: Record<string, unknown>): Record<string, unknown> {
  const definition = Object.fromEntries(
    TASK_DEFINITION_FIELDS.flatMap((field) => (source[field] === undefined ? [] : [[field, source[field]]])),
  );
  const containers = source.containerDefinitions;
  if (!Array.isArray(containers)) throw new Error("task definition has no container definitions");
  let foundCore = false;
  definition.containerDefinitions = containers.map((value) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid container definition");
    const container = value as Record<string, unknown>;
    if (container.name !== "core") return container;
    foundCore = true;
    return {
      ...container,
      healthCheck: {
        command: ["CMD-SHELL", "exit 1"],
        interval: 5,
        timeout: 2,
        retries: 2,
        startPeriod: 0,
      },
    };
  });
  if (!foundCore) throw new Error("task definition has no core container");
  return definition;
}

function registerBrokenTask(config: QmConfig, taskDefinition: string): string {
  const described = awsJson<{ taskDefinition?: Record<string, unknown> }>(config, [
    "ecs",
    "describe-task-definition",
    "--task-definition",
    taskDefinition,
  ]);
  if (!described.taskDefinition) throw new Error(`could not describe task definition ${taskDefinition}`);
  return awsText(config, [
    "ecs",
    "register-task-definition",
    "--cli-input-json",
    JSON.stringify(brokenTaskDefinition(described.taskDefinition)),
    "--tags",
    JSON.stringify([{ key: "ManagedBy", value: "qm-blue-green-drill" }]),
    "--query",
    "taskDefinition.taskDefinitionArn",
    "--output",
    "text",
  ]);
}

function listDeployments(config: QmConfig, cluster: string, service: string): DeploymentSummary[] {
  return (
    awsJson<{ serviceDeployments?: DeploymentSummary[] }>(config, [
      "ecs",
      "list-service-deployments",
      "--cluster",
      cluster,
      "--service",
      service,
      "--max-results",
      "20",
    ]).serviceDeployments ?? []
  );
}

function describeDeployment(config: QmConfig, arn: string): DeploymentSummary {
  const deployment = awsJson<{ serviceDeployments?: DeploymentSummary[] }>(config, [
    "ecs",
    "describe-service-deployments",
    "--service-deployment-arns",
    arn,
  ]).serviceDeployments?.[0];
  if (!deployment) throw new Error(`could not describe service deployment ${arn}`);
  return deployment;
}

function requireRollbackCandidate(config: QmConfig, service: Service, deployments: DeploymentSummary[]): void {
  if (
    service.deployments?.length !== 1 ||
    service.deployments[0]?.status !== "PRIMARY" ||
    service.deployments[0]?.rolloutState !== "COMPLETED"
  ) {
    throw new Error(
      "core staging baseline is not fully settled; wait for the prior task-set cleanup before testing rollback",
    );
  }
  const found = deployments.some((deployment) => {
    if (deployment.status !== "SUCCESSFUL" || !deployment.serviceDeploymentArn) return false;
    const breaker = describeDeployment(config, deployment.serviceDeploymentArn).deploymentConfiguration
      ?.deploymentCircuitBreaker;
    return breaker?.enable === true && breaker.rollback === true;
  });
  if (!found) {
    throw new Error(
      "core staging has no successful circuit-breaker-enabled rollback candidate; establish a healthy baseline deployment first",
    );
  }
}

async function waitForHealthyService(
  config: QmConfig,
  cluster: string,
  service: string,
  expectedTaskDefinition: string,
  deadline: number,
): Promise<void> {
  let lastError = "service is not healthy";
  while (Date.now() < deadline) {
    try {
      assertSettledHealthyBlueGreen(describeService(config, cluster, service), expectedTaskDefinition);
      return;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    await pause();
  }
  throw new Error(`core staging service did not recover before its deadline: ${lastError}`);
}

async function pause(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, Number(process.env.AWS_RECOVERY_POLL_MS) || 10_000));
}

async function findNewDeployment(
  config: QmConfig,
  cluster: string,
  service: string,
  prior: Set<string>,
  deadline: number,
): Promise<string> {
  while (Date.now() < deadline) {
    const found = listDeployments(config, cluster, service).find(
      (deployment) => deployment.serviceDeploymentArn && !prior.has(deployment.serviceDeploymentArn),
    )?.serviceDeploymentArn;
    if (found) return found;
    await pause();
  }
  throw new Error("ECS did not create a service deployment for the fault-injection task");
}

async function waitForRollback(config: QmConfig, arn: string, deadline: number): Promise<void> {
  while (Date.now() < deadline) {
    const deployment = describeDeployment(config, arn);
    if (deployment.status === "ROLLBACK_SUCCESSFUL") return;
    if (deployment.status && !ACTIVE_DEPLOYMENT_STATES.has(deployment.status)) {
      throw new Error(
        `fault-injection deployment ended ${deployment.status}: ${deployment.statusReason ?? "no status reason"}`,
      );
    }
    await pause();
  }
  throw new Error(`fault-injection deployment ${arn} did not roll back before its deadline`);
}

function rollbackActiveDeployment(config: QmConfig, arn: string): void {
  const status = describeDeployment(config, arn).status;
  if (!status || !ACTIVE_DEPLOYMENT_STATES.has(status)) return;
  awsText(config, ["ecs", "stop-service-deployment", "--service-deployment-arn", arn, "--stop-type", "ROLLBACK"]);
}

export async function main(argv = process.argv.slice(2)): Promise<void> {
  const args = parseArgs(argv);
  const { config } = loadConfigAt(args.configPath);
  const aws = requireAwsConfig(config);
  if (aws.deployEnvironment !== "staging") {
    throw new Error("blue/green fault injection is restricted to an AWS staging deployment");
  }
  assertAwsCaller(config);
  const facts = discoverCoreTask(config);
  const original = describeService(config, facts.cluster, facts.service);
  assertHealthyBlueGreen(original);
  const originalTask = original.taskDefinition!;
  const deployments = listDeployments(config, facts.cluster, facts.service);
  const previous = new Set(
    deployments.flatMap((deployment) => (deployment.serviceDeploymentArn ? [deployment.serviceDeploymentArn] : [])),
  );
  if (deployments.some((deployment) => deployment.status && ACTIVE_DEPLOYMENT_STATES.has(deployment.status))) {
    throw new Error("refusing to inject a fault while another ECS service deployment is active");
  }
  requireRollbackCandidate(config, original, deployments);

  const brokenTask = registerBrokenTask(config, originalTask);
  let deploymentArn: string | undefined;
  let succeeded = false;
  try {
    awsText(config, [
      "ecs",
      "update-service",
      "--cluster",
      facts.cluster,
      "--service",
      facts.service,
      "--task-definition",
      brokenTask,
    ]);
    const deadline = Date.now() + (Number(process.env.AWS_RECOVERY_TIMEOUT_MS) || 30 * 60_000);
    deploymentArn = await findNewDeployment(config, facts.cluster, facts.service, previous, deadline);
    await waitForRollback(config, deploymentArn, deadline);
    await waitForHealthyService(config, facts.cluster, facts.service, originalTask, deadline);
    succeeded = true;
    console.log(`ECS_BLUE_GREEN_ROLLBACK_OK=${deploymentArn}`);
  } finally {
    if (!succeeded) {
      try {
        const active =
          deploymentArn ??
          listDeployments(config, facts.cluster, facts.service).find(
            (deployment) =>
              deployment.serviceDeploymentArn &&
              !previous.has(deployment.serviceDeploymentArn) &&
              deployment.status &&
              ACTIVE_DEPLOYMENT_STATES.has(deployment.status),
          )?.serviceDeploymentArn;
        const deadline = Date.now() + (Number(process.env.AWS_RECOVERY_TIMEOUT_MS) || 30 * 60_000);
        if (active) {
          rollbackActiveDeployment(config, active);
          try {
            await waitForRollback(config, active, deadline);
          } catch (error) {
            console.warn(
              `automatic rollback did not recover the service; restoring the original task definition: ${
                error instanceof Error ? error.message : error
              }`,
            );
          }
        }
        const current = describeService(config, facts.cluster, facts.service);
        if (current.taskDefinition !== originalTask) {
          awsText(config, [
            "ecs",
            "update-service",
            "--cluster",
            facts.cluster,
            "--service",
            facts.service,
            "--task-definition",
            originalTask,
          ]);
        }
        await waitForHealthyService(config, facts.cluster, facts.service, originalTask, deadline);
      } catch (error) {
        console.error(`emergency rollback failed: ${error instanceof Error ? error.message : error}`);
      }
    }
    try {
      awsText(config, ["ecs", "deregister-task-definition", "--task-definition", brokenTask]);
    } catch (error) {
      console.warn(`warning: could not deregister ${brokenTask}: ${error instanceof Error ? error.message : error}`);
    }
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
