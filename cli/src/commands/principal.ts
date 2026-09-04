import { CliError, note, ok } from "../log.ts";
import type { QmConfig } from "../config.ts";
import type { DeploymentLayerTransport } from "../deployment-layer.ts";

export interface PrincipalStatus {
  principalId: string;
  active: boolean;
  source?: "manual" | "directory-sync";
}

async function request(
  config: QmConfig,
  configDir: string,
  transport: DeploymentLayerTransport,
  id: string,
  action: "status" | "reactivate",
  envFile?: string,
): Promise<PrincipalStatus> {
  const response = await transport({
    config,
    configDir,
    method: action === "status" ? "GET" : "POST",
    path: `/v1/principals/${encodeURIComponent(id)}/${action}`,
    body: "",
    ...(envFile ? { envFile } : {}),
  });
  let parsed: unknown;
  try {
    parsed = JSON.parse(response.body);
  } catch {
    throw new CliError(`core returned an invalid principal ${action} response`);
  }
  if (response.status < 200 || response.status >= 300) {
    const message =
      parsed && typeof parsed === "object" && typeof (parsed as { message?: unknown }).message === "string"
        ? (parsed as { message: string }).message
        : `HTTP ${response.status}`;
    throw new CliError(`principal ${action} failed: ${message}`);
  }
  return parsed as PrincipalStatus;
}

export async function principalStatus(
  config: QmConfig,
  configDir: string,
  transport: DeploymentLayerTransport,
  id: string,
  envFile?: string,
): Promise<PrincipalStatus> {
  const status = await request(config, configDir, transport, id, "status", envFile);
  note(
    status.active
      ? `${status.principalId}: active`
      : `${status.principalId}: deactivated${status.source ? ` (${status.source})` : ""}`,
  );
  return status;
}

export async function reactivatePrincipal(
  config: QmConfig,
  configDir: string,
  transport: DeploymentLayerTransport,
  id: string,
  envFile?: string,
): Promise<PrincipalStatus> {
  const status = await request(config, configDir, transport, id, "reactivate", envFile);
  ok(`${status.principalId}: reactivated`);
  return status;
}
