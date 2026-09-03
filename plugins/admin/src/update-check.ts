import { errMessage } from "../../chassis/src/errors.ts";

const REGISTRY_URL = "https://registry.npmjs.org/@yc-software%2fqm";
const SEMVER = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/;
const RELEASE_AGE_MS = 7 * 24 * 60 * 60 * 1_000;
export const SUCCESS_TTL_MS = 6 * 60 * 60 * 1_000;
export const FAILURE_TTL_MS = 5 * 60 * 1_000;

type VersionParts = [number, number, number, string | undefined];

function versionParts(version: string): VersionParts | null {
  const match = SEMVER.exec(version);
  if (!match) return null;
  return [Number(match[1]), Number(match[2]), Number(match[3]), match[4]];
}

export function compareVersions(a: string, b: string): number {
  const left = versionParts(a);
  const right = versionParts(b);
  if (!left || !right) throw new Error(`invalid QM version: ${!left ? a : b}`);
  for (const i of [0, 1, 2] as const) {
    const difference = left[i]! - right[i]!;
    if (difference !== 0) return Math.sign(difference);
  }
  if (left[3] === right[3]) return 0;
  if (left[3] === undefined) return 1;
  if (right[3] === undefined) return -1;
  return left[3].localeCompare(right[3], undefined, { numeric: true });
}

export interface UpdateStatus {
  currentVersion: string;
  latestVersion: string;
  newestVersion: string;
  updateAvailable: boolean;
  updateCommand: string;
  releaseUrl: string;
  releasedAt: string;
  newestAvailableAt?: string;
}

interface RegistryMetadata {
  "dist-tags"?: { latest?: unknown };
  time?: Record<string, unknown>;
  versions?: Record<string, { deprecated?: unknown } | undefined>;
}

function eligibleRelease(metadata: RegistryMetadata, now: number): { version: string; releasedAt: string } {
  const newest = metadata["dist-tags"]?.latest;
  if (typeof newest !== "string" || !versionParts(newest)) {
    throw new Error("npm registry returned an invalid latest QM version");
  }
  const cutoff = now - RELEASE_AGE_MS;
  const eligible = Object.entries(metadata.versions ?? {})
    .filter(([version, entry]) => {
      const published = metadata.time?.[version];
      const parsed = typeof published === "string" ? Date.parse(published) : NaN;
      const parts = versionParts(version);
      return (
        parts?.[3] === undefined &&
        !entry?.deprecated &&
        Number.isFinite(parsed) &&
        parsed <= cutoff &&
        compareVersions(version, newest) <= 0
      );
    })
    .map(([version]) => version)
    .sort(compareVersions)
    .at(-1);
  const releasedAt = eligible ? metadata.time?.[eligible] : undefined;
  if (!eligible || typeof releasedAt !== "string") {
    throw new Error("npm registry has no QM release outside the dependency cooldown");
  }
  return { version: eligible, releasedAt };
}

export async function fetchUpdateStatus(
  currentVersion: string,
  fetcher: typeof fetch = fetch,
  now = Date.now(),
): Promise<UpdateStatus> {
  if (!versionParts(currentVersion)) throw new Error(`invalid current QM version: ${currentVersion}`);
  const response = await fetcher(REGISTRY_URL, {
    headers: { accept: "application/json" },
    signal: AbortSignal.timeout(3_000),
  });
  if (!response.ok) throw new Error(`npm registry returned ${response.status}`);
  const body = (await response.json()) as RegistryMetadata;
  const newestVersion = body["dist-tags"]?.latest;
  const newestParts = typeof newestVersion === "string" ? versionParts(newestVersion) : null;
  if (typeof newestVersion !== "string" || !newestParts) {
    throw new Error("npm registry returned an invalid latest QM version");
  }
  const eligible = eligibleRelease(body, now);
  const newestReleasedAt = body.time?.[newestVersion];
  const newestReleasedAtMs = typeof newestReleasedAt === "string" ? Date.parse(newestReleasedAt) : NaN;
  const newestAvailableAt =
    newestVersion !== eligible.version && newestParts[3] === undefined && Number.isFinite(newestReleasedAtMs)
      ? new Date(newestReleasedAtMs + RELEASE_AGE_MS).toISOString()
      : undefined;
  return {
    currentVersion,
    latestVersion: eligible.version,
    newestVersion,
    updateAvailable: compareVersions(currentVersion, eligible.version) < 0,
    updateCommand: `npm exec qm -- update --yes --version ${eligible.version}`,
    releaseUrl: `https://github.com/yc-software/qm/releases/tag/v${encodeURIComponent(eligible.version)}`,
    releasedAt: eligible.releasedAt,
    ...(newestAvailableAt ? { newestAvailableAt } : {}),
  };
}

export function createUpdateChecker(
  currentVersion: string | undefined,
  options: { fetcher?: typeof fetch; now?: () => number } = {},
): () => Promise<UpdateStatus | null> {
  const fetcher = options.fetcher ?? fetch;
  const now = options.now ?? Date.now;
  let cached: { expiresAt: number; status: UpdateStatus | null } | null = null;
  let pending: Promise<UpdateStatus | null> | null = null;

  return async (): Promise<UpdateStatus | null> => {
    if (!currentVersion || !versionParts(currentVersion)) return null;
    if (cached && cached.expiresAt > now()) return cached.status;
    if (pending) return pending;
    pending = fetchUpdateStatus(currentVersion, fetcher, now())
      .then((status) => {
        cached = { expiresAt: now() + SUCCESS_TTL_MS, status };
        return status;
      })
      .catch((error: unknown) => {
        console.warn(`[admin] update check failed: ${errMessage(error)}`);
        cached = { expiresAt: now() + FAILURE_TTL_MS, status: null };
        return null;
      })
      .finally(() => {
        pending = null;
      });
    return pending;
  };
}
