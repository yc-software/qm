import { existsSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { assertNodeEngine, emailTransportPreflight, flySandboxTokenPreflight } from "../preflight.ts";
import { readEnvFile } from "../util.ts";
import { CliError, errMessage, header, note, ok, step, warn } from "../log.ts";
import { validateSandboxLayer, type SandboxValidation } from "../sandbox-layer.ts";
import { discoverPlugins, type ResolvedPlugin } from "../plugins.ts";
import { mockHarnessWarning, sandboxPinPending, type QmConfig } from "../config.ts";
import { computedSecrets, runtimeSecretNames, type ComputedSecret } from "../secrets.ts";
import { isVirtualService, runnableServices } from "../services.ts";
import { serviceEnvironment } from "../backends/aws.ts";
import { hostingProvider } from "../backends/registry.ts";

export interface ChecksResult {
  layer: SandboxValidation;
  plugins: ResolvedPlugin[];
  secrets: ComputedSecret[];
}

export function runChecks(
  config: QmConfig,
  configDir: string,
  sandboxDir: string,
  opts: { report?: boolean } = {},
): ChecksResult {
  const report = opts.report ?? true;
  const layer = validateSandboxLayer(sandboxDir);
  const { plugins, errors: pluginErrors } = discoverPlugins(configDir, config);
  const configErrors: Array<{ clause: string; message: string }> = [];
  const configError = (message: string, clause = "config.v1"): void => void configErrors.push({ clause, message });
  const provider = hostingProvider(config.target);
  configErrors.push(...provider.validateConfig(config, plugins));
  if (provider.requiresSandboxApp && !config.sandbox?.app?.trim()) {
    configError("contract sandbox.app: a Fly agent-computer app is required for docker and fly targets");
  }
  for (const skill of config.skills) {
    const path = resolve(configDir, skill);
    let isDirectory: boolean;
    try {
      isDirectory = existsSync(path) && statSync(path).isDirectory();
    } catch (e) {
      configError(`contract config.skills: ${JSON.stringify(skill)} is not readable: ${errMessage(e)}`);
      continue;
    }
    if (!isDirectory) configError(`contract config.skills: ${JSON.stringify(skill)} does not resolve to a directory`);
  }
  const secrets = computedSecrets(config);
  const secretNames = new Set(
    secrets.flatMap((secret) => [secret.name, ...(secret.aliases ?? []).map((alias) => alias.name)]),
  );
  const pluginNames = plugins.map((plugin) => plugin.name);
  for (const workload of [...runnableServices(config.services), ...pluginNames]) {
    const delivered = new Map<string, string>();
    for (const secret of secrets) {
      for (const name of runtimeSecretNames(workload, secret, pluginNames)) {
        const prior = delivered.get(name);
        if (prior !== undefined && prior !== secret.name) {
          configError(
            `contract config.secretEnv: ${workload} would receive env ${name} from both ${prior} and ${secret.name}`,
            "config.secretEnv",
          );
        }
        delivered.set(name, secret.name);
      }
    }
  }
  if (config.target === "aws" && config.aws) {
    for (const workload of runnableServices(config.services)) {
      if (!config.aws.services[workload]) continue;
      const configured = new Set(Object.keys(config.env[workload] ?? {}));
      if (workload === "core") {
        for (const service of config.services.filter(isVirtualService)) {
          for (const name of Object.keys(config.env[service] ?? {})) configured.add(name);
        }
      }
      let rendered: string[];
      try {
        rendered = Object.keys(serviceEnvironment(config, workload));
      } catch {
        continue;
      }
      const managed = new Set(rendered.filter((name) => !configured.has(name)));
      for (const secret of secrets) {
        for (const name of runtimeSecretNames(workload, secret, pluginNames)) {
          if (managed.has(name)) {
            configError(
              `contract config.secretEnv: ${workload} env ${name} is derived by the deployment target and cannot also be delivered as a secret`,
              "config.secretEnv",
            );
          }
        }
      }
    }
  }
  const flagSecretValue = (owner: string, env: Record<string, string> | undefined): void => {
    for (const [name, value] of Object.entries(env ?? {})) {
      const secretish =
        secretNames.has(name) ||
        (/(?:_SECRET|_TOKEN|_KEY|_CREDENTIALS?|PASSWORD)$/.test(name) &&
          !name.endsWith("PUBLIC_KEY") &&
          !/^[.~/]/.test(value));
      if (secretish) {
        configError(
          `contract config.no-secret-values: ${owner}.${name} belongs in the target secret store, not config env`,
          "config.no-secret-values",
        );
      }
    }
  };
  for (const [service, env] of Object.entries(config.env)) flagSecretValue(service, env);
  for (const plugin of config.plugins) flagSecretValue(`plugins.${plugin.name}`, plugin.env);
  flagSecretValue("sandbox", config.sandbox?.env);
  for (const [service, spec] of Object.entries(config.aws?.services ?? {})) {
    flagSecretValue(`aws.services.${service}.buildArgs`, spec.buildArgs);
  }

  if (report) {
    const rel = relative(configDir, sandboxDir) || ".";
    if (!layer.exists) {
      step(`sandbox: none (no ${rel}/ directory)`);
    } else {
      step(`sandbox: ${rel}/`);
      const toolDesc = layer.tools
        .map((t) => {
          let source = "?";
          if (t.executablePath) source = "executable";
          else if (layer.hasDockerfile) source = "Dockerfile";
          return `${t.descriptor.id} (${source})`;
        })
        .join(", ");
      note(`     tools : ${toolDesc || "(none)"}`);
      note(`     skills: ${layer.skills.map((s) => s.frontmatter.name).join(", ") || "(none)"}`);
      note(`     Dockerfile: ${layer.hasDockerfile ? "yes" : "no"}`);
    }
    const pluginDesc = plugins.map((p) => `${p.name} (${p.kind})`).join(", ");
    step(`plugins: ${pluginDesc || "(none)"}`);
    step(
      `required secrets: ${
        secrets
          .filter((secret) => secret.required)
          .map((secret) => secret.name)
          .join(", ") || "(none)"
      }`,
    );
    const optional = secrets.filter((secret) => !secret.required).map((secret) => secret.name);
    if (optional.length) step(`optional secrets: ${optional.join(", ")}`);
    for (const w of layer.warnings) warn(w);
    const mockHarness = mockHarnessWarning(config);
    if (mockHarness) warn(mockHarness);
    if (sandboxPinPending(config)) {
      warn("no sandbox layer image is pinned yet; run `qm sandbox publish` to record one before `qm up` renders core");
    }
  }

  const errors = [
    ...configErrors,
    ...layer.errors.map((message) => ({ clause: "sandbox.descriptors", message })),
    ...pluginErrors.map((message) => ({ clause: "plugins.resolved", message })),
  ];
  if (errors.length) {
    throw new CliError(
      `check failed (${errors.length} problem${errors.length === 1 ? "" : "s"}):\n` +
        errors.map((e) => `  - ${e.message}`).join("\n"),
      { clause: errors[0]!.clause, problems: errors },
    );
  }
  return { layer, plugins, secrets };
}

export async function runCheckCommand(
  config: QmConfig,
  configDir: string,
  sandboxDir: string,
  envFile?: string,
): Promise<void> {
  header(`qm check — ${config.orgId}`);
  assertNodeEngine(configDir);
  runChecks(config, configDir, sandboxDir, { report: true });
  const secrets = readEnvFile(envFile ?? join(configDir, ".env"));
  await flySandboxTokenPreflight(config, secrets);
  await emailTransportPreflight(config, secrets);
  note("");
  ok("check passed — config, sandbox layer, and plugins are valid.");
}
