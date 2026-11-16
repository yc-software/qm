import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createAwsDeployProvider, type StoredDeployBody } from "../../src/deploy/aws-deploy-provider.ts";
import {
  AwsApiError,
  type AwsMicrovmApi,
  type MicrovmDescription,
  type MicrovmLifecycleState,
} from "../../src/sandbox/aws-microvm-api.ts";
import type { PublishedApp, AppVersion } from "../../src/deploy/deploy-store.ts";
import { scopeId } from "../../src/types.ts";
import { singleProcessDeps } from "./single-process.ts";
import { testMap } from "./test-database.ts";
const REGION = "us-west-2";

interface Vm {
  state: MicrovmLifecycleState;
  endpoint: string;
}

export function fakeApi() {
  const vms = new Map<string, Vm>();
  const counts = { run: 0, resume: 0, terminate: 0, token: 0, describe: 0 };
  const launches: Array<Parameters<AwsMicrovmApi["runMicrovm"]>[0]> = [];
  let n = 0;
  const api: AwsMicrovmApi = {
    async listImages() {
      return [{ name: "qm-microvm-sandbox", imageArn: "arn:img", state: "ACTIVE", latestActiveImageVersion: "1" }];
    },
    async findImage(name) {
      return { name, imageArn: "arn:img", state: "ACTIVE", latestActiveImageVersion: "1" };
    },
    async createImage() {
      throw new Error("createImage unused in deploy provider");
    },
    async updateImage() {
      throw new Error("updateImage unused in deploy provider");
    },
    async runMicrovm(input) {
      counts.run++;
      launches.push(input);
      const id = `mvm-${++n}`;
      const endpoint = `${id}.lambda-microvm.${REGION}.on.aws`;
      vms.set(id, { state: "RUNNING", endpoint });
      return { microvmId: id, endpoint, state: "RUNNING" };
    },
    async getMicrovm(id) {
      counts.describe++;
      const v = vms.get(id);
      if (!v) throw new AwsApiError("not found", 404);
      return { microvmId: id, ...v };
    },
    async tryGetMicrovm(id) {
      counts.describe++;
      const v = vms.get(id);
      return v ? { microvmId: id, ...v } : null;
    },
    async createAuthToken(id) {
      counts.token++;
      return `tok-${id}-${counts.token}`;
    },
    async suspend(id) {
      const v = vms.get(id);
      if (v) v.state = "SUSPENDED";
    },
    async resume(id) {
      counts.resume++;
      const v = vms.get(id);
      if (v) v.state = "RUNNING";
    },
    async terminate(id) {
      counts.terminate++;
      const v = vms.get(id);
      if (v) v.state = "TERMINATED";
    },
    async waitForState(id, target): Promise<MicrovmDescription> {
      const v = vms.get(id);
      return { microvmId: id, state: v?.state ?? target, ...(v?.endpoint ? { endpoint: v.endpoint } : {}) };
    },
  };
  return { api, vms, counts, launches };
}

export function fakeDaemon(
  opts: {
    execCode?: (cmd: string, url: string) => number;
    execStdout?: (cmd: string) => string;
    readB64?: (path: string) => string;
  } = {},
) {
  const execs: string[] = [];
  const writes: Array<{ path: string; b64: string }> = [];
  const fetchImpl = (async (url: string | URL, init?: { body?: string }) => {
    const u = String(url);
    const body = init?.body ? (JSON.parse(init.body) as Record<string, string>) : {};
    const ok = (data: unknown) => ({
      status: 200,
      text: async () => JSON.stringify(data),
      headers: { get: () => null },
    });
    if (u.endsWith("/health")) return ok({ ok: true });
    if (u.endsWith("/exec")) {
      execs.push(body.cmd ?? "");
      return ok({
        stdout: opts.execStdout?.(body.cmd ?? "") ?? "",
        stderr: "",
        code: opts.execCode?.(body.cmd ?? "", u) ?? 0,
        timedOut: false,
      });
    }
    if (u.endsWith("/write")) {
      writes.push({ path: body.path!, b64: body.b64! });
      return ok({ ok: true });
    }
    if (u.endsWith("/read")) return ok({ b64: opts.readB64?.(body.path ?? "") ?? "" });
    return ok({});
  }) as unknown as typeof fetch;
  return { fetchImpl, execs, writes };
}

