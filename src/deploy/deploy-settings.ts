import { githubRepoUrl, isGitBranchName } from "../../cli/src/render-source.ts";
import { porterLocatorPresent, porterApiBaseUrl } from "../sandbox/sandbox-settings.ts";
import { numEnvStrict, optNum } from "../util/env.ts";
import { commitShaSchema } from "../util/ids.ts";

export interface DeploySettings {
  deployProvider: "docker" | "aws" | "fly" | "porter" | "e2b" | "render";
  deployAppsDomain?: string;
  deployAppsSessionSecret?: string;
  deployAppsLoginUrl?: string;
  deployAppsLoginPath?: "/auth/login" | "/auth/trusted/login";
  renderDeploy: RenderDeployEnv;
  porterDeploy: PorterDeployEnv;
  awsDeploy: AwsDeployEnv;
  flyDeploy: FlyDeployEnv;
}

function renderRegion(env: NodeJS.ProcessEnv): string {
  return env.RENDER_REGION?.trim() || "oregon";
}

interface RenderDeployEnv {
  projectId: string;
  environmentId?: string;
  apiKey: string;
  workspaceId: string;
  minioServiceId: string;
  source?: { repo: string; branch: string; commit: string };
  region: string;
  appRegion: string;
}

function renderDeployEnv(env: NodeJS.ProcessEnv): RenderDeployEnv {
  const rawRepo = env.RENDER_DEPLOY_REPO?.trim();
  const repo = rawRepo ? githubRepoUrl(rawRepo) : undefined;
  const branch = env.RENDER_DEPLOY_BRANCH?.trim();
  const commit = env.GIT_SHA?.trim();
  const minioServiceId = env.RENDER_MINIO_SERVICE_ID?.trim() || "";
  if (Boolean(rawRepo) !== Boolean(branch))
    throw new Error("RENDER_DEPLOY_REPO and RENDER_DEPLOY_BRANCH must be set together");
  if (rawRepo && !repo)
    throw new Error("RENDER_DEPLOY_REPO must be an HTTPS GitHub repository URL without credentials");
  if (branch && !isGitBranchName(branch)) throw new Error("RENDER_DEPLOY_BRANCH must be a valid Git branch name");
  if (env.DEPLOY_PROVIDER === "render" && (!repo || !branch || !commitShaSchema.safeParse(commit).success))
    throw new Error("DEPLOY_PROVIDER=render requires RENDER_DEPLOY_REPO, RENDER_DEPLOY_BRANCH, and GIT_SHA");
  if (env.DEPLOY_PROVIDER === "render" && !/^srv-[a-z0-9]+$/.test(minioServiceId))
    throw new Error("DEPLOY_PROVIDER=render requires RENDER_MINIO_SERVICE_ID");
  const projectId = env.RENDER_PROJECT_ID?.trim() || "";
  if (env.DEPLOY_PROVIDER === "render" && !projectId)
    throw new Error("DEPLOY_PROVIDER=render requires RENDER_PROJECT_ID");
  if (projectId && !/^prj-[a-z0-9]+$/.test(projectId))
    throw new Error("RENDER_PROJECT_ID must be a project ID (prj-...)");
  const environmentId = env.RENDER_ENVIRONMENT_ID?.trim();
  if (env.DEPLOY_PROVIDER === "render" && !environmentId)
    throw new Error("DEPLOY_PROVIDER=render requires RENDER_ENVIRONMENT_ID");
  if (environmentId && !/^evm-[a-z0-9]+$/.test(environmentId))
    throw new Error("RENDER_ENVIRONMENT_ID must be an environment ID (evm-...)");
  const region = renderRegion(env);
  return {
    projectId,
    ...(environmentId ? { environmentId } : {}),
    apiKey: env.RENDER_API_KEY?.trim() || "",
    workspaceId: env.RENDER_WORKSPACE_ID?.trim() || "",
    minioServiceId,
    ...(repo && branch && commit ? { source: { repo, branch, commit } } : {}),
    region,
    appRegion: env.RENDER_APP_REGION?.trim() || region,
  };
}

interface PorterDeployEnv {
  token?: string;
  baseUrl?: string;
  runnerImage?: string;
  appsDomain?: string;
  visibility?: "public" | "private" | "internal";
  namePrefix?: string;
  ttlSec?: number;
}

function porterDeployVisibilityStrict(value: string | undefined): PorterDeployEnv["visibility"] {
  if (value === undefined || value.trim() === "") return undefined;
  const visibility = value.trim();
  if (visibility === "public" || visibility === "private" || visibility === "internal") return visibility;
  throw new Error(
    `PORTER_DEPLOY_VISIBILITY=${JSON.stringify(value)} is not recognized — use public, private, or internal, or unset it.`,
  );
}

