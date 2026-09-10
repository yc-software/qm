import type { DurableMap } from "../persistence/durable-map.ts";
import type { AdvisoryLock } from "../persistence/advisory-lock.ts";
import { sleep } from "../util/async.ts";
import { swallowAs } from "../util/errors.ts";
import { shq } from "../util/shell.ts";
import { copyHome, packHome, translateScript, type CopyHomeResult } from "./sandbox-migrate.ts";
import type { SandboxBackendName, SandboxRoute } from "./sandbox-routing.ts";
import {
  capabilitiesLostMovingTo,
  supportsBlobStaging,
  type ProvisionOptions,
  type Sandbox,
  type SandboxHandle,
} from "./sandbox.ts";
import type { WorkspaceLayer } from "../types.ts";

export interface SandboxMigrationOptions {
  backends: Partial<Record<SandboxBackendName, Sandbox>>;
  routes: DurableMap<SandboxRoute>;
  defaultBackend: SandboxBackendName;
  advisoryLock?: AdvisoryLock;
  provisionOptions?: (scopeId: string) => Promise<ProvisionOptions>;
  settleMs?: number;
  withLegacyMutation?: <T>(scopeId: string, action: () => Promise<T>) => Promise<T>;
  hasLiveWork?: (scopeId: string) => Promise<boolean>;
}

interface MigrateScopeResult extends CopyHomeResult {
  scopeId: string;
  from: SandboxBackendName;
  to: SandboxBackendName;
  resynced: boolean;
  capabilitiesLost: string[];
}

interface MigrateScopeOptions {
  force?: boolean;
  copyTimeoutSec?: number;
  strategy?: "copy" | "snapshot";
  resumeBlobId?: string;
}

export interface SandboxMigrationRunner {
  migrateScope(
    scopeId: string,
    to: SandboxBackendName,
    reason?: string,
    opts?: MigrateScopeOptions,
  ): Promise<MigrateScopeResult>;
  listRoutes(): Promise<Array<[string, SandboxRoute]>>;
  availableBackends(): SandboxBackendName[];
  defaultBackend: SandboxBackendName;
}

const scopeLayers = (scopeId: string): WorkspaceLayer[] => [
  { scopeId: scopeId as WorkspaceLayer["scopeId"], mountPath: "/", mode: "rw" },
];