export function fakeS3(objects: Map<string, Uint8Array> = new Map()) {
  const calls: string[] = [];
  const s3 = {
    async send(cmd: { constructor: { name: string }; input: { Key?: string; Body?: Uint8Array } }) {
      const kind = cmd.constructor.name;
      const key = cmd.input.Key!;
      calls.push(`${kind}:${key}`);
      if (kind === "PutObjectCommand") objects.set(key, cmd.input.Body!);
      if (kind === "DeleteObjectCommand") objects.delete(key);
      if (kind === "GetObjectCommand") {
        const bytes = objects.get(key);
        if (!bytes) {
          const e = new Error("no such key") as Error & { name: string };
          e.name = "NoSuchKey";
          throw e;
        }
        return { Body: { transformToByteArray: async () => bytes } };
      }
      if (kind === "ListObjectsV2Command") {
        const prefix = (cmd.input as { Prefix?: string }).Prefix ?? "";
        return {
          Contents: [...objects.keys()].filter((k) => k.startsWith(prefix)).map((k) => ({ Key: k })),
          IsTruncated: false,
        };
      }
      if (kind === "DeleteObjectsCommand") {
        for (const o of (cmd.input as unknown as { Delete: { Objects: Array<{ Key: string }> } }).Delete.Objects)
          objects.delete(o.Key);
      }
      return {};
    },
  };
  return { s3: s3 as unknown as Pick<import("@aws-sdk/client-s3").S3Client, "send">, objects, calls };
}

export function fakeSts() {
  const assumes: Array<{ policy: string; role: string }> = [];
  const sts = {
    async send(cmd: { input: { RoleArn?: string; Policy?: string } }) {
      assumes.push({ policy: cmd.input.Policy ?? "", role: cmd.input.RoleArn ?? "" });
      return {
        Credentials: {
          AccessKeyId: `AKIA${assumes.length}`,
          SecretAccessKey: "sk",
          SessionToken: "tok",
          Expiration: new Date(),
        },
      };
    },
  };
  return { sts: sts as unknown as Pick<import("@aws-sdk/client-sts").STSClient, "send">, assumes };
}

export function provider(
  api: AwsMicrovmApi,
  fetchImpl: typeof fetch,
  store = testMap<StoredDeployBody>(),
  extra: Record<string, unknown> = {},
) {
  return createAwsDeployProvider({
    ...singleProcessDeps(),
    region: REGION,
    imageIdentifier: "qm-microvm-sandbox",
    appPort: 8081,
    appsDomain: "apps.example.com",
    api,
    fetchImpl,
    store,
    ...extra,
  });
}

export function publishedApp(id: string, name?: string): PublishedApp {
  return {
    id,
    ownerScopeId: scopeId("personal", "U1"),
    createdBy: "U1",
    currentVersion: 1,
    status: "stopped",
    endpoint: null,
    versions: [],
    ...(name ? { name } : {}),
  };
}

export function localSnapshot(file: string, contents: string): string {
  const dir = mkdtempSync(join(tmpdir(), "aws-deploy-"));
  const target = join(dir, file);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, contents);
  return dir;
}

export function version(snapshotDir: string, over: Partial<AppVersion> = {}): AppVersion {
  return { version: 1, createdAt: 0, entrypoint: "node server.js", snapshotDir, env: { API_KEY: "secret" }, ...over };
}

export const ID = "550e8400-e29b-41d4-a716-446655440000";
export const written = (writes: Array<{ path: string }>, p: string): boolean => writes.some((w) => w.path === p);
