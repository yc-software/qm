import { Freestyle, FreestyleApiError, type Vm } from "freestyle";
import { dirname } from "node:path/posix";
import type { WorkspaceStore } from "../workspace/workspace-store.ts";
import type { LayerInstallFile } from "../deployment/load-layer.ts";
import { ephemeralCredLinkPaths, type CredentialPathSpec } from "../credentials/resident-paths.ts";
import type { AdvisoryLock } from "../persistence/advisory-lock.ts";
import { createNoopAdvisoryLock } from "../persistence/advisory-lock.ts";
import { errMessage } from "../util/errors.ts";
import { shq } from "../util/shell.ts";
import { createExecSandboxBase, sandboxScopeName } from "./exec-sandbox-base.ts";
import { createExecFileOps, createExecExport } from "./exec-file-ops.ts";
import { createExecProcessSessions } from "./exec-process-session.ts";
import { createLayerToolInstaller, type LayerToolInstaller } from "./layer-tool-install.ts";
import { AWS_CLI_SHA256, AWS_CLI_VERSION } from "./aws-cli-v2.ts";
import {
  execFailureDetail,
  visibleNotInstalled,
  visibleTools,
  type ComputerStatus,
  type ExecResult,
  type Sandbox,
} from "./sandbox.ts";

const HOME_DIR = "/home/ubuntu";
const DEFAULT_SNAPSHOT = "freestyle/ubuntu";
const AWS_CLI_BIN = "/usr/local/aws-cli/v2/current/bin/aws";
const AWS_CLI_SETUP = `set -eu
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
case "$(uname -m)" in
  x86_64) sha=${AWS_CLI_SHA256.x86_64} ;;
  aarch64) sha=${AWS_CLI_SHA256.aarch64} ;;
  *) exit 1 ;;
esac
curl --max-time 120 -fsSL -o "$tmp/awscliv2.zip" "https://awscli.amazonaws.com/awscli-exe-linux-$(uname -m)-${AWS_CLI_VERSION}.zip"
printf '%s  %s\\n' "$sha" "$tmp/awscliv2.zip" | sha256sum -c -
unzip -q "$tmp/awscliv2.zip" -d "$tmp"
if [ -d /usr/local/aws-cli ]; then
  "$tmp/aws/install" --bin-dir /usr/local/lib/qm-aws-cli/bin --install-dir /usr/local/aws-cli --update
else
  "$tmp/aws/install" --bin-dir /usr/local/lib/qm-aws-cli/bin --install-dir /usr/local/aws-cli
fi`;
const AWS_CLI_WRAPPER = `#!/bin/sh
set -eu
bin=${shq(AWS_CLI_BIN)}
if [ ! -x "$bin" ]; then
  mkdir -p "$HOME/.qm"
  exec 9>"$HOME/.qm/aws-cli-v2.lock"
  flock -w 300 9
  if [ ! -x "$bin" ]; then
    output=$(sudo sh -c ${shq(AWS_CLI_SETUP)} 2>&1) || { rc=$?; printf '%s\\n' "$output" >&2; exit "$rc"; }
    version=$("$bin" --version 2>&1) || { rc=$?; printf '%s\\n' "$version" >&2; exit "$rc"; }
    case "$version" in aws-cli/2.*) ;; *) printf 'expected AWS CLI v2, got: %s\\n' "$version" >&2; exit 1 ;; esac
  fi
fi
exec "$bin" "$@"
`;

export interface FreestyleSandboxOptions {
  apiKey?: string;
  snapshotId?: string;
  namePrefix?: string;
  defaultTimeoutSec?: number;
  extraTools?: string[];
  credentialPaths?: CredentialPathSpec[];
  layerToolFiles?: () => readonly LayerInstallFile[];
  advisoryLock?: AdvisoryLock;
  client?: Pick<Freestyle, "vms">;
  onError?: (e: { category: string; code: string; message: string; scopeLabel?: string }) => void;
}

