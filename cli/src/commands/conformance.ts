import { createHash } from "node:crypto";
import { type Target, type QmConfig } from "../config.ts";
import { deploymentLayerBundle, deploymentLayerRequest, type DeploymentLayerBundle } from "../deployment-layer.ts";
import { CliError, errMessage, header, ok, step } from "../log.ts";
import { parseToolDescriptor, type ToolDescriptor } from "../sandbox-layer.ts";
import { canonicalJson } from "../util.ts";
import { runChecks } from "./check.ts";
import { hostingProvider } from "../backends/registry.ts";

export function expectedDescriptors(bundle: DeploymentLayerBundle): ToolDescriptor[] {
  return bundle.tools.map((file) => parseToolDescriptor(file.content, file.path));
}

export interface ConformanceDeployment {
  config: QmConfig;
  configDir: string;
  sandboxDir: string;
  target: Target;
  envFile?: string;
}

export async function runConformance(
  deployment: ConformanceDeployment,
  opts: { runtime?: boolean } = {},
): Promise<void> {
  const { config, configDir, sandboxDir, target, envFile } = deployment;
  header(`qm conformance — ${config.orgId}`);
  const checked = runChecks(config, configDir, sandboxDir, { report: false });
  step("config.v1: pass");
  step(`sandbox.descriptors: pass (${checked.layer.tools.length} tools, ${checked.layer.skills.length} skills)`);
  step("secrets.computed-set: pass");
  if (opts.runtime === false) {
    ok("static conformance passed");
    return;
  }
  let response: { status: number; body: string };
  try {
    response = await deploymentLayerRequest({
      config,
      configDir,
      transport: hostingProvider(target).deploymentLayerTransport,
      method: "GET",
      ...(envFile ? { envFile } : {}),
    });
  } catch (error) {
    throw new CliError(`runtime.layer-resolved: ${errMessage(error)}`);
  }
  if (response.status < 200 || response.status >= 300)
    throw new CliError(`runtime.layer-resolved: GET failed (${response.status}): ${response.body}`);
  let live: {
    contentHash?: string | null;
    status?: string;
    runtimeContentHash?: string | null;
    resolved?: { tools?: unknown[] } | null;
  };
  try {
    live = JSON.parse(response.body) as typeof live;
  } catch {
    throw new CliError("runtime.layer-resolved: deployment layer read returned unparseable JSON");
  }
  const bundle = deploymentLayerBundle(sandboxDir);
  const expectedHash = createHash("sha256").update(JSON.stringify(bundle)).digest("hex");
  if (live.contentHash !== expectedHash) {
    throw new CliError(
      "runtime.layer-resolved: live content hash differs from the directory's complete tools and skills layer",
    );
  }
  if (
    live.status === "degraded" ||
    (live.runtimeContentHash !== undefined && live.runtimeContentHash !== expectedHash)
  ) {
    throw new CliError(
      "runtime.layer-resolved: the core stores the directory's layer but is still serving a previous resolved layer",
    );
  }
  if (canonicalJson(live.resolved?.tools ?? []) !== canonicalJson(expectedDescriptors(bundle))) {
    throw new CliError("runtime.layer-resolved: live descriptors differ from sandbox/tools");
  }
  step("runtime.layer-resolved: pass");
  ok("deployment directory conforms to contract v1");
}
