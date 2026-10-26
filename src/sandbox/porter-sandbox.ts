import { randomUUID } from "node:crypto";
import { NotFoundError } from "porter-sandbox";
import type { WorkspaceStore } from "../workspace/workspace-store.ts";
import type { DurableMap } from "../persistence/durable-map.ts";
import { errMessage } from "../util/errors.ts";
import {
  createPorterClient,
  createPorterExec,
  ensurePorterVolume,
  listPorterSandboxes,
  porterPhaseSettled,
  porterSlug,
  retirePorterBody,
  waitPorterRunning,
  type PorterClientLike,
  type PorterSandboxLike,
} from "./porter-client.ts";
import {
  createProviderSandbox,
  scopeOfName,
  type ProviderSandbox,
  type SandboxShared,
  type StoredSandboxRecord,
} from "./provider-sandbox.ts";
import type { Sandbox } from "./sandbox.ts";

const HOME_DIR = "/root";
const IMAGE = "ghcr.io/porter-dev/qm-sandbox:latest";
const DEFAULT_MAX_LIFETIME_SEC = 28_800;
const EGRESS_TAG = "qm-egress";
const SCOPE_TAG = "qm-scope";
const KIND_TAG = "qm-kind";

export type StoredPorterSandbox = StoredSandboxRecord;

export interface PorterSandboxOptions extends SandboxShared {
  token?: string;
  baseUrl?: string;
  store: DurableMap<StoredPorterSandbox>;
  client?: PorterClientLike;
}

export function createPorterSandbox(workspace: WorkspaceStore, opts: PorterSandboxOptions): Sandbox {
  const prefix = opts.namePrefix ?? "qm";
  const scratchPrefix = `${prefix}-scratch-`;
  const egressProxyHost = opts.egressProxyUrl ? new URL(opts.egressProxyUrl).hostname : undefined;
  const ttlSec = opts.maxLifetimeSec ?? DEFAULT_MAX_LIFETIME_SEC;
  const client: PorterClientLike =
    opts.client ??
    createPorterClient({
      ...(opts.token ? { token: opts.token } : {}),
      ...(opts.baseUrl ? { baseUrl: opts.baseUrl } : {}),
    });

  const bodies = new Map<string, PorterSandboxLike>();

  const isScratch = (name: string): boolean => name.startsWith(scratchPrefix);

  async function slugFor(name: string): Promise<string> {
    if (isScratch(name)) return porterSlug(`${prefix}-scratch`, name);
    const scope = await scopeOfName(sandbox, opts.store, name);
    if (!scope) throw new Error(`porter sandbox ${name}: unknown scope`);
    return porterSlug(prefix, scope);
  }

  async function findBody(name: string): Promise<PorterSandboxLike | null> {
    const found = await listPorterSandboxes(client, { [SCOPE_TAG]: await slugFor(name) });
    const live =
      found.find((b) => b.phase === "running") ?? found.find((b) => b.phase === "creating" || b.phase === "queued");
    if (!live) return null;
    await waitPorterRunning((await live.refresh()).name, live);
    bodies.set(name, live);
    return live;
  }

  async function bodyId(name: string): Promise<string> {
    const body = bodies.get(name) ?? (await findBody(name));
    if (!body) throw new Error(`porter sandbox ${name} not found`);
    return body.id;
  }

  async function launch(name: string, volume?: { id: string }): Promise<void> {
    const slug = await slugFor(name);
    const bodyName = `${slug}-${randomUUID().slice(0, 5)}`;
    const sb = await client.sandboxes
      .create({
        image: IMAGE,
        name: bodyName,
        command: ["sleep", "infinity"],
        tags: {
          [SCOPE_TAG]: slug,
          [EGRESS_TAG]: egressProxyHost ? "proxy" : "open",
          [KIND_TAG]: volume ? "scope" : "scratch",
        },
        ...(volume ? { volume_mounts: { [HOME_DIR]: volume.id } } : {}),
        ...(egressProxyHost ? { egress: { allowed_destinations: [egressProxyHost] } } : {}),
        ttl_seconds: ttlSec,
      })
      .catch((e) => {
        if (errMessage(e).includes("egress restriction is not available")) {
          throw new Error(
            `porter sandbox ${bodyName}: SANDBOX_EGRESS_PROXY_URL is set but this cluster has egress restriction turned off, so Porter refuses to create the body at all — enable it on the cluster's sandbox-api system application or unset the proxy URL (docs/porter.md) (${errMessage(e)})`,
            { cause: e },
          );
        }
        throw e;
      });
    try {
      await waitPorterRunning(bodyName, sb);
    } catch (e) {
      await retirePorterBody(sb, false).catch(() => {});
      throw e;
    }
    bodies.set(name, sb);
  }

  async function retireAll(name: string): Promise<void> {
    bodies.delete(name);
    const found = await listPorterSandboxes(client, { [SCOPE_TAG]: await slugFor(name) });
    for (const b of found) if (!porterPhaseSettled(b.phase)) await retirePorterBody(b, !isScratch(name));
  }

  async function create(name: string, { scratch }: { scratch: boolean }): Promise<{ homeRetained: boolean }> {
    if (scratch) {
      await launch(name);
      return { homeRetained: false };
    }
    const volumeName = `${await slugFor(name)}-home`;
    const volume = await ensurePorterVolume(client, volumeName).catch((e) => {
      throw new Error(`porter volume ${volumeName}: ${errMessage(e)}`, { cause: e });
    });
    await launch(name, volume);
    return { homeRetained: !volume.created };
  }

  const exec = createPorterExec(client, bodyId);

  const sandbox: ProviderSandbox = createProviderSandbox(
    workspace,
    {
      backend: "porter",
      homeDir: HOME_DIR,
      os: "Debian 12 container on Porter Sandboxes — $HOME persists on a volume; paths outside $HOME reset when the sandbox rotates",
      tools: ["git", "curl", "wget", "jq", "unzip", "python3", "gh", "aws"],
      egressEnforcement: egressProxyHost ? "domain" : "none",
      exec: exec.execRaw,
      writeAbsBytes: exec.writeAbsBytes,
      readAbsBytes: exec.readAbsBytes,
      async inspect(name) {
        const body = await findBody(name);
        return body ? { state: "running", detail: `porter sandbox ${body.id} running` } : null;
      },
      create,
      async resume() {},
      async destroy(name) {
        await retireAll(name);
        if (isScratch(name)) return;
        await client.volumes.delete(`${await slugFor(name)}-home`).catch((e) => {
          if (!(e instanceof NotFoundError)) throw e;
        });
      },
      isLive: () => false,
      forget: (name) => bodies.delete(name),
      async restart(name) {
        await retireAll(name);
        await create(name, { scratch: false });
      },
      ...(egressProxyHost
        ? {
            async ensureEgress(name: string) {
              const body = bodies.get(name) ?? (await findBody(name));
              if (body?.tags?.[EGRESS_TAG] === "proxy") return;
              await retireAll(name);
              if (isScratch(name)) await launch(name);
              else await create(name, { scratch: false });
            },
          }
        : {}),
    },
    opts,
    opts.store,
  );
  return sandbox;
}