export function createSandboxMigrationRunner(opts: SandboxMigrationOptions): SandboxMigrationRunner {
  const { backends, routes, defaultBackend } = opts;

  async function migrate(
    scopeId: string,
    to: SandboxBackendName,
    reason?: string,
    migrateOpts?: MigrateScopeOptions,
  ): Promise<MigrateScopeResult> {
    const toSandbox = backends[to];
    if (!toSandbox) throw new Error(`cannot migrate to ${to}: that backend is not constructed on this deployment`);
    const route = await routes.get(scopeId);
    const from = route?.backend ?? defaultBackend;
    if (from === to) throw new Error(`scope is already on ${to}`);
    const fromSandbox = backends[from];
    if (!fromSandbox) throw new Error(`scope lives on ${from}, which is not constructed on this deployment`);
    if (route?.pinned)
      throw new Error(`scope is pinned to ${from}${route.reason ? ` (${route.reason})` : ""}; unpin before migrating`);
    if (opts.hasLiveWork && (await opts.hasLiveWork(scopeId))) {
      throw new Error("scope has live background work; wait for it to finish or stop it before migrating");
    }
    const capabilitiesLost = capabilitiesLostMovingTo(fromSandbox, toSandbox);
    if (capabilitiesLost.length && !migrateOpts?.force) {
      throw new Error(
        `cannot migrate to ${to}: it has no ${capabilitiesLost.join(", no ")}, which the scope has on ${from} today. ` +
          `Migrate with force to accept the loss.`,
      );
    }
    if (migrateOpts?.strategy === "snapshot") {
      if (!supportsBlobStaging(fromSandbox))
        throw new Error(`snapshot migration needs blob staging on ${from}, which is not wired`);
      if (!toSandbox.adoptHomeSnapshot)
        throw new Error(`snapshot migration needs ${to} to support adopting home snapshots`);
    }
    const provOpts = (await opts.provisionOptions?.(scopeId)) ?? {};
    const fromHandle = await fromSandbox.provision(scopeLayers(scopeId), provOpts);
    const fromHome = fromHandle.homeDir ?? fromSandbox.profile.spec?.homeDir ?? "/root";
    const timeoutMs = (migrateOpts?.copyTimeoutSec ?? 900) * 1000;
    const startedAtIso = new Date().toISOString();

    const snapshotPass = async (resumeBlobId?: string): Promise<CopyHomeResult> => {
      let blobId: string;
      let manifest = { bytes: 0, sha: "resumed", sourceFiles: 0 };
      if (resumeBlobId) {
        blobId = resumeBlobId;
      } else {
        const packed = await packHome(fromSandbox, fromHandle, fromHome, timeoutMs);
        manifest = { bytes: packed.bytes, sha: packed.sha, sourceFiles: packed.sourceFiles };
        try {
          blobId = await (fromSandbox as Sandbox & Required<Pick<Sandbox, "stageOut">>).stageOut(
            fromHandle,
            packed.tarRel,
            { timeoutSec: timeoutMs / 1000 },
          );
        } finally {
          await fromSandbox.run(fromHandle, `rm -f ${shq(packed.tarPath)}`, { timeoutMs: 30_000 }).catch(() => {});
        }
      }
      await toSandbox.adoptHomeSnapshot!(scopeId, blobId);
      const toHandle = await toSandbox.provision(scopeLayers(scopeId), provOpts);
      const toHome = toHandle.homeDir ?? toSandbox.profile.spec?.homeDir ?? "/root";
      let verified = false;
      try {
        if (toHandle.coldStart) {
          throw new Error("snapshot migration: the target provisioned cold — the adopted snapshot never hydrated");
        }
        const counted = await toSandbox.run(toHandle, `find ${shq(toHome)} -type f | wc -l`, { timeoutMs });
        const destFiles = Number.parseInt(counted.stdout.trim(), 10);
        if (counted.code !== 0 || !Number.isFinite(destFiles) || destFiles < Math.max(1, manifest.sourceFiles)) {
          throw new Error(
            `snapshot migration: hydrated home has ${counted.stdout.trim().slice(0, 40)} files, expected at least ${Math.max(1, manifest.sourceFiles)}`,
          );
        }
        if (fromHome !== toHome) {
          const t = await toSandbox.run(toHandle, translateScript(toHome, fromHome), { timeoutMs });
          if (t.code !== 0)
            throw new Error(
              `snapshot migration: translation failed (${t.code}): ${(t.stderr || t.stdout).slice(0, 200)}`,
            );
        }
        await toSandbox.persistHomeSnapshot?.(scopeId);
        verified = true;
        return { bytes: manifest.bytes, sha: manifest.sha, sourceFiles: manifest.sourceFiles, destFiles };
      } finally {
        if (verified) {
          await toSandbox.teardown(toHandle);
        } else {
          await toSandbox
            .teardown(toHandle, { destroy: true })
            .catch(swallowAs("sandbox-migration: destroy unverified target", undefined));
        }
      }
    };

    if (migrateOpts?.strategy === "snapshot") {
      let copied = await snapshotPass(migrateOpts.resumeBlobId);
      let resynced = false;
      const changed = migrateOpts.resumeBlobId
        ? { stdout: "" }
        : await fromSandbox.run(
            fromHandle,
            `find ${shq(fromHome)} -type f -newermt ${shq(startedAtIso)} 2>/dev/null | head -1`,
            { timeoutMs: 60_000 },
          );
      if (changed.stdout.trim() !== "") {
        copied = await snapshotPass();
        resynced = true;
      }
      await routes.put(scopeId, {
        backend: to,
        migratedAt: new Date().toISOString(),
        migrationSha: copied.sha,
        ...(reason ? { reason } : {}),
        ...(capabilitiesLost.length ? { capabilitiesLost } : {}),
      });
      await park(fromSandbox, fromHandle);
      return { scopeId, from, to, resynced, capabilitiesLost, ...copied };
    }

    const toHandle = await toSandbox.provision(scopeLayers(scopeId), provOpts);
    const toHome = toHandle.homeDir ?? toSandbox.profile.spec?.homeDir ?? "/root";
    const copyArgs = {
      fromSandbox,
      fromHandle,
      fromHome,
      toSandbox,
      toHandle,
      toHome,
      ...(migrateOpts?.copyTimeoutSec ? { timeoutSec: migrateOpts.copyTimeoutSec } : {}),
    };
    let copied = await copyHome(copyArgs);
    const routeRow = (): SandboxRoute => ({
      backend: to,
      migratedAt: new Date().toISOString(),
      migrationSha: copied.sha,
      ...(reason ? { reason } : {}),
      ...(capabilitiesLost.length ? { capabilitiesLost } : {}),
    });
    await routes.put(scopeId, routeRow());
    if (opts.settleMs) await sleep(opts.settleMs);
    let resynced = false;
    const changed = await fromSandbox.run(
      fromHandle,
      `find ${shq(fromHome)} -type f -newermt ${shq(startedAtIso)} 2>/dev/null | head -1`,
      { timeoutMs: 60_000 },
    );
    if (changed.stdout.trim() !== "") {
      copied = await copyHome(copyArgs);
      await routes.put(scopeId, routeRow());
      resynced = true;
    }
    await Promise.all([park(fromSandbox, fromHandle), park(toSandbox, toHandle)]);
    return { scopeId, from, to, resynced, capabilitiesLost, ...copied };
  }

  const park = (s: Sandbox, h: SandboxHandle) => s.teardown(h).catch(() => {});

  return {
    migrateScope: (scopeId, to, reason?, migrateOpts?) => {
      const run = () =>
        opts.advisoryLock
          ? opts.advisoryLock.withLock(`sandbox-migration:${scopeId}`, () => migrate(scopeId, to, reason, migrateOpts))
          : migrate(scopeId, to, reason, migrateOpts);
      return opts.withLegacyMutation ? opts.withLegacyMutation(scopeId, run) : run();
    },
    listRoutes: () => routes.entries(),
    availableBackends: () =>
      Object.entries(backends)
        .filter(([, s]) => !!s)
        .map(([n]) => n as SandboxBackendName),
    defaultBackend,
  };
}