function porterDeployEnv(env: NodeJS.ProcessEnv): PorterDeployEnv {
  const token = env.PORTER_DEPLOY_API_TOKEN;
  const baseUrl = porterApiBaseUrl(env);
  const visibility = porterDeployVisibilityStrict(env.PORTER_DEPLOY_VISIBILITY);
  if (visibility === "internal" && env.PORTER_DEPLOY_APPS_DOMAIN) {
    throw new Error(
      "PORTER_DEPLOY_VISIBILITY=internal serves apps inside the cluster only, so it takes no PORTER_DEPLOY_APPS_DOMAIN — unset one of them.",
    );
  }
  const ttlSec = numEnvStrict("PORTER_DEPLOY_TTL_SEC", env.PORTER_DEPLOY_TTL_SEC);
  const runnerImage = env.PORTER_DEPLOY_RUNNER_IMAGE ?? env.PORTER_SANDBOX_IMAGE;
  return {
    ...(token ? { token } : {}),
    ...(baseUrl ? { baseUrl } : {}),
    ...(runnerImage ? { runnerImage } : {}),
    ...(env.PORTER_DEPLOY_APPS_DOMAIN ? { appsDomain: env.PORTER_DEPLOY_APPS_DOMAIN } : {}),
    ...(visibility ? { visibility } : {}),
    ...(env.PORTER_SANDBOX_NAME_PREFIX ? { namePrefix: env.PORTER_SANDBOX_NAME_PREFIX } : {}),
    ...(ttlSec !== undefined ? { ttlSec } : {}),
  };
}

interface AwsDeployEnv {
  region: string;
  profile?: string;
  imageIdentifier: string;
  imageVersion?: string;
  executionRoleArn?: string;
  ingressConnectorArns?: string[];
  egressConnectorArns?: string[];
  agentPort?: number;
  appPort?: number;
  maximumDurationInSeconds?: number;
  rotateAfterSeconds?: number;
  maxIdleDurationSeconds?: number;
  suspendedDurationSeconds?: number;
  appsDomain?: string;
  gateSecret?: string;
  tokenTtlMinutes?: number;
  dataBucket?: string;
  dataPrefix?: string;
  snapshotIntervalMs?: number;
  dataRoleArn?: string;
}

function deployAppsEnv(
  env: NodeJS.ProcessEnv,
  defaultLoginUrl: string | undefined,
): {
  deployAppsSessionSecret?: string;
  deployAppsLoginUrl?: string;
  deployAppsLoginPath?: "/auth/login" | "/auth/trusted/login";
} {
  const explicit = env.DEPLOY_APPS_SESSION_SECRET;
  const shared = env.PORTAL_SESSION_SECRET;
  const loginUrl = env.DEPLOY_APPS_LOGIN_URL ?? (explicit || shared ? defaultLoginUrl : undefined);
  if (loginUrl && !explicit && !shared) {
    throw new Error("DEPLOY_APPS_LOGIN_URL requires DEPLOY_APPS_SESSION_SECRET");
  }
  if (explicit && !loginUrl) {
    throw new Error("DEPLOY_APPS_SESSION_SECRET needs a sign-in address — set DEPLOY_APPS_LOGIN_URL or PUBLIC_WEB_URL");
  }
  const secret = explicit ?? (loginUrl ? shared : undefined);
  const loginPath = env.DEPLOY_APPS_LOGIN_PATH ?? "/auth/login";
  if (loginPath !== "/auth/login" && loginPath !== "/auth/trusted/login") {
    throw new Error("DEPLOY_APPS_LOGIN_PATH must be /auth/login or /auth/trusted/login");
  }
  if (!secret || !loginUrl) return {};
  return {
    deployAppsSessionSecret: secret,
    deployAppsLoginUrl: loginUrl.replace(/\/$/, ""),
    deployAppsLoginPath: loginPath,
  };
}

const SHARED_PLATFORM_SUFFIXES = [
  "onporter.run",
  "withporter.run",
  "porter.run",
  "fly.dev",
  "herokuapp.com",
  "onrender.com",
  "railway.app",
  "vercel.app",
  "netlify.app",
  "ondigitalocean.app",
  "azurewebsites.net",
  "elasticbeanstalk.com",
  "amazonaws.com",
  "cloudfront.net",
  "github.io",
  "pages.dev",
  "workers.dev",
  "e2b.app",
];

