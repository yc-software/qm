import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative, sep } from "node:path";
import { lookup as dnsLookup } from "node:dns/promises";
import { isIP } from "node:net";
import { errMessage } from "../util/errors.ts";
import { isPrivateNetworkIp } from "../util/network.ts";
import { isProbablyBinary } from "./seed.ts";
import type { FetchedRepo, RepoFile } from "./ingest.ts";
import type { SkillPack } from "./skill-pack-store.ts";

export interface SkillPackFetcher {
  fetch(pack: SkillPack): Promise<FetchedRepo>;
  resolveRef(pack: SkillPack): Promise<string>;
}

export interface GitFetcherOptions {
  resolveAuth?: (pack: SkillPack) => Promise<GitAuth | undefined>;
  gitBin?: string;
  timeoutMs?: number;
  maxFiles?: number;
  maxTotalBytes?: number;
  allowLocalRepos?: boolean;
  lookup?: (host: string) => Promise<string[]>;
}

export interface PackTokenSources {
  serviceCredential(slug: string): Promise<
    | {
        secret: string;
        host: string;
        enabled: boolean;
        injection?: { header?: string; scheme?: string };
        allowedMethods?: string[];
        allowedPathPrefixes?: string[];
      }
    | undefined
  >;
  connectorToken(host: string, principalId: string): Promise<string | undefined>;
}

export interface GitAuth {
  header: string;
  value: string;
  secret: string;
}

function normalizedHost(repoUrl: string): string | null {
  try {
    return new URL(repoUrl).hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return null;
  }
}

function connectorHostFor(repoUrl: string): string | null {
  const host = normalizedHost(repoUrl);
  if (!host) return null;
  if (host === "github.com" || host === "api.github.com") return "api.github.com";
  return null;
}

interface ValidatedRepo {
  url: string;
  gitConfig: Array<[string, string]>;
}

async function validateRepoUrl(
  raw: string,
  allowLocalRepos: boolean,
  lookup: (host: string) => Promise<string[]>,
): Promise<ValidatedRepo> {
  if (typeof raw !== "string" || !raw.trim()) throw new Error("skill pack url is required");
  if (allowLocalRepos && raw.startsWith("/")) return { url: raw, gitConfig: [] };
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("skill pack url must use https");
  }
  if (url.protocol !== "https:" || !url.hostname || url.username || url.password) {
    throw new Error("skill pack url must use credential-free https");
  }
  const host = url.hostname.toLowerCase().replace(/^\[(.*)\]$/, "$1");
  const literal = isIP(host) !== 0;
  let addresses: string[];
  try {
    addresses = literal ? [host] : await lookup(host);
  } catch {
    throw new Error("skill pack repository hostname could not be resolved");
  }
  if (!addresses.length || addresses.some((address) => isPrivateNetworkIp(address))) {
    throw new Error("skill pack repository must resolve to a public network address");
  }
  const port = url.port || "443";
  const resolved = addresses.map((address) => (isIP(address) === 6 ? `[${address}]` : address)).join(",");
  return {
    url: url.toString(),
    gitConfig: [
      ["http.followRedirects", "false"],
      ...(!literal ? [["http.curloptResolve", `${host}:${port}:${resolved}`] as [string, string]] : []),
      ["http.proxy", ""],
    ],
  };
}

export async function resolvePackAuth(
  sources: PackTokenSources,
  pack: Pick<SkillPack, "url" | "authCredentialSlug" | "createdBy">,
): Promise<GitAuth | undefined> {
  if (pack.authCredentialSlug) {
    const credential = await sources.serviceCredential(pack.authCredentialSlug);
    if (!credential?.enabled) return undefined;
    const repo = new URL(pack.url);
    const repoHost = normalizedHost(pack.url);
    const credentialHost = normalizedHost(`https://${credential.host}`) ?? credential.host.toLowerCase();
    if (!repoHost || (repoHost !== credentialHost && connectorHostFor(pack.url) !== credentialHost)) {
      throw new Error(`skill pack credential is not authorized for ${repoHost ?? "this repository"}`);
    }
    const methods = credential.allowedMethods?.map((method) => method.toUpperCase());
    if (methods && (!methods.includes("GET") || !methods.includes("POST"))) {
      throw new Error("skill pack credential must allow Git HTTP GET and POST");
    }
    if (
      credential.allowedPathPrefixes?.length &&
      !credential.allowedPathPrefixes.some((prefix) => repo.pathname.startsWith(prefix))
    ) {
      throw new Error(`skill pack credential is not authorized for ${repo.pathname}`);
    }
    const header = credential.injection?.header?.trim() || "Authorization";
    const scheme = credential.injection?.scheme ?? "Bearer ";
    return { header, value: `${scheme}${credential.secret}`, secret: credential.secret };
  }
  const host = connectorHostFor(pack.url);
  if (host) {
    const token = await sources.connectorToken(host, pack.createdBy);
    if (token) return { header: "Authorization", value: `Bearer ${token}`, secret: token };
  }
  return undefined;
}

const SHA_RE = /^[0-9a-f]{7,40}$/;
const BRANCH_RE = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$/;

const execFileP = promisify(execFile);

function scrub(s: string, auth: GitAuth | undefined): string {
  return auth ? s.split(auth.secret).join("***").split(auth.value).join("***") : s;
}