export function createFreestyleSandbox(workspace: WorkspaceStore, opts: FreestyleSandboxOptions = {}): Sandbox {
  if (!opts.apiKey && !opts.client) throw new Error("SANDBOX_BACKEND=freestyle requires FREESTYLE_API_KEY");
  const client = opts.client ?? new Freestyle({ apiKey: opts.apiKey });
  const prefix =
    (opts.namePrefix ?? "qm")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "") || "qm";
  const scopeName = (namePrefix: string, id: string): string => sandboxScopeName(namePrefix, id).replace(/-+/g, "-");
  const snapshotId = opts.snapshotId ?? DEFAULT_SNAPSHOT;
  const advisoryLock = opts.advisoryLock ?? createNoopAdvisoryLock();
  const layerToolFiles = opts.layerToolFiles;

  const installLayerTools: LayerToolInstaller = async (io) => {
    await createLayerToolInstaller(() => [
      ...(layerToolFiles?.() ?? []),
      { to: "/usr/local/bin/aws", mode: "755", content: AWS_CLI_WRAPPER },
    ])({
      exec: (script, timeoutSec) => io.exec(`sudo sh -c ${shq(script)}`, timeoutSec),
      writeAbs: io.writeAbs,
    });
  };

  const missing = (error: unknown): boolean => error instanceof FreestyleApiError && error.code === "NOT_FOUND";

  async function find(name: string): Promise<Awaited<ReturnType<Vm["data"]>> | null> {
    try {
      return await client.vms.get(name);
    } catch (error) {
      if (missing(error)) return null;
      throw error;
    }
  }

  async function deleteVm(name: string): Promise<void> {
    try {
      await client.vms.delete(name);
    } catch (error) {
      if (!missing(error)) throw error;
    }
  }

  async function createVm(name: string, scratch: boolean): Promise<void> {
    await client.vms.create({
      slug: name,
      snapshotId,
      idleTimeoutSeconds: -1,
      ...(scratch ? { ttlSeconds: 24 * 60 * 60 } : {}),
      firewall: { rules: [{ action: "allow", source: {}, destination: { public: true } }] },
    });
  }

  async function ensureResident(name: string): Promise<{ coldStart: boolean }> {
    return advisoryLock.withLock(`freestyle-provision:${name}`, async () => {
      const found = await find(name);
      if (!found) {
        await createVm(name, false);
        return { coldStart: true };
      }
      if (found.state !== "running") await client.vms.ref(name).start();
      return { coldStart: found.state !== "running" };
    });
  }

  async function exec(name: string, command: string, timeoutSec: number): Promise<ExecResult> {
    const result = await client.vms.ref(name).exec({ command, timeoutMs: timeoutSec * 1000 });
    return {
      stdout: result.stdout ?? "",
      stderr: result.stderr ?? "",
      code: result.statusCode ?? 124,
      timedOut: result.statusCode == null,
    };
  }

  async function writeAbsBytes(name: string, path: string, data: Uint8Array): Promise<void> {
    const vm = client.vms.ref(name);
    const mkdir = `mkdir -p ${shq(dirname(path))}`;
    let parent = await exec(name, mkdir, 30);
    if (parent.code !== 0) {
      const root = await vm.linuxUser("root").exec({ command: mkdir, timeoutMs: 30_000 });
      parent = {
        stdout: root.stdout ?? "",
        stderr: root.stderr ?? "",
        code: root.statusCode ?? 124,
        timedOut: root.statusCode == null,
      };
    }
    if (parent.code !== 0) throw new Error(`freestyle write ${path}: ${parent.stderr || "mkdir failed"}`);
    await vm.fs.writeFile(path, data);
    const ownership = await vm.linuxUser("root").exec({ command: `chown 1000:1000 ${shq(path)}` });
    if (ownership.statusCode !== 0) throw new Error(`freestyle write ${path}: ${ownership.stderr ?? "chown failed"}`);
  }

  async function readAbsBytes(name: string, path: string): Promise<Uint8Array | null> {
    try {
      return await client.vms.ref(name).fs.readFile(path);
    } catch (error) {
      if (missing(error)) return null;
      throw error;
    }
  }

  const base = createExecSandboxBase({
    workspace,
    label: "freestyle",
    prefix,
    scopeName,
    homeDir: HOME_DIR,
    defaultTimeoutSec: opts.defaultTimeoutSec ?? 300,
    credentialPaths: opts.credentialPaths ?? [],
    installLayerTools,
    deleteFailureCode: "freestyle_delete_failed",
    onError: opts.onError,
    exec,
    writeAbsBytes,
    readAbsBytes,
    ensureResident,
    isProvisioned: () => false,
    recreateScratch: async (name) => {
      await advisoryLock.withLock(`freestyle-provision:${name}`, async () => {
        await deleteVm(name);
        await createVm(name, true);
      });
    },
    deleteInstance: deleteVm,
  });

  const processSessions = createExecProcessSessions({
    run: (handle, command, options) => exec(handle.id, command, Math.ceil((options?.timeoutMs ?? 300_000) / 1000)),
  });
  const fileOps = createExecFileOps({ label: "freestyle", exec, writeInline: writeAbsBytes });
  const exportFiles = createExecExport({
    label: "freestyle",
    exec,
    readAbsBytes,
    defaultHomeDir: HOME_DIR,
    ephemeralCredentialPrefixes: ephemeralCredLinkPaths(opts.credentialPaths ?? []).map(({ rel }) => rel),
  });

  return {
    profile: {
      backend: "freestyle",
      writablePersistence: "resident_disk",
      processSessions: true,
      egressEnforcement: "none",
      spec: {
        os: `Freestyle Ubuntu VM booted from ${snapshotId}; persistent disk and memory across pause and resume`,
        runtimes: ["Node", "Python 3"],
        get tools() {
          return visibleTools([
            "git",
            "curl",
            "tar",
            "python3",
            "node",
            "bun",
            "docker",
            "aws (CLI v2)",
            ...(opts.extraTools ?? []),
          ]);
        },
        get notInstalled() {
          return visibleNotInstalled(["gcloud", "kubectl", "flyctl", "glab", "gh"], opts.extraTools ?? []);
        },
        homeDir: HOME_DIR,
        workdir: base.workspaceDir,
      },
    },
    ...processSessions,
    ...fileOps,
    ...base,
    exportFiles: exportFiles.exportFiles,
    async computerStatus(scopeId: string): Promise<ComputerStatus> {
      const name = scopeName(prefix, scopeId);
      let found: Awaited<ReturnType<Vm["data"]>> | null;
      try {
        found = await find(name);
      } catch (error) {
        return { machine: `lookup failed: ${errMessage(error)}`, guestResponsive: false };
      }
      if (!found) return { machine: "no VM provisioned yet", provisioned: false, guestResponsive: false };
      if (found.state !== "running") {
        return {
          machine: `VM ${found.id} ${found.state}`,
          listed: found.state,
          lifecycleState: "paused",
          provisioned: true,
          guestResponsive: false,
        };
      }
      try {
        const probe = await exec(name, "true", 10);
        return {
          machine: `VM ${found.id} running`,
          listed: found.state,
          lifecycleState: "running",
          provisioned: true,
          guestResponsive: probe.code === 0,
          ...(probe.code === 0 ? {} : { probeError: `exit ${probe.code}: ${execFailureDetail(probe, 10)}` }),
        };
      } catch (error) {
        return {
          machine: `VM ${found.id} running`,
          listed: found.state,
          lifecycleState: "running",
          provisioned: true,
          guestResponsive: false,
          probeError: errMessage(error),
        };
      }
    },
    async destroyScope(scopeId: string): Promise<void> {
      const name = scopeName(prefix, scopeId);
      await advisoryLock.withLock(`freestyle-provision:${name}`, () => deleteVm(name));
    },
  };
}