function sharedPlatformSuffixOf(domain: string): string | undefined {
  const host = domain.toLowerCase();
  return SHARED_PLATFORM_SUFFIXES.find((suffix) => host === suffix || host.endsWith(`.${suffix}`));
}

const HOSTNAME_LABEL = "[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?";
const HOSTNAME_RE = new RegExp(`^${HOSTNAME_LABEL}(?:\\.${HOSTNAME_LABEL})+$`);

function deployAppsDomainEnv(env: NodeJS.ProcessEnv, deployProvider: string): string | undefined {
  const raw = env.DEPLOY_APPS_DOMAIN?.trim();
  if (raw) {
    const canonical = raw.toLowerCase().replace(/\.$/, "");
    if (!HOSTNAME_RE.test(canonical)) {
      throw new Error(
        `DEPLOY_APPS_DOMAIN (${raw}) is not a plain DNS name — set it to a bare domain like apps.example.com (no scheme, port, path, or wildcard prefix).`,
      );
    }
    const suffix = sharedPlatformSuffixOf(canonical);
    if (suffix) {
      throw new Error(
        `DEPLOY_APPS_DOMAIN (${canonical}) is under ${suffix}, a shared platform domain that cannot carry per-app subdomains — attach a custom domain you control (set DEPLOY_APPS_DOMAIN=apps.<your-domain> with a wildcard DNS record pointing at this instance), or unset it to keep serving apps signed-in at /d/<app>/.`,
      );
    }
    return canonical;
  }
  if (deployProvider === "porter" && env.PORTER_DEPLOY_APPS_DOMAIN) return env.PORTER_DEPLOY_APPS_DOMAIN;
  return env.AWS_DEPLOY_APPS_DOMAIN;
}

function awsDeployEnv(env: NodeJS.ProcessEnv): AwsDeployEnv {
  const csv = (s: string | undefined): string[] | undefined =>
    s
      ? s
          .split(",")
          .map((x) => x.trim())
          .filter(Boolean)
      : undefined;
  const ingress = csv(env.AWS_DEPLOY_INGRESS_CONNECTORS);
  const egress = csv(env.AWS_DEPLOY_EGRESS_CONNECTORS);
  return {
    region: env.AWS_DEPLOY_REGION ?? env.AWS_REGION ?? env.AWS_DEFAULT_REGION ?? "us-west-2",
    ...(env.AWS_DEPLOY_PROFILE ? { profile: env.AWS_DEPLOY_PROFILE } : {}),
    imageIdentifier: env.AWS_DEPLOY_IMAGE ?? "qm-microvm-sandbox",
    ...(env.AWS_DEPLOY_IMAGE_VERSION ? { imageVersion: env.AWS_DEPLOY_IMAGE_VERSION } : {}),
    ...(env.AWS_DEPLOY_EXEC_ROLE_ARN ? { executionRoleArn: env.AWS_DEPLOY_EXEC_ROLE_ARN } : {}),
    ...(ingress ? { ingressConnectorArns: ingress } : {}),
    ...(egress ? { egressConnectorArns: egress } : {}),
    ...optNum(env, "AWS_DEPLOY_AGENT_PORT", "agentPort"),
    ...optNum(env, "AWS_DEPLOY_APP_PORT", "appPort"),
    ...optNum(env, "AWS_DEPLOY_MAX_DURATION_SEC", "maximumDurationInSeconds"),
    ...optNum(env, "AWS_DEPLOY_ROTATE_AFTER_SEC", "rotateAfterSeconds"),
    ...optNum(env, "AWS_DEPLOY_MAX_IDLE_SEC", "maxIdleDurationSeconds"),
    ...optNum(env, "AWS_DEPLOY_SUSPENDED_SEC", "suspendedDurationSeconds"),
    ...(env.AWS_DEPLOY_APPS_DOMAIN ? { appsDomain: env.AWS_DEPLOY_APPS_DOMAIN } : {}),
    ...(env.AWS_DEPLOY_GATE_SECRET ? { gateSecret: env.AWS_DEPLOY_GATE_SECRET } : {}),
    ...optNum(env, "AWS_DEPLOY_TOKEN_TTL_MIN", "tokenTtlMinutes"),
    ...(env.AWS_DEPLOY_DATA_BUCKET ? { dataBucket: env.AWS_DEPLOY_DATA_BUCKET } : {}),
    ...(env.AWS_DEPLOY_DATA_PREFIX ? { dataPrefix: env.AWS_DEPLOY_DATA_PREFIX } : {}),
    ...(env.AWS_DEPLOY_DATA_ROLE_ARN ? { dataRoleArn: env.AWS_DEPLOY_DATA_ROLE_ARN } : {}),
    ...(numEnvStrict("AWS_DEPLOY_SNAPSHOT_INTERVAL_MS", env.AWS_DEPLOY_SNAPSHOT_INTERVAL_MS) !== undefined
      ? {
          snapshotIntervalMs: Math.max(
            60_000,
            numEnvStrict("AWS_DEPLOY_SNAPSHOT_INTERVAL_MS", env.AWS_DEPLOY_SNAPSHOT_INTERVAL_MS)!,
          ),
        }
      : {}),
  };
}

