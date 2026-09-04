import { SignatureV4 } from "@smithy/signature-v4";
import { Sha256 } from "@aws-crypto/sha256-js";
import { defaultProvider } from "@aws-sdk/credential-provider-node";
import { sleep } from "../util/async.ts";
import { errMessage, swallow } from "../util/errors.ts";

type CredentialProvider = () => Promise<{
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
  expiration?: Date;
}>;

const API = "/2025-09-09";

export type MicrovmLifecycleState = "PENDING" | "RUNNING" | "SUSPENDING" | "SUSPENDED" | "TERMINATING" | "TERMINATED";

export class AwsApiError extends Error {
  status: number;
  awsCode?: string;
  constructor(message: string, status: number, awsCode?: string) {
    super(message);
    this.name = "AwsApiError";
    this.status = status;
    if (awsCode) this.awsCode = awsCode;
  }
}

export interface MicrovmImageSummary {
  name: string;
  imageArn: string;
  state: string;
  latestActiveImageVersion: string | null;
  imageVersion?: string;
}

interface RunMicrovmInput {
  imageIdentifier: string;
  imageVersion?: string;
  ingressNetworkConnectors: string[];
  egressNetworkConnectors: string[];
  executionRoleArn?: string;
  idlePolicy?: { autoResumeEnabled: boolean; maxIdleDurationSeconds: number; suspendedDurationSeconds: number };
  maximumDurationInSeconds?: number;
  clientToken?: string;
}

export interface MicrovmDescription {
  microvmId: string;
  endpoint?: string;
  state: MicrovmLifecycleState;
  startedAt?: number;
  imageVersion?: string;
  stateReason?: string;
}

export interface AwsMicrovmApiOptions {
  region: string;
  profile?: string;
  credentials?: CredentialProvider;
  host?: string;
  fetchImpl?: typeof fetch;
}

export interface AwsMicrovmApi {
  listImages(): Promise<MicrovmImageSummary[]>;
  findImage(name: string): Promise<MicrovmImageSummary | null>;
  createImage(input: {
    name: string;
    s3Uri: string;
    baseImageArn: string;
    buildRoleArn: string;
    clientToken?: string;
  }): Promise<MicrovmImageSummary>;
  updateImage(input: {
    imageIdentifier: string;
    s3Uri: string;
    baseImageArn: string;
    buildRoleArn: string;
    clientToken?: string;
  }): Promise<MicrovmImageSummary>;
  runMicrovm(input: RunMicrovmInput): Promise<MicrovmDescription>;
  getMicrovm(id: string): Promise<MicrovmDescription>;
  tryGetMicrovm(id: string): Promise<MicrovmDescription | null>;
  createAuthToken(id: string, expirationInMinutes: number): Promise<string>;
  suspend(id: string): Promise<void>;
  resume(id: string): Promise<void>;
  terminate(id: string): Promise<void>;
  waitForState(
    id: string,
    target: MicrovmLifecycleState,
    opts?: { timeoutMs?: number; intervalMs?: number },
  ): Promise<MicrovmDescription>;
}

