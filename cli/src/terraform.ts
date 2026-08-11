import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { awsWorkloadArchitecture, type QmConfig } from "./config.ts";
import { CliError, ok } from "./log.ts";
import { computedSecrets } from "./secrets.ts";
import { isServiceName, serviceDef } from "./services.ts";
import { canonicalJson } from "./util.ts";

const DERIVED_VARS = new Set([
  "org_id",
  "account_id",
  "region",
  "cluster_name",
  "public_url",
  "cloud_map_namespace",
  "secrets_prefix",
  "github_oidc_provider_arn",
  "github_environment",
  "object_store_bucket",
  "transfer_lifecycle_prefix",
  "deploy_microvm_image",
  "deploy_microvm_execution_role_arn",
  "services",
  "secret_names",
]);

const OPERATOR_DEFAULTS: Record<string, string> = {
  github_repository: "replace-me/repository",
  github_ref: "refs/heads/main",
  certificate_arn: "",
};

export function declaredVariables(variablesTf: string): string[] {
  return [...variablesTf.matchAll(/^\s*variable\s+"([^"]+)"/gm)].map((match) => match[1]!);
}

function hclAssignment(source: string, name: string): string | undefined {
  const match = source.match(new RegExp(`^[ \\t]*${name}\\s*=\\s*`, "m"));
  if (match?.index === undefined) return undefined;
  const valueStart = match.index + match[0].length;
  const open = source[valueStart];
  if (open !== "{" && open !== "[") {
    const lineEnd = source.indexOf("\n", valueStart);
    return source.slice(match.index, lineEnd === -1 ? source.length : lineEnd).trimEnd();
  }
  const close = open === "{" ? "}" : "]";
  let depth = 0;
  let inString = false;
  for (let i = valueStart; i < source.length; i++) {
    const char = source[i];
    if (inString) {
      if (char === "\\") i++;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') inString = true;
    else if (char === open) depth++;
    else if (char === close && --depth === 0) return source.slice(match.index, i + 1);
  }
  return undefined;
}

function hclString(source: string, name: string): string | undefined {
  const assignment = hclAssignment(source, name);
  const value = assignment?.match(/=\s*("(?:[^"\\]|\\.)*")\s*$/)?.[1];
  if (value === undefined) return undefined;
  try {
    return JSON.parse(value) as string;
  } catch {
    throw new CliError(`infra/terraform.tfvars has an invalid ${name} string`);
  }
}

function hclJson(source: string, name: string): unknown {
  const assignment = hclAssignment(source, name);
  const raw = assignment?.slice(assignment.indexOf("=") + 1).trim();
  try {
    return raw === undefined ? undefined : JSON.parse(raw);
  } catch {
    return undefined;
  }
}

function assertSafeAssumeRoleTransition(config: QmConfig, existing: string): void {
  if (!config.aws) return;
  const previous = hclJson(existing, "services");
  if (typeof previous !== "object" || previous === null || Array.isArray(previous)) return;
  for (const [name, prior] of Object.entries(previous)) {
    if (typeof prior !== "object" || prior === null || Array.isArray(prior)) continue;
    const next = config.aws.services[name];
    if (!next) continue;
    const managedArn = `arn:aws:iam::${config.aws.accountId}:role/${config.aws.cluster}-${name === "core" ? "core" : name}-task`;
    const priorRole = (prior as Record<string, unknown>)["task_role_arn"];
    const priorManaged = (prior as Record<string, unknown>)["manage_task_role"] === true;
    const currentRole = typeof priorRole === "string" ? priorRole : managedArn;
    const nextRole =
      next.taskRoleArn ??
      (name === "core" || next.assumeRoleArns?.length
        ? managedArn
        : `arn:aws:iam::${config.aws.accountId}:role/${config.aws.cluster}-task`);
    if (
      name !== "core" &&
      !priorManaged &&
      priorRole === managedArn &&
      !next.taskRoleArn &&
      Boolean(next.assumeRoleArns?.length)
    ) {
      throw new CliError(
        `aws.services.${name}.taskRoleArn cannot be removed because ${managedArn} is externally managed; keep the explicit ARN or import the role into Terraform first`,
      );
    }
    if (name !== "core" && priorManaged && nextRole !== managedArn) {
      throw new CliError(
        `aws.services.${name}.taskRoleArn cannot replace the Terraform-managed role ${managedArn}; keep that role for this workload`,
      );
    }
    const priorArns = (prior as Record<string, unknown>)["assume_role_arns"];
    if (!Array.isArray(priorArns) || priorArns.length === 0) continue;
    if (currentRole !== nextRole) {
      throw new CliError(
        `aws.services.${name}.taskRoleArn cannot change while its existing assumeRoleArns policy is active; first remove assumeRoleArns while keeping taskRoleArn set to ${currentRole}, apply and deploy, then change taskRoleArn in a later change`,
      );
    }
  }
}

function managedTaskRoles(existing: string): Set<string> {
  const services = hclJson(existing, "services");
  if (typeof services !== "object" || services === null || Array.isArray(services)) return new Set();
  return new Set(
    Object.entries(services)
      .filter(
        ([, service]) =>
          typeof service === "object" &&
          service !== null &&
          !Array.isArray(service) &&
          (service as Record<string, unknown>)["manage_task_role"] === true,
      )
      .map(([name]) => name),
  );
}

function derivedValues(
  config: QmConfig,
  declared: readonly string[],
  managedRoles = new Set<string>(),
): { strings: Record<string, string>; json: Record<string, unknown> } {
  if (!config.aws) throw new CliError("terraform rendering requires target aws and an aws block");
  const aws = config.aws;
  if (aws.deployEnvironment && !declared.includes("github_environment")) {
    throw new CliError(
      "the vendored AWS scaffold predates aws.deployEnvironment; update infra/variables.tf and infra/main.tf from the current scaffold before configuring it",
    );
  }
  const services = Object.fromEntries(
    Object.entries(aws.services).map(([name, service]) => {
      const manageTaskRole =
        name !== "core" &&
        (managedRoles.has(name) || (!service!.taskRoleArn && Boolean(service!.assumeRoleArns?.length)));
      return [
        name,
        {
          ecr_repository: service!.ecrRepository,
          ecs_service: service!.ecsService,
          cpu: service!.cpu,
          memory: service!.memory,
          architecture: awsWorkloadArchitecture(config, name),
          internal_port: isServiceName(name) ? serviceDef(name).docker.internalPort : 8080,
          ...(service!.taskRoleArn ? { task_role_arn: service!.taskRoleArn } : {}),
          ...(service!.executionRoleArn ? { execution_role_arn: service!.executionRoleArn } : {}),
          ...(service!.assumeRoleArns !== undefined ? { assume_role_arns: service!.assumeRoleArns } : {}),
          ...(manageTaskRole ? { manage_task_role: true } : {}),
        },
      ];
    }),
  );
  const secrets = computedSecrets(config);
  return {
    strings: {
      org_id: config.orgId,
      account_id: aws.accountId,
      region: aws.region,
      cluster_name: aws.cluster,
      public_url: config.publicUrl,
      cloud_map_namespace: aws.networking.cloudMapNamespace,
      secrets_prefix: aws.secretsPrefix,
      github_oidc_provider_arn: `arn:aws:iam::${aws.accountId}:oidc-provider/token.actions.githubusercontent.com`,
      ...(declared.includes("github_environment") ? { github_environment: aws.deployEnvironment ?? "" } : {}),
      object_store_bucket: awsObjectStoreBucket(config),
      transfer_lifecycle_prefix: `${config.env.core?.S3_PREFIX ?? ""}transfer/`,
      deploy_microvm_image: config.env.core!.AWS_DEPLOY_IMAGE!,
      deploy_microvm_execution_role_arn:
        config.env.core?.AWS_DEPLOY_EXEC_ROLE_ARN ?? `arn:aws:iam::${aws.accountId}:role/${aws.cluster}-microvm-exec`,
    },
    json: {
      services,
      secret_names: secrets.map((secret) => secret.name),
    },
  };
}

export function awsObjectStoreBucket(config: QmConfig): string {
  const aws = config.aws;
  if (!aws) throw new CliError("object-store naming requires target aws and an aws block");
  if (aws.objectStoreBucket) return aws.objectStoreBucket;
  const org = config.orgId.slice(0, 30).replace(/-+$/, "");
  const suffix = createHash("sha256")
    .update(`${aws.accountId}:${aws.region}:${aws.cluster}`)
    .digest("hex")
    .slice(0, 12);
  return `qm-${org}-${suffix}`;
}

export function terraformVars(
  config: QmConfig,
  existing = "",
  declared: string[] = [...Object.keys(OPERATOR_DEFAULTS), "github_environment"],
): string {
  assertSafeAssumeRoleTransition(config, existing);
  const { strings, json } = derivedValues(config, declared, managedTaskRoles(existing));
  const line = (name: string, value: string): string => `${name.padEnd(19)} = ${value}`;
  const lines = Object.entries(strings).map(([name, value]) => line(name, JSON.stringify(value)));
  for (const name of new Set([...Object.keys(OPERATOR_DEFAULTS), ...declared])) {
    if (DERIVED_VARS.has(name)) continue;
    const preserved = hclAssignment(existing, name);
    if (preserved !== undefined) lines.push(preserved);
    else if (OPERATOR_DEFAULTS[name] !== undefined) lines.push(line(name, JSON.stringify(OPERATOR_DEFAULTS[name])));
  }
  for (const [name, value] of Object.entries(json)) lines.push(line(name, JSON.stringify(value, null, 2)));
  lines.push("");
  return lines.join("\n");
}

export function terraformVarsDrift(
  config: QmConfig,
  existing: string,
  declared: string[] = ["github_environment"],
): string[] {
  const { strings, json } = derivedValues(config, declared, managedTaskRoles(existing));
  const drift: string[] = [];
  for (const [name, value] of Object.entries(strings)) {
    if (hclString(existing, name) !== value) drift.push(name);
  }
  for (const [name, value] of Object.entries(json)) {
    if (canonicalJson(hclJson(existing, name)) !== canonicalJson(value)) drift.push(name);
  }
  return drift;
}

function declaredInDir(configDir: string): string[] | undefined {
  const path = join(configDir, "infra", "variables.tf");
  return existsSync(path) ? declaredVariables(readFileSync(path, "utf8")) : undefined;
}

export function assertTerraformScaffoldSupportsConfig(config: QmConfig, configDir: string): void {
  if (!Object.values(config.aws?.services ?? {}).some((service) => service?.assumeRoleArns !== undefined)) return;
  const tfvarsPath = join(configDir, "infra", "terraform.tfvars");
  if (!existsSync(tfvarsPath)) return;
  const variablesPath = join(configDir, "infra", "variables.tf");
  const mainPath = join(configDir, "infra", "main.tf");
  const variables = existsSync(variablesPath) ? readFileSync(variablesPath, "utf8") : "";
  const main = existsSync(mainPath) ? readFileSync(mainPath, "utf8") : "";
  if (
    !/assume_role_arns\s*=\s*optional/.test(variables) ||
    !/manage_task_role\s*=\s*optional/.test(variables) ||
    !/qm_scaffold_version\s*=\s*3\b/.test(main)
  ) {
    throw new CliError(
      "the vendored AWS scaffold predates aws.services.*.assumeRoleArns; update infra/variables.tf and infra/main.tf from the current scaffold before configuring it",
    );
  }
}

export function renderTerraformVars(config: QmConfig, configDir: string): void {
  const path = join(configDir, "infra", "terraform.tfvars");
  if (!existsSync(path)) throw new CliError(`${path} does not exist; scaffold it with qm init --target aws`);
  assertTerraformScaffoldSupportsConfig(config, configDir);
  const existing = readFileSync(path, "utf8");
  const declared = declaredInDir(configDir);
  writeFileSync(path, terraformVars(config, existing, ...(declared ? [declared] : [])));
  ok("rendered infra/terraform.tfvars from the QM deployment config");
}