interface FlyDeployEnv {
  token: string;
  appPrefix: string;
  sharedAppName?: string;
  wireguardPeers?: string;
  metadataUri?: string;
  baseImage: string;
  org: string;
  region?: string;
  dataVolumeSizeGb?: number;
}

function flyDeployEnv(env: NodeJS.ProcessEnv): FlyDeployEnv {
  return {
    token: env.FLY_DEPLOY_API_TOKEN ?? "",
    appPrefix: env.FLY_DEPLOY_APP_PREFIX ?? "",
    ...(env.FLY_DEPLOY_SHARED_APP_NAME ? { sharedAppName: env.FLY_DEPLOY_SHARED_APP_NAME } : {}),
    ...(env.FLY_DEPLOY_WIREGUARD_PEERS ? { wireguardPeers: env.FLY_DEPLOY_WIREGUARD_PEERS } : {}),
    ...(env.ECS_CONTAINER_METADATA_URI_V4 ? { metadataUri: env.ECS_CONTAINER_METADATA_URI_V4 } : {}),
    baseImage: env.FLY_DEPLOY_BASE_IMAGE ?? "",
    org: env.FLY_ORG ?? "",
    ...(env.FLY_REGION ? { region: env.FLY_REGION } : {}),
    ...(env.FLY_DEPLOY_DATA_VOLUME_SIZE_GB !== undefined
      ? { dataVolumeSizeGb: Number(env.FLY_DEPLOY_DATA_VOLUME_SIZE_GB) }
      : {}),
  };
}

export function deploySettings(env: NodeJS.ProcessEnv, publicUrl: string | undefined): DeploySettings {
  const deployAppsDomain = deployAppsDomainEnv(env, env.DEPLOY_PROVIDER ?? "docker");
  if (env.DEPLOY_PROVIDER === "porter" && !env.PORTER_DEPLOY_APPS_DOMAIN && !env.DEPLOY_APPS_DOMAIN) {
    console.warn(
      "[config] DEPLOY_PROVIDER=porter without an apps domain — published apps are reachable signed-in at /d/<app>/ only; set DEPLOY_APPS_DOMAIN to a domain you control to serve each app on its own subdomain.",
    );
  }
  if (env.DEPLOY_PROVIDER === "porter" && !porterLocatorPresent(env)) {
    throw new Error(
      "DEPLOY_PROVIDER=porter requires PORTER_DEPLOY_PROJECT_ID and PORTER_DEPLOY_CLUSTER_ID (or PORTER_SANDBOX_BASE_URL, or PORTER_CLUSTER_ID) to locate the Porter sandbox API.",
    );
  }
  if (env.DEPLOY_PROVIDER === "render" && !env.RENDER_WORKSPACE_ID?.trim())
    throw new Error("Render providers require RENDER_WORKSPACE_ID");
  const deployProvider = env.DEPLOY_PROVIDER ?? "docker";
  if (
    deployProvider !== "aws" &&
    deployProvider !== "docker" &&
    deployProvider !== "fly" &&
    deployProvider !== "porter" &&
    deployProvider !== "e2b" &&
    deployProvider !== "render"
  ) {
    throw new Error(
      `DEPLOY_PROVIDER=${JSON.stringify(deployProvider)} is not recognized (expected aws, docker, fly, porter, e2b, or render)`,
    );
  }
  return {
    deployProvider,
    ...deployAppsEnv(env, publicUrl),
    renderDeploy: renderDeployEnv(env),
    porterDeploy: porterDeployEnv(env),
    awsDeploy: {
      ...awsDeployEnv(env),
      ...(env.DEPLOY_APPS_DOMAIN && deployAppsDomain && !env.AWS_DEPLOY_APPS_DOMAIN
        ? { appsDomain: deployAppsDomain }
        : {}),
    },
    ...(deployAppsDomain ? { deployAppsDomain } : {}),
    flyDeploy: flyDeployEnv(env),
  };
}
