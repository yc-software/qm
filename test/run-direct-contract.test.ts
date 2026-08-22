import assert from "node:assert/strict";
import { test } from "node:test";
import { parseToolDescriptor } from "../src/deployment/deployment-layer.ts";
import { resolvedDeploymentLayer } from "../src/deployment/load-layer.ts";
import { createMemoryMap } from "../src/persistence/durable-map.ts";
import {
  CapabilityUnsupportedError,
  supportsDirectExecution,
  type AgentComputerProfile,
  type ExecResult,
  type Sandbox,
  type SandboxHandle,
} from "../src/sandbox/sandbox.ts";
import { createSandboxRouter } from "../src/sandbox/sandbox-routing.ts";
import { DIRECT_RUNTIME_PATH, directRequest, type ScopedCommand } from "../src/sandbox/scoped-exec.ts";
import { createSecretValueMasker } from "../src/security/secret-masking.ts";
import type { WorkspaceLayer } from "../src/types.ts";

function fakeBackend(name: string, direct: boolean): Sandbox {
  const profile: AgentComputerProfile = {
    backend: name,
    writablePersistence: "resident_disk",
    processSessions: true,
    directExecution: direct,
  };
  const base: Partial<Sandbox> = {
    profile,
    async provision(): Promise<SandboxHandle> {
      return { id: name, rootDir: `/${name}/workspace`, backend: name };
    },
    async run(): Promise<ExecResult> {
      return { stdout: name, stderr: "", code: 0, timedOut: false };
    },
    async teardown(): Promise<void> {},
    async readFile(): Promise<string | null> {
      return null;
    },
    async writeFile(): Promise<void> {},
    async writeFileBytes(): Promise<void> {},
    async readFileBytes(): Promise<Uint8Array | null> {
      return null;
    },
    async listDir(): Promise<string[]> {
      return [];
    },
    async removeDir(): Promise<void> {},
  };
  if (direct) {
    base.runDirect = async (): Promise<ExecResult> => ({ stdout: name, stderr: "", code: 0, timedOut: false });
  }
  return base as Sandbox;
}

function layers(scopeId: string): WorkspaceLayer[] {
  return [{ scopeId: scopeId as WorkspaceLayer["scopeId"], mountPath: "/", mode: "rw" }];
}

test("directRequest enforces descriptor executable, confined cwd, and explicit env allowlists", () => {
  const command: ScopedCommand = {
    argv: ["/usr/local/bin/tool", "literal ; && $(echo no)"],
    executablePath: "/usr/local/bin/tool",
    allowedEnvKeys: ["PUBLIC_URL", "TOKEN"],
  };
  const request = directRequest("/workspace", command, {
    env: { PUBLIC_URL: "https://example.test", TOKEN: "secret" },
    dynamicEnv: { AGENT_API_TOKEN: "cap" },
    cwd: "subdir",
    stdin: "literal\n",
    timeoutMs: 100,
    stdoutMaxBytes: 7,
    stderrMaxBytes: 8,
  });
  assert.deepEqual(request.argv, command.argv);
  assert.equal(request.cwd, "/workspace/subdir");
  assert.deepEqual(request.env, {
    PATH: DIRECT_RUNTIME_PATH,
    PUBLIC_URL: "https://example.test",
    TOKEN: "secret",
    AGENT_API_TOKEN: "cap",
  });
  assert.deepEqual(request.dynamicEnvKeys, ["AGENT_API_TOKEN"]);
  assert.deepEqual(request.allowedEnvKeys, ["PUBLIC_URL", "TOKEN"]);
  assert.equal(Buffer.from(request.stdin ?? []).toString(), "literal\n");
  assert.equal(request.timeoutMs, 100);
  assert.equal(request.stdoutMaxBytes, 7);
  assert.equal(request.stderrMaxBytes, 8);
  assert.throws(() => directRequest("/workspace", { argv: ["tool"] }), /absolute/);
  assert.throws(() => directRequest("/workspace", command, { env: { PUBLIC_URL: "x", UNKNOWN: "y" } }), /not allowed/);
  assert.throws(
    () => directRequest("/workspace", { ...command, allowedEnvKeys: ["AGENT_TOKEN"] }, { env: { AGENT_TOKEN: "x" } }),
    /reserved/,
  );
  assert.throws(
    () => directRequest("/workspace", { ...command, allowedEnvKeys: ["PATH"] }, { env: { PATH: "/tmp" } }),
    /runtime-owned/,
  );
  assert.throws(
    () => directRequest("/workspace", command, { dynamicEnv: { AGENT_UNKNOWN: "x" } }),
    /unknown dynamic key/,
  );
  assert.throws(() => directRequest("/workspace", command, { cwd: "../outside" }), /stay inside/);
});

