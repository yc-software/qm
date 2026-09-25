import { execFileSync } from "node:child_process";
import type { QmConfig } from "../../cli/src/config.ts";

export interface CoreTaskFacts {
  cluster: string;
  service: string;
  family: string;
  bucket?: string;
  databaseUrlSecretArn?: string;
  executionRoleArn: string;
  taskRoleArn: string;
  logGroup: string;
  subnets: string[];
  securityGroups: string[];
  assignPublicIp: "ENABLED" | "DISABLED";
  platformVersion?: string;
  cpuArchitecture: "ARM64" | "X86_64";
}

export interface OneOffOptions {
  label: string;
  image: string;
  command: string;
  needsDatabase: boolean;
  environment?: Record<string, string>;
  timeoutMs?: number;
}

export function requireAwsConfig(config: QmConfig) {
  if (config.target !== "aws" || !config.aws) throw new Error("operation requires an AWS deployment config");
  return config.aws;
}

export function awsText(config: QmConfig, args: string[]): string {
  const aws = requireAwsConfig(config);
  try {
    return execFileSync(process.env.AWS_BIN || "aws", [...args, "--region", aws.region, "--no-cli-pager"], {
      encoding: "utf8",
      maxBuffer: 20 * 1024 * 1024,
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  } catch (error) {
    const failure = error as { stderr?: string | Buffer; message?: string };
    let detail = failure.message;
    if (typeof failure.stderr === "string") detail = failure.stderr;
    else if (Buffer.isBuffer(failure.stderr)) detail = failure.stderr.toString("utf8");
    throw new Error(`aws ${args.slice(0, 3).join(" ")} failed: ${(detail ?? "unknown error").trim().slice(0, 1000)}`, {
      cause: error,
    });
  }
}

export function awsJson<T>(config: QmConfig, args: string[]): T {
  return JSON.parse(awsText(config, [...args, "--output", "json"])) as T;
}

export function assertAwsCaller(config: QmConfig): void {
  const aws = requireAwsConfig(config);
  const account = awsText(config, ["sts", "get-caller-identity", "--query", "Account", "--output", "text"]);
  if (account !== aws.accountId)
    throw new Error(`authenticated to AWS account ${account || "unknown"}, expected ${aws.accountId}`);
}

export function discoverCoreTask(config: QmConfig): CoreTaskFacts {
  const aws = requireAwsConfig(config);
  const core = aws.services.core;
  if (!core) throw new Error("AWS config has no core service");
  const described = awsJson<{
    services?: Array<{
      status?: string;
      taskDefinition?: string;
      platformVersion?: string;
      networkConfiguration?: {
        awsvpcConfiguration?: {
          subnets?: string[];
          securityGroups?: string[];
          assignPublicIp?: string;
        };
      };
    }>;
    failures?: Array<{ arn?: string; reason?: string }>;
  }>(config, ["ecs", "describe-services", "--cluster", aws.cluster, "--services", core.ecsService]);
  const service = described.services?.[0];
  const network = service?.networkConfiguration?.awsvpcConfiguration;
  if (
    described.failures?.length ||
    service?.status !== "ACTIVE" ||
    !service.taskDefinition ||
    !network?.subnets?.length ||
    !network.securityGroups?.length ||
    (network.assignPublicIp !== "ENABLED" && network.assignPublicIp !== "DISABLED")
  ) {
    throw new Error(`core service ${core.ecsService} is not an active reusable Fargate service`);
  }
  const definition = awsJson<{
    taskDefinition?: {
      family?: string;
      executionRoleArn?: string;
      taskRoleArn?: string;
      runtimePlatform?: { cpuArchitecture?: string };
      containerDefinitions?: Array<{
        name?: string;
        environment?: Array<{ name?: string; value?: string }>;
        secrets?: Array<{ name?: string; valueFrom?: string }>;
        logConfiguration?: { options?: Record<string, string> };
      }>;
    };
  }>(config, ["ecs", "describe-task-definition", "--task-definition", service.taskDefinition]);
  const task = definition.taskDefinition;
  const container = task?.containerDefinitions?.find((entry) => entry.name === "core");
  const databaseUrlSecretArn = container?.secrets?.find((entry) => entry.name === "DATABASE_URL")?.valueFrom;
  const bucket = container?.environment?.find((entry) => entry.name === "S3_BUCKET")?.value;
  const logGroup = container?.logConfiguration?.options?.["awslogs-group"];
  if (
    task?.family !== core.ecsService ||
    !task.executionRoleArn ||
    !task.taskRoleArn ||
    !logGroup ||
    (task.runtimePlatform?.cpuArchitecture !== "ARM64" && task.runtimePlatform?.cpuArchitecture !== "X86_64")
  ) {
    throw new Error(
      `core task definition ${service.taskDefinition} is missing its family, roles, architecture, or log group`,
    );
  }
  return {
    cluster: aws.cluster,
    service: core.ecsService,
    family: task.family,
    ...(bucket ? { bucket } : {}),
    ...(databaseUrlSecretArn ? { databaseUrlSecretArn } : {}),
    executionRoleArn: task.executionRoleArn,
    taskRoleArn: task.taskRoleArn,
    logGroup,
    subnets: network.subnets,
    securityGroups: network.securityGroups,
    assignPublicIp: network.assignPublicIp,
    ...(service.platformVersion ? { platformVersion: service.platformVersion } : {}),
    cpuArchitecture: task.runtimePlatform.cpuArchitecture,
  };
}

function registerOneOff(config: QmConfig, facts: CoreTaskFacts, options: OneOffOptions): string {
  if (!/^[a-z0-9][a-z0-9-]{0,30}$/.test(options.label)) throw new Error(`invalid one-off label ${options.label}`);
  if (options.needsDatabase && !facts.databaseUrlSecretArn) throw new Error("core task has no DATABASE_URL secret");
  const definition = {
    family: facts.family,
    requiresCompatibilities: ["FARGATE"],
    networkMode: "awsvpc",
    cpu: "1024",
    memory: "4096",
    runtimePlatform: {
      cpuArchitecture: facts.cpuArchitecture,
      operatingSystemFamily: "LINUX",
    },
    executionRoleArn: facts.executionRoleArn,
    taskRoleArn: facts.taskRoleArn,
    containerDefinitions: [
      {
        name: "core",
        image: options.image,
        essential: true,
        entryPoint: ["/bin/sh", "-c"],
        command: [options.command],
        environment: Object.entries({
          AWS_DEFAULT_REGION: requireAwsConfig(config).region,
          ...options.environment,
        }).map(([name, value]) => ({ name, value })),
        secrets: options.needsDatabase ? [{ name: "DATABASE_URL", valueFrom: facts.databaseUrlSecretArn }] : [],
        logConfiguration: {
          logDriver: "awslogs",
          options: {
            "awslogs-group": facts.logGroup,
            "awslogs-region": requireAwsConfig(config).region,
            "awslogs-stream-prefix": options.label,
          },
        },
      },
    ],
  };
  return awsText(config, [
    "ecs",
    "register-task-definition",
    "--cli-input-json",
    JSON.stringify(definition),
    "--tags",
    JSON.stringify([{ key: "ManagedBy", value: `qm-${options.label}` }]),
    "--query",
    "taskDefinition.taskDefinitionArn",
    "--output",
    "text",
  ]);
}

async function waitForOneOff(
  config: QmConfig,
  facts: CoreTaskFacts,
  options: OneOffOptions,
  taskArn: string,
): Promise<void> {
  const deadline = Date.now() + (options.timeoutMs ?? 30 * 60_000);
  for (;;) {
    if (Date.now() >= deadline) throw new Error(`${options.label} task ${taskArn} exceeded its deadline`);
    await new Promise((resolve) => setTimeout(resolve, Number(process.env.AWS_ONE_OFF_POLL_MS) || 10_000));
    const stopped = awsJson<{
      tasks?: Array<{
        lastStatus?: string;
        stoppedReason?: string;
        containers?: Array<{
          name?: string;
          exitCode?: number;
          reason?: string;
          logStreamName?: string;
        }>;
      }>;
      failures?: Array<{ arn?: string; reason?: string }>;
    }>(config, ["ecs", "describe-tasks", "--cluster", facts.cluster, "--tasks", taskArn]);
    const task = stopped.tasks?.[0];
    if (stopped.failures?.length || !task) throw new Error(`${options.label} task ${taskArn} disappeared`);
    if (task.lastStatus !== "STOPPED") continue;
    const container = task.containers?.find((entry) => entry.name === "core");
    if (container?.exitCode === 0) return;
    let tail = "";
    if (container?.logStreamName) {
      try {
        tail =
          awsJson<{ events?: Array<{ message?: string }> }>(config, [
            "logs",
            "get-log-events",
            "--log-group-name",
            facts.logGroup,
            "--log-stream-name",
            container.logStreamName,
            "--limit",
            "30",
          ])
            .events?.map((event) => event.message)
            .filter(Boolean)
            .join("\n") ?? "";
      } catch (error) {
        tail = `log tail unavailable: ${error instanceof Error ? error.message : String(error)}`;
      }
    }
    throw new Error(
      `${options.label} task failed (${container?.reason ?? task.stoppedReason ?? `exit ${container?.exitCode ?? "unknown"}`})${tail ? `\n${tail}` : ""}`,
    );
  }
}

export async function runCoreOneOff(config: QmConfig, facts: CoreTaskFacts, options: OneOffOptions): Promise<void> {
  const taskDefinition = registerOneOff(config, facts, options);
  try {
    const network = {
      awsvpcConfiguration: {
        subnets: facts.subnets,
        securityGroups: facts.securityGroups,
        assignPublicIp: facts.assignPublicIp,
      },
    };
    const started = awsJson<{
      tasks?: Array<{ taskArn?: string }>;
      failures?: Array<{ arn?: string; reason?: string; detail?: string }>;
    }>(config, [
      "ecs",
      "run-task",
      "--cluster",
      facts.cluster,
      "--task-definition",
      taskDefinition,
      "--launch-type",
      "FARGATE",
      ...(facts.platformVersion ? ["--platform-version", facts.platformVersion] : []),
      "--network-configuration",
      JSON.stringify(network),
      "--started-by",
      `qm-${options.label}`,
    ]);
    const taskArn = started.tasks?.[0]?.taskArn;
    if (!taskArn || started.failures?.length) {
      throw new Error(`could not start ${options.label} task: ${JSON.stringify(started.failures ?? [])}`);
    }
    await waitForOneOff(config, facts, options, taskArn);
  } finally {
    try {
      awsText(config, ["ecs", "deregister-task-definition", "--task-definition", taskDefinition]);
    } catch (error) {
      console.warn(
        `warning: could not deregister ${taskDefinition}: ${error instanceof Error ? error.message : error}`,
      );
    }
  }
}