export function createGitFetcher(opts: GitFetcherOptions = {}): SkillPackFetcher {
  const gitBin = opts.gitBin ?? "git";
  const timeoutMs = opts.timeoutMs ?? 60_000;
  const maxFiles = opts.maxFiles ?? 5000;
  const maxTotalBytes = opts.maxTotalBytes ?? 32 * 1024 * 1024;
  const allowLocalRepos = opts.allowLocalRepos === true;
  const lookup =
    opts.lookup ??
    ((host: string) =>
      dnsLookup(host, { all: true, verbatim: true }).then((results) => results.map((result) => result.address)));

  function gitEnv(cwd: string, auth: GitAuth | undefined, config: Array<[string, string]>): NodeJS.ProcessEnv {
    const env: NodeJS.ProcessEnv = { ...globalThis.process.env };
    for (const k of Object.keys(env)) if (/^(GIT_|SSH_)/.test(k)) delete env[k];
    env.HOME = cwd;
    env.GIT_TERMINAL_PROMPT = "0";
    env.GIT_CONFIG_NOSYSTEM = "1";
    env.GIT_CONFIG_GLOBAL = "/dev/null";
    env.GIT_ALLOW_PROTOCOL = allowLocalRepos ? "https:file" : "https";
    const entries = [
      ...config,
      ...(auth ? [["http.extraHeader", `${auth.header}: ${auth.value}`] as [string, string]] : []),
    ];
    if (entries.length) {
      env.GIT_CONFIG_COUNT = String(entries.length);
      entries.forEach(([key, value], index) => {
        env[`GIT_CONFIG_KEY_${index}`] = key;
        env[`GIT_CONFIG_VALUE_${index}`] = value;
      });
    }
    return env;
  }

  async function git(
    args: string[],
    cwd: string,
    auth: GitAuth | undefined,
    config: Array<[string, string]> = [],
  ): Promise<string> {
    try {
      return (
        await execFileP(gitBin, args, {
          cwd,
          env: gitEnv(cwd, auth, config),
          timeout: timeoutMs,
          killSignal: "SIGKILL",
          maxBuffer: 64 * 1024 * 1024,
        })
      ).stdout;
    } catch (e) {
      if ((e as { killed?: boolean }).killed)
        throw new Error(`git ${args[0]} timed out after ${timeoutMs}ms`, { cause: e });
      throw new Error(scrub(errMessage(e), auth), { cause: e });
    }
  }

  async function readTree(root: string): Promise<RepoFile[]> {
    const files: RepoFile[] = [];
    let totalBytes = 0;
    const walk = async (absDir: string): Promise<void> => {
      for (const ent of await readdir(absDir, { withFileTypes: true })) {
        if (ent.name === ".git") continue;
        if (ent.isSymbolicLink()) continue;
        const abs = join(absDir, ent.name);
        if (ent.isDirectory()) {
          await walk(abs);
          continue;
        }
        if (!ent.isFile()) continue;
        if (files.length >= maxFiles) throw new Error(`pack exceeds max files (${maxFiles})`);
        const buf = await readFile(abs);
        totalBytes += buf.length;
        if (totalBytes > maxTotalBytes) throw new Error(`pack exceeds max bytes (${maxTotalBytes})`);
        const binary = isProbablyBinary(buf);
        files.push({
          path: relative(root, abs).split(sep).join("/"),
          text: binary ? "" : buf.toString("utf8"),
          binary,
        });
      }
    };
    await walk(root);
    return files.sort((a, b) => {
      if (a.path < b.path) return -1;
      if (a.path > b.path) return 1;
      return 0;
    });
  }

  return {
    async fetch(pack) {
      const ref = (pack.ref ?? "").trim();
      if (ref && !SHA_RE.test(ref) && !BRANCH_RE.test(ref)) throw new Error(`invalid skill pack ref: ${ref}`);
      const repo = await validateRepoUrl(pack.url, allowLocalRepos, lookup);
      const auth = opts.resolveAuth ? await opts.resolveAuth(pack) : undefined;

      const work = await mkdtemp(join(tmpdir(), "qm-skill-src-"));
      const repoDir = join(work, "repo");
      try {
        await git(["clone", "--no-checkout", "--quiet", repo.url, "repo"], work, auth, repo.gitConfig);
        await git(["checkout", "--detach", "--quiet", ref || "HEAD"], repoDir, undefined);
        const commit = (await git(["rev-parse", "HEAD"], repoDir, undefined)).trim();
        const files = await readTree(repoDir);
        return { commit, files };
      } finally {
        await rm(work, { recursive: true, force: true }).catch(() => {});
      }
    },

    async resolveRef(pack) {
      const ref = (pack.ref ?? "").trim();
      if (ref && !SHA_RE.test(ref) && !BRANCH_RE.test(ref)) throw new Error(`invalid skill pack ref: ${ref}`);
      const repo = await validateRepoUrl(pack.url, allowLocalRepos, lookup);
      const auth = opts.resolveAuth ? await opts.resolveAuth(pack) : undefined;
      const target = ref && BRANCH_RE.test(ref) && !SHA_RE.test(ref) ? ref : "HEAD";
      const work = await mkdtemp(join(tmpdir(), "qm-skill-ref-"));
      try {
        const out = await git(["ls-remote", repo.url, target], work, auth, repo.gitConfig);
        const sha =
          out
            .split("\n")
            .map((l) => l.trim())
            .filter(Boolean)[0]
            ?.split(/\s+/)[0] ?? "";
        if (!SHA_RE.test(sha)) throw new Error(`could not resolve ref "${target}" for skill pack`);
        return sha;
      } finally {
        await rm(work, { recursive: true, force: true }).catch(() => {});
      }
    },
  };
}