export function createMicrovmApi(opts: AwsMicrovmApiOptions): AwsMicrovmApi {
  const region = opts.region;
  const host = opts.host ?? `lambda.${region}.amazonaws.com`;
  const doFetch = opts.fetchImpl ?? fetch;
  const credentials = opts.credentials ?? defaultProvider(opts.profile ? { profile: opts.profile } : {});
  const signer = new SignatureV4({ service: "lambda", region, sha256: Sha256, credentials });

  async function call<T>(method: string, path: string, body?: unknown): Promise<{ status: number; json: T }> {
    const payload = body === undefined ? "" : JSON.stringify(body);
    const signed = await signer.sign({
      method,
      protocol: "https:",
      hostname: host,
      path,
      headers: { host, "content-type": "application/json" },
      body: payload,
      query: {},
    });
    const res = await doFetch(`https://${host}${path}`, {
      method,
      headers: signed.headers as Record<string, string>,
      ...(payload ? { body: payload } : {}),
    });
    const text = await res.text();
    let json: unknown = undefined;
    if (text.trim()) {
      try {
        json = JSON.parse(text);
      } catch {
        json = { message: text };
      }
    }
    if (res.status < 200 || res.status >= 300) {
      const msg = (json as { message?: string } | undefined)?.message ?? text ?? `HTTP ${res.status}`;
      const awsCode = res.headers.get("x-amzn-errortype") ?? undefined;
      throw new AwsApiError(`lambda-microvms ${method} ${path} -> ${res.status}: ${msg}`, res.status, awsCode);
    }
    return { status: res.status, json: (json ?? {}) as T };
  }

  const api: AwsMicrovmApi = {
    async listImages() {
      const { json } = await call<{ items?: MicrovmImageSummary[] }>("GET", `${API}/microvm-images`);
      return json.items ?? [];
    },
    async findImage(name) {
      return (await api.listImages()).find((i) => i.name === name) ?? null;
    },
    async createImage({ name, s3Uri, baseImageArn, buildRoleArn, clientToken }) {
      const { json } = await call<MicrovmImageSummary>("POST", `${API}/microvm-images`, {
        name,
        codeArtifact: { uri: s3Uri },
        baseImageArn,
        buildRoleArn,
        ...(clientToken ? { clientToken } : {}),
      });
      return json;
    },
    async updateImage({ imageIdentifier, s3Uri, baseImageArn, buildRoleArn, clientToken }) {
      const { json } = await call<MicrovmImageSummary>(
        "PUT",
        `${API}/microvm-images/${encodeURIComponent(imageIdentifier)}`,
        {
          codeArtifact: { uri: s3Uri },
          baseImageArn,
          buildRoleArn,
          ...(clientToken ? { clientToken } : {}),
        },
      );
      return json;
    },
    async runMicrovm(input) {
      const { json } = await call<MicrovmDescription>("POST", `${API}/microvms`, {
        imageIdentifier: input.imageIdentifier,
        ...(input.imageVersion ? { imageVersion: input.imageVersion } : {}),
        ingressNetworkConnectors: input.ingressNetworkConnectors,
        egressNetworkConnectors: input.egressNetworkConnectors,
        ...(input.executionRoleArn ? { executionRoleArn: input.executionRoleArn } : {}),
        ...(input.idlePolicy ? { idlePolicy: input.idlePolicy } : {}),
        ...(input.maximumDurationInSeconds ? { maximumDurationInSeconds: input.maximumDurationInSeconds } : {}),
        ...(input.clientToken ? { clientToken: input.clientToken } : {}),
      });
      return json;
    },
    async getMicrovm(id) {
      const { json } = await call<MicrovmDescription>("GET", `${API}/microvms/${encodeURIComponent(id)}`);
      return json;
    },
    async tryGetMicrovm(id) {
      try {
        return await api.getMicrovm(id);
      } catch (e) {
        if (e instanceof AwsApiError && e.status === 404) return null;
        throw e;
      }
    },
    async createAuthToken(id, expirationInMinutes) {
      const { json } = await call<{ authToken: Record<string, string> }>(
        "POST",
        `${API}/microvms/${encodeURIComponent(id)}/auth-token`,
        { allowedPorts: [{ allPorts: {} }], expirationInMinutes },
      );
      const tok = json.authToken?.["X-aws-proxy-auth"] ?? Object.values(json.authToken ?? {})[0];
      if (!tok) throw new AwsApiError("auth-token response missing token", 200);
      return tok;
    },
    async suspend(id) {
      await call("POST", `${API}/microvms/${encodeURIComponent(id)}/suspend`);
    },
    async resume(id) {
      await call("POST", `${API}/microvms/${encodeURIComponent(id)}/resume`);
    },
    async terminate(id) {
      await call("DELETE", `${API}/microvms/${encodeURIComponent(id)}`);
    },
    async waitForState(id, target, waitOpts) {
      const timeoutMs = waitOpts?.timeoutMs ?? 120_000;
      const intervalMs = waitOpts?.intervalMs ?? 1500;
      const deadline = Date.now() + timeoutMs;
      let last: MicrovmDescription | null = null;
      while (Date.now() < deadline) {
        last = await api.getMicrovm(id);
        if (last.state === target) return last;
        if (last.state === "TERMINATED" && target !== "TERMINATED") {
          throw new AwsApiError(`microVM ${id} terminated while waiting for ${target}: ${last.stateReason ?? ""}`, 409);
        }
        await sleep(intervalMs);
      }
      throw new AwsApiError(`timed out waiting for microVM ${id} to reach ${target} (last=${last?.state})`, 504);
    },
  };
  return api;
}

