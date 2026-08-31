import { createHash, randomUUID } from "node:crypto";
import { sendJson } from "../../http.ts";
import { audit, authorizeAdmin, orgScope } from "../shared.ts";
import type { ApiCtx } from "../route.ts";

const MAX_ATTESTED_EXECUTABLE_BYTES = 1024 * 1024;
const IMAGE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const IMAGE_VERSION = /^\S{1,128}$/;

function imageIdentifierMatches(configured: string, actual: string): boolean {
  if (configured.startsWith("arn:")) return configured === actual;
  if (!IMAGE_NAME.test(configured)) return false;
  const escaped = configured.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`^arn:aws(?:-[a-z]+)?:lambda:[a-z0-9-]+:[0-9]{12}:microvm-image(?::|/)${escaped}$`).test(actual);
}

export async function runtimeToolSelfCheck(ctx: ApiCtx): Promise<void> {
  const { deps, res } = ctx;
  const scope = orgScope(deps);
  const actor = await authorizeAdmin(ctx, scope);
  if (!actor) return;
  const toolId = ctx.params.tool ?? "";
  if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(toolId)) {
    return sendJson(res, 400, { error: "bad_request", message: "invalid deployment tool id" });
  }
  const descriptor = deps.deploymentLayer?.live().resolved?.tools.find((tool) => tool.id === toolId);
  if (!descriptor) {
    return sendJson(res, 409, { error: "runtime_probe_unavailable", message: "deployment tool is not active" });
  }
  if (descriptor.selfCheck?.kind !== "executable-sha256-v1") {
    return sendJson(res, 409, {
      error: "runtime_probe_unavailable",
      message: "deployment tool does not opt in to the executable digest self-check",
    });
  }
  const binary = descriptor.install?.binary ?? descriptor.id;
  if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(binary)) {
    return sendJson(res, 409, { error: "runtime_probe_unavailable", message: "deployment tool binary is unsafe" });
  }
  if (!deps.sandbox || deps.sandboxBackend !== "aws-microvm") {
    return sendJson(res, 409, { error: "runtime_probe_unavailable", message: "AWS MicroVM sandbox is required" });
  }
  if (typeof deps.sandbox.readInstalledExecutable !== "function") {
    return sendJson(res, 409, {
      error: "runtime_probe_unavailable",
      message: "sandbox does not support executable byte attestation",
    });
  }
  const configuredImageIdentifier = deps.sandboxImage?.identifier ?? "";
  const configuredImageVersion = deps.sandboxImage?.version ?? "";
  if (!configuredImageIdentifier || !IMAGE_VERSION.test(configuredImageVersion)) {
    return sendJson(res, 409, {
      error: "runtime_probe_unpinned",
      message: "AWS_SANDBOX_IMAGE and AWS_SANDBOX_IMAGE_VERSION must select an exact MicroVM image",
    });
  }

  let handle;
  try {
    handle = await deps.sandbox.provision([], {
      scratch: { key: `admin-tool-self-check-${randomUUID()}` },
      routeScopeId: scope,
      executionAuthority: "none",
    });
    if (
      handle.backend !== "aws" ||
      handle.executionAuthority !== "none" ||
      !handle.scratch ||
      handle.coldStart !== true
    ) {
      throw new Error("runtime self-check did not receive a fresh scratch MicroVM");
    }
    if (
      !handle.imageIdentifier ||
      !imageIdentifierMatches(configuredImageIdentifier, handle.imageIdentifier) ||
      handle.imageVersion !== configuredImageVersion
    ) {
      throw new Error("runtime self-check MicroVM image does not match the pinned image version");
    }
    const bytes = await deps.sandbox.readInstalledExecutable(handle, binary);
    if (!bytes?.length || bytes.byteLength > MAX_ATTESTED_EXECUTABLE_BYTES) {
      throw new Error("runtime self-check could not read a bounded installed executable");
    }
    const executableSha256 = createHash("sha256").update(bytes).digest("hex");
    audit(deps, {
      principalId: actor.id,
      action: "runtime.tool_self_check",
      resource: `tool:${toolId}:microvm:${handle.imageIdentifier}:${handle.imageVersion}`,
      scopeLabel: scope,
    });
    return sendJson(res, 200, {
      ok: true,
      tool: toolId,
      backend: handle.backend,
      imageIdentifier: handle.imageIdentifier,
      imageVersion: handle.imageVersion,
      configuredImageIdentifier,
      configuredImageVersion,
      microvmId: handle.id,
      fresh: true,
      attestation: "external-executable-sha256-v1",
      helperSha256: executableSha256,
    });
  } catch (error) {
    audit(deps, {
      principalId: actor.id,
      action: "runtime.tool_self_check_failed",
      resource: `tool:${toolId}:microvm:${configuredImageIdentifier}:${configuredImageVersion}`,
      scopeLabel: scope,
      status: "error",
      detail: error instanceof Error ? error.message : "runtime probe failed",
    });
    return sendJson(res, 502, {
      error: "runtime_probe_failed",
      message: error instanceof Error ? error.message : "runtime probe failed",
    });
  } finally {
    if (handle) await deps.sandbox.teardown(handle, { destroy: true }).catch(() => {});
  }
}