test("deployment descriptors own complete per-executable command environment keys", () => {
  const descriptor = parseToolDescriptor(
    JSON.stringify({ id: "acmecli", commandEnv: ["PUBLIC_URL", "TOKEN"], install: { binary: "acme" } }),
    "tool.json",
  );
  assert.deepEqual(descriptor.commandEnv, ["PUBLIC_URL", "TOKEN"]);
  assert.throws(
    () => parseToolDescriptor(JSON.stringify({ id: "acmecli", commandEnv: ["AGENT_TOKEN"] }), "tool.json"),
    /reserved/,
  );
  assert.throws(
    () => parseToolDescriptor(JSON.stringify({ id: "acmecli", commandEnv: ["PATH"] }), "tool.json"),
    /non-reserved/,
  );
  assert.throws(
    () => parseToolDescriptor(JSON.stringify({ id: "acmecli", commandEnv: ["TOKEN", "TOKEN"] }), "tool.json"),
    /duplicate/,
  );
  const layer = resolvedDeploymentLayer("/layer", [descriptor]);
  assert.deepEqual(layer.commandEnvByExecutable, { acme: ["PUBLIC_URL", "TOKEN"] });
  assert.deepEqual(layer.directTools, [{ service: "acmecli", binary: "acme", roots: [], directOnly: true }]);
  const brokered = parseToolDescriptor(
    JSON.stringify({
      id: "awscli",
      install: { binary: "aws" },
      auth: {
        check: "aws sts get-caller-identity",
        reauth: "aws sso login",
        credentialPaths: [],
        broker: {
          kind: "aws-role",
          roleArnEnv: "AWSCLI_ROLE_ARN",
          region: "us-west-2",
          sessionActions: ["execute-api:Invoke"],
        },
      },
    }),
    "brokered-tool.json",
  );
  const brokeredLayer = resolvedDeploymentLayer("/layer", [brokered]);
  assert.deepEqual(brokeredLayer.commandEnvByExecutable.aws, [
    "AWS_ACCESS_KEY_ID",
    "AWS_SECRET_ACCESS_KEY",
    "AWS_SESSION_TOKEN",
    "AWS_REGION",
    "AWS_DEFAULT_REGION",
  ]);
  assert.deepEqual(brokeredLayer.directTools, [{ service: "awscli", binary: "aws", roots: [], directOnly: false }]);
  const publicOutput = createSecretValueMasker({ API_TOKEN: "token-value" })("https://example.test:993 token-value");
  assert.equal(publicOutput, "https://example.test:993 <redacted:API_TOKEN>");
  assert.throws(
    () => resolvedDeploymentLayer("/layer", [descriptor, { ...descriptor, id: "other" }]),
    /conflicting direct tools for executable/,
  );
});

test("routing exposes direct execution only when a backend implements it and refuses unsupported routes", async () => {
  const routes = createMemoryMap<{ backend: "sprites" | "aws" }>();
  await routes.put("scope:sprites", { backend: "sprites" });
  const router = createSandboxRouter({
    backends: { aws: fakeBackend("aws", true), sprites: fakeBackend("sprites", false) },
    routes,
    defaultBackend: "aws",
  });
  assert.ok(router.runDirect);
  assert.equal(supportsDirectExecution(fakeBackend("sprites", false)), false);
  const handle = await router.provision(layers("scope:sprites"));
  await assert.rejects(
    async () => router.runDirect!(handle, { argv: ["/usr/local/bin/tool"] }),
    (error: unknown) => error instanceof CapabilityUnsupportedError,
  );
});