export interface VmFetchOptions {
  method?: string;
  body?: unknown;
  port?: number;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

export async function vmFetch(
  endpoint: string,
  token: string,
  path: string,
  opts: VmFetchOptions = {},
): Promise<{ status: number; text: string }> {
  const doFetch = opts.fetchImpl ?? fetch;
  const payload = opts.body === undefined ? undefined : JSON.stringify(opts.body);
  const res = await doFetch(`https://${endpoint}${path}`, {
    method: opts.method ?? "GET",
    headers: {
      "X-aws-proxy-auth": token,
      "X-aws-proxy-port": String(opts.port ?? 8080),
      ...(payload ? { "content-type": "application/json" } : {}),
    },
    ...(payload ? { body: payload } : {}),
    signal: AbortSignal.timeout(opts.timeoutMs ?? 120_000),
  });
  return { status: res.status, text: await res.text() };
}

export interface MicrovmClientOptions {
  agentPort: number;
  tokenTtlMinutes: number;
  fetchImpl?: typeof fetch;
}

interface MicrovmExecResult {
  stdout: string;
  stderr: string;
  code: number;
  timedOut: boolean;
}

export interface MicrovmClient {
  tokenFor(id: string): Promise<string>;
  daemon(
    id: string,
    endpoint: string,
    path: string,
    body?: unknown,
    timeoutMs?: number,
  ): Promise<{ status: number; text: string }>;
  execRaw(id: string, endpoint: string, cmd: string, timeoutSec: number): Promise<MicrovmExecResult>;
  writeAbs(id: string, endpoint: string, absPath: string, data: Uint8Array): Promise<void>;
  waitDaemon(id: string, endpoint: string): Promise<void>;
  ensureRunning(id: string, endpoint: string): Promise<void>;
  evict(id: string): void;
}

export function createMicrovmClient(api: AwsMicrovmApi, opts: MicrovmClientOptions): MicrovmClient {
  const { agentPort, tokenTtlMinutes } = opts;
  const fetchOpt = opts.fetchImpl ? { fetchImpl: opts.fetchImpl } : {};
  const tokenById = new Map<string, { token: string; expMs: number }>();

  async function tokenFor(id: string): Promise<string> {
    const cached = tokenById.get(id);
    if (cached && cached.expMs - Date.now() > 5 * 60_000) return cached.token;
    const token = await api.createAuthToken(id, tokenTtlMinutes);
    tokenById.set(id, { token, expMs: Date.now() + tokenTtlMinutes * 60_000 });
    return token;
  }

  async function daemon(
    id: string,
    endpoint: string,
    path: string,
    body?: unknown,
    timeoutMs?: number,
  ): Promise<{ status: number; text: string }> {
    const send = async (): Promise<{ status: number; text: string }> =>
      vmFetch(endpoint, await tokenFor(id), path, {
        method: "POST",
        body,
        port: agentPort,
        ...(timeoutMs ? { timeoutMs } : {}),
        ...fetchOpt,
      });
    let res = await send();
    if (res.status === 401 || res.status === 403) {
      tokenById.delete(id);
      res = await send();
    }
    return res;
  }

  async function execRaw(id: string, endpoint: string, cmd: string, timeoutSec: number): Promise<MicrovmExecResult> {
    const res = await daemon(id, endpoint, "/exec", { cmd, timeoutSec }, (timeoutSec + 15) * 1000);
    if (res.status !== 200) throw new Error(`microVM exec failed (${res.status}): ${res.text.slice(0, 300)}`);
    const j = JSON.parse(res.text) as { stdout?: string; stderr?: string; code: number; timedOut?: boolean };
    return { stdout: j.stdout ?? "", stderr: j.stderr ?? "", code: j.code, timedOut: !!j.timedOut };
  }

  async function writeAbs(id: string, endpoint: string, absPath: string, data: Uint8Array): Promise<void> {
    const res = await daemon(id, endpoint, "/write", { path: absPath, b64: Buffer.from(data).toString("base64") });
    if (res.status !== 200)
      throw new Error(`microVM write ${absPath} failed (${res.status}): ${res.text.slice(0, 200)}`);
  }

  async function waitDaemon(id: string, endpoint: string): Promise<void> {
    const deadline = Date.now() + 60_000;
    let lastErr = "";
    let throttled = 0;
    while (Date.now() < deadline) {
      try {
        const res = await vmFetch(endpoint, await tokenFor(id), "/health", {
          method: "GET",
          port: agentPort,
          timeoutMs: 8000,
          ...fetchOpt,
        });
        if (res.status === 200) return;
        if (res.status === 429) {
          if (++throttled >= 3) return;
        } else {
          throttled = 0;
          lastErr = `http ${res.status}`;
        }
      } catch (e) {
        throttled = 0;
        lastErr = errMessage(e);
      }
      await sleep(2000);
    }
    throw new Error(`microVM ${id} exec daemon never became reachable: ${lastErr}`);
  }

  async function ensureRunning(id: string, endpoint: string): Promise<void> {
    const desc = await api.getMicrovm(id);
    if (desc.state === "RUNNING") return;
    if (desc.state === "TERMINATED" || desc.state === "TERMINATING")
      throw new Error(`microVM ${id} is ${desc.state}, cannot run`);
    if (desc.state === "SUSPENDED") await api.resume(id).catch((e) => swallow("aws-microvm: resume", e));
    await waitDaemon(id, endpoint);
  }

  return { tokenFor, daemon, execRaw, writeAbs, waitDaemon, ensureRunning, evict: (id) => void tokenById.delete(id) };
}
