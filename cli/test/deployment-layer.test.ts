import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash, createHmac } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CONFIG_FILENAME, loadConfigInDir, type QmConfig } from "../src/config.ts";
import { currentDeploymentLayerState, deploymentLayerBundle, syncDeploymentLayer } from "../src/deployment-layer.ts";
import { dockerDeploymentLayerTransport } from "../src/backends/docker.ts";
import { flyDeploymentLayerTransport } from "../src/backends/fly.ts";
import { awsDeploymentLayerTransport } from "../src/backends/aws.ts";
import { expectedDescriptors, runConformance } from "../src/commands/conformance.ts";

const SECRET = "conformance-test-secret";

const PINNED_SANDBOX_IMAGE = `registry.fly.io/acme-sandboxes@sha256:${"b".repeat(64)}`;

function writeLayer(dir: string): void {
  mkdirSync(join(dir, "sandbox", "skills", "a"), { recursive: true });
  mkdirSync(join(dir, "sandbox", "skills", "a-b"), { recursive: true });
  writeFileSync(join(dir, "sandbox", "skills", "a", "SKILL.md"), "---\nname: a\ndescription: skill a\n---\nbody a\n");
  writeFileSync(
    join(dir, "sandbox", "skills", "a-b", "SKILL.md"),
    "---\nname: a-b\ndescription: skill a-b\n---\nbody a-b\n",
  );
  mkdirSync(join(dir, "sandbox", "tools", "t"), { recursive: true });
  writeFileSync(
    join(dir, "sandbox", "tools", "t", "tool.json"),
    JSON.stringify({ install: { binary: "t" }, advertise: "runs t", id: "t" }),
  );
  writeFileSync(join(dir, "sandbox", "tools", "t", "t"), "#!/usr/bin/env bash\necho hi\n");
  chmodSync(join(dir, "sandbox", "tools", "t", "t"), 0o755);
}

function coreNormalizedHash(dir: string): string {
  const skillFiles = [
    { path: "skills/a/SKILL.md", content: readFileSync(join(dir, "sandbox", "skills", "a", "SKILL.md"), "utf8") },
    { path: "skills/a-b/SKILL.md", content: readFileSync(join(dir, "sandbox", "skills", "a-b", "SKILL.md"), "utf8") },
  ].reverse();
  const tools = [
    { path: "tools/t/tool.json", content: readFileSync(join(dir, "sandbox", "tools", "t", "tool.json"), "utf8") },
  ];
  const order = (a: { path: string }, b: { path: string }): number => a.path.localeCompare(b.path);
  const bundle = { contract: 1, tools: tools.sort(order), skills: skillFiles.sort(order) };
  return createHash("sha256").update(JSON.stringify(bundle)).digest("hex");
}

test("the CLI bundle hashes byte-identically to the core's full-path normalization (a vs a-b siblings)", () => {
  const dir = mkdtempSync(join(tmpdir(), "qm-layer-"));
  try {
    writeLayer(dir);
    const bundle = deploymentLayerBundle(join(dir, "sandbox"));
    assert.deepEqual(
      bundle.skills.map((file) => file.path),
      ["skills/a-b/SKILL.md", "skills/a/SKILL.md"],
      "full-path order, not per-directory walk order",
    );
    const cliHash = createHash("sha256").update(JSON.stringify(bundle)).digest("hex");
    assert.equal(cliHash, coreNormalizedHash(dir));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("expectedDescriptors canonicalizes tool.json through the parser (key order never matters)", () => {
  const dir = mkdtempSync(join(tmpdir(), "qm-layer-"));
  try {
    writeLayer(dir);
    const descriptors = expectedDescriptors(deploymentLayerBundle(join(dir, "sandbox")));
    assert.deepEqual(descriptors, [{ id: "t", advertise: "runs t", install: { binary: "t" } }]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the deployment layer sync rejects a bundle over the core's 1 MB limit before any request", async () => {
  const dir = mkdtempSync(join(tmpdir(), "qm-layer-big-"));
  try {
    mkdirSync(join(dir, "sandbox", "skills", "big"), { recursive: true });
    writeFileSync(
      join(dir, "sandbox", "skills", "big", "SKILL.md"),
      `---\nname: big\ndescription: big\n---\n${"x".repeat(1_100_000)}\n`,
    );
    const config: QmConfig = {
      contract: 1,
      orgId: "acme",
      publicUrl: "http://localhost:8080",
      target: "docker",
      services: ["core"],
      plugins: [],
      skills: [],
      env: {},
      imageOverrides: {},
      sandbox: { app: "acme-sandboxes", image: PINNED_SANDBOX_IMAGE },
    };
    process.env.CORE_SIGNING_SECRET = SECRET;
    try {
      await assert.rejects(
        () =>
          syncDeploymentLayer({
            config,
            transport: dockerDeploymentLayerTransport,
            configDir: dir,
            sandboxDir: join(dir, "sandbox"),
          }),
        /1 MB/,
      );
    } finally {
      delete process.env.CORE_SIGNING_SECRET;
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a missing sandbox directory skips sync instead of replacing the deployed layer with empty", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "qm-layer-missing-"));
  const lines: string[] = [];
  t.mock.method(console, "log", (...parts: unknown[]) => void lines.push(parts.join(" ")));
  try {
    await syncDeploymentLayer({
      config: makeConfig("http://example.invalid"),
      transport: dockerDeploymentLayerTransport,
      configDir: dir,
      sandboxDir: join(dir, "sandbox"),
    });
    assert.ok(lines.some((line) => /skipped \(no sandbox directory/.test(line)));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

interface CapturedRequest {
  method: string;
  url: string;
  timestamp: string;
  signature: string;
  body: string;
}

interface StubServer {
  close(done: () => void): void;
}

function startCoreStub(
  response: () => { status?: number; body: string },
  captured: CapturedRequest[],
): Promise<{ server: StubServer; port: number }> {
  const previous = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
    const headers = new Headers(init?.headers);
    captured.push({
      method: init?.method ?? "GET",
      url: url.pathname + url.search,
      timestamp: headers.get("x-timestamp") ?? "",
      signature: headers.get("x-signature") ?? "",
      body: typeof init?.body === "string" ? init.body : "",
    });
    const result = response();
    return new Response(result.body, { status: result.status ?? 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  return Promise.resolve({
    port: 43119,
    server: {
      close(done): void {
        globalThis.fetch = previous;
        done();
      },
    },
  });
}

function makeConfig(publicUrl: string): QmConfig {
  return {
    contract: 1,
    orgId: "acme",
    publicUrl,
    target: "docker",
    services: ["core"],
    plugins: [],
    skills: [],
    env: {},
    imageOverrides: {},
    sandbox: { app: "acme-sandboxes", image: PINNED_SANDBOX_IMAGE },
  };
}

async function withEnv<T>(vars: Record<string, string | undefined>, fn: () => Promise<T>): Promise<T> {
  const saved = Object.fromEntries(Object.keys(vars).map((name) => [name, process.env[name]]));
  for (const [name, value] of Object.entries(vars)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  try {
    return await fn();
  } finally {
    for (const [name, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
}

async function freeUnboundPort(): Promise<number> {
  const { server, port } = await startCoreStub(() => ({ body: "{}" }), []);
  await new Promise<void>((resolve) => server.close(resolve));
  return port;
}

test("the docker sync PUTs the bundle to the base port with verifiable v0 HMAC signing headers", async () => {
  const dir = mkdtempSync(join(tmpdir(), "qm-layer-sync-"));
  const captured: CapturedRequest[] = [];
  const { server, port } = await startCoreStub(
    () => ({ body: JSON.stringify({ version: 3, contentHash: "abc123" }) }),
    captured,
  );
  try {
    writeLayer(dir);
    writeFileSync(join(dir, ".env"), `CORE_SIGNING_SECRET=${SECRET}\n`);
    await withEnv({ CORE_SIGNING_SECRET: "wrong-ambient-secret", QM_BASE_PORT: String(port) }, () =>
      syncDeploymentLayer({
        config: makeConfig("http://example.invalid"),
        transport: dockerDeploymentLayerTransport,
        configDir: dir,
        sandboxDir: join(dir, "sandbox"),
      }),
    );
    assert.equal(captured.length, 1);
    const request = captured[0]!;
    assert.equal(request.method, "PUT");
    assert.equal(request.url, "/v1/deployment-layer");
    assert.equal(request.body, JSON.stringify(deploymentLayerBundle(join(dir, "sandbox"))));
    const expected = createHmac("sha256", SECRET)
      .update(`v0:${request.timestamp}:PUT\n/v1/deployment-layer\n${request.body}`)
      .digest("hex");
    assert.equal(request.signature, `v0=${expected}`);
  } finally {
    await new Promise<void>((resolve) => server.close(resolve));
    rmSync(dir, { recursive: true, force: true });
  }
});

test("conformance passes against a live core: base-port override, signed request, canonical hash + descriptors", async () => {
  const dir = mkdtempSync(join(tmpdir(), "qm-conf-"));
  const captured: CapturedRequest[] = [];
  const bundle = (() => {
    writeLayer(dir);
    return deploymentLayerBundle(join(dir, "sandbox"));
  })();
  const contentHash = createHash("sha256").update(JSON.stringify(bundle)).digest("hex");
  const { server, port } = await startCoreStub(
    () => ({
      body: JSON.stringify({
        contentHash,
        status: "applied",
        runtimeContentHash: contentHash,
        resolved: { tools: [{ install: { binary: "t" }, advertise: "runs t", id: "t" }] },
      }),
    }),
    captured,
  );
  try {
    writeFileSync(
      join(dir, CONFIG_FILENAME),
      JSON.stringify({
        contract: 1,
        orgId: "acme",
        publicUrl: "http://localhost:8080",
        target: "docker",
        services: ["core"],
        basePort: 1,
        sandbox: { app: "acme-sandboxes", image: PINNED_SANDBOX_IMAGE },
      }),
    );
    await withEnv({ CORE_SIGNING_SECRET: SECRET, QM_BASE_PORT: String(port) }, async () => {
      const log = console.log;
      console.log = (): void => {};
      try {
        await runConformance(
          { config: loadConfigInDir(dir).config, configDir: dir, sandboxDir: join(dir, "sandbox"), target: "docker" },
          { runtime: true },
        );
      } finally {
        console.log = log;
      }
    });
    assert.equal(captured.length, 1);
    const request = captured[0]!;
    assert.equal(request.method, "GET");
    assert.equal(request.url, "/v1/deployment-layer");
    assert.match(request.timestamp, /^\d+$/, "x-timestamp is unix seconds");
    const expected = createHmac("sha256", SECRET)
      .update(`v0:${request.timestamp}:GET\n/v1/deployment-layer\n`)
      .digest("hex");
    assert.equal(request.signature, `v0=${expected}`, "v0 HMAC over METHOD\\npath\\nbody");
  } finally {
    await new Promise<void>((resolve) => server.close(resolve));
    rmSync(dir, { recursive: true, force: true });
  }
});

test("conformance fails when the stored layer matches but the core still serves a previous resolved layer", async () => {
  const dir = mkdtempSync(join(tmpdir(), "qm-conf-"));
  const bundle = (() => {
    writeLayer(dir);
    return deploymentLayerBundle(join(dir, "sandbox"));
  })();
  const contentHash = createHash("sha256").update(JSON.stringify(bundle)).digest("hex");
  const { server, port } = await startCoreStub(
    () => ({
      body: JSON.stringify({
        contentHash,
        status: "degraded",
        runtimeContentHash: "0000000000000000000000000000000000000000000000000000000000000000",
        resolved: { tools: [{ install: { binary: "t" }, advertise: "runs t", id: "t" }] },
      }),
    }),
    [],
  );
  try {
    writeFileSync(
      join(dir, CONFIG_FILENAME),
      JSON.stringify({
        contract: 1,
        orgId: "acme",
        publicUrl: "http://localhost:8080",
        target: "docker",
        services: ["core"],
        basePort: 1,
        sandbox: { app: "acme-sandboxes", image: PINNED_SANDBOX_IMAGE },
      }),
    );
    await withEnv({ CORE_SIGNING_SECRET: SECRET, QM_BASE_PORT: String(port) }, async () => {
      const log = console.log;
      console.log = (): void => {};
      try {
        await assert.rejects(
          () =>
            runConformance(
              {
                config: loadConfigInDir(dir).config,
                configDir: dir,
                sandboxDir: join(dir, "sandbox"),
                target: "docker",
              },
              { runtime: true },
            ),
          /runtime\.layer-resolved: .*serving a previous resolved layer/,
        );
      } finally {
        console.log = log;
      }
    });
  } finally {
    await new Promise<void>((resolve) => server.close(resolve));
    rmSync(dir, { recursive: true, force: true });
  }
});

test("conformance reports a non-JSON layer response as a contract failure, not a raw SyntaxError", async () => {
  const dir = mkdtempSync(join(tmpdir(), "qm-conf-"));
  writeLayer(dir);
  const { server, port } = await startCoreStub(() => ({ body: "<html>bad gateway</html>" }), []);
  try {
    writeFileSync(
      join(dir, CONFIG_FILENAME),
      JSON.stringify({
        contract: 1,
        orgId: "acme",
        publicUrl: "http://localhost:8080",
        target: "docker",
        services: ["core"],
        basePort: 1,
        sandbox: { app: "acme-sandboxes", image: PINNED_SANDBOX_IMAGE },
      }),
    );
    await withEnv({ CORE_SIGNING_SECRET: SECRET, QM_BASE_PORT: String(port) }, async () => {
      const log = console.log;
      console.log = (): void => {};
      try {
        await assert.rejects(
          () =>
            runConformance(
              {
                config: loadConfigInDir(dir).config,
                configDir: dir,
                sandboxDir: join(dir, "sandbox"),
                target: "docker",
              },
              { runtime: true },
            ),
          /runtime\.layer-resolved: .*unparseable JSON/,
        );
      } finally {
        console.log = log;
      }
    });
  } finally {
    await new Promise<void>((resolve) => server.close(resolve));
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a successful memory-backed sync warns that the layer will not survive restart", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "qm-layer-sync-"));
  const warnings: string[] = [];
  t.mock.method(console, "warn", (...parts: unknown[]) => warnings.push(parts.join(" ")));
  const { server, port } = await startCoreStub(
    () => ({
      body: JSON.stringify({ version: 3, contentHash: "abc123", durable: false }),
    }),
    [],
  );
  try {
    writeLayer(dir);
    await withEnv({ CORE_SIGNING_SECRET: SECRET, QM_BASE_PORT: String(port) }, () =>
      syncDeploymentLayer({
        config: makeConfig("http://example.invalid"),
        transport: dockerDeploymentLayerTransport,
        configDir: dir,
        sandboxDir: join(dir, "sandbox"),
      }),
    );
    assert.ok(warnings.some((line) => /memory-backed.*will not survive a core restart/.test(line)));
  } finally {
    await new Promise<void>((resolve) => server.close(resolve));
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a publicUrl with a base path keeps it in the request path and the signed canonical string", async () => {
  const dir = mkdtempSync(join(tmpdir(), "qm-layer-sync-"));
  const captured: CapturedRequest[] = [];
  const { server, port } = await startCoreStub(() => ({ body: "{}" }), captured);
  try {
    writeLayer(dir);
    await withEnv({ CORE_SIGNING_SECRET: SECRET }, () =>
      syncDeploymentLayer({
        config: makeConfig(`http://127.0.0.1:${port}/base`),
        transport: awsDeploymentLayerTransport,
        configDir: dir,
        sandboxDir: join(dir, "sandbox"),
      }),
    );
    const request = captured[0]!;
    assert.equal(request.url, "/base/v1/deployment-layer");
    const expected = createHmac("sha256", SECRET)
      .update(`v0:${request.timestamp}:PUT\n/base/v1/deployment-layer\n${request.body}`)
      .digest("hex");
    assert.equal(request.signature, `v0=${expected}`);
  } finally {
    await new Promise<void>((resolve) => server.close(resolve));
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a non-2xx sync response is a CliError carrying the status and body", async () => {
  const dir = mkdtempSync(join(tmpdir(), "qm-layer-sync-"));
  const { server, port } = await startCoreStub(() => ({ status: 503, body: "core warming up" }), []);
  try {
    writeLayer(dir);
    await withEnv({ CORE_SIGNING_SECRET: SECRET, QM_BASE_PORT: String(port) }, () =>
      assert.rejects(
        () =>
          syncDeploymentLayer({
            config: makeConfig("http://example.invalid"),
            transport: dockerDeploymentLayerTransport,
            configDir: dir,
            sandboxDir: join(dir, "sandbox"),
          }),
        /deployment layer sync failed \(503\): core warming up/,
      ),
    );
  } finally {
    await new Promise<void>((resolve) => server.close(resolve));
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a 2xx response with unparseable JSON is a CliError with a body snippet, not a stack trace", async () => {
  const dir = mkdtempSync(join(tmpdir(), "qm-layer-sync-"));
  const { server, port } = await startCoreStub(() => ({ body: "<html>gateway</html>" }), []);
  try {
    writeLayer(dir);
    await withEnv({ CORE_SIGNING_SECRET: SECRET, QM_BASE_PORT: String(port) }, () =>
      assert.rejects(
        () =>
          syncDeploymentLayer({
            config: makeConfig("http://example.invalid"),
            transport: dockerDeploymentLayerTransport,
            configDir: dir,
            sandboxDir: join(dir, "sandbox"),
          }),
        /unparseable JSON: <html>gateway<\/html>/,
      ),
    );
  } finally {
    await new Promise<void>((resolve) => server.close(resolve));
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a 2xx response with an invalid durability shape fails instead of suppressing the warning", async () => {
  const dir = mkdtempSync(join(tmpdir(), "qm-layer-sync-"));
  let body = JSON.stringify({ version: 1, contentHash: "abc", durable: "false" });
  const { server, port } = await startCoreStub(() => ({ body }), []);
  try {
    writeLayer(dir);
    await withEnv({ CORE_SIGNING_SECRET: SECRET, QM_BASE_PORT: String(port) }, () =>
      assert.rejects(
        () =>
          syncDeploymentLayer({
            config: makeConfig("http://example.invalid"),
            transport: dockerDeploymentLayerTransport,
            configDir: dir,
            sandboxDir: join(dir, "sandbox"),
          }),
        /invalid JSON: durable must be a boolean/,
      ),
    );
    body = "null";
    await withEnv({ CORE_SIGNING_SECRET: SECRET, QM_BASE_PORT: String(port) }, () =>
      assert.rejects(
        () =>
          syncDeploymentLayer({
            config: makeConfig("http://example.invalid"),
            transport: dockerDeploymentLayerTransport,
            configDir: dir,
            sandboxDir: join(dir, "sandbox"),
          }),
        /invalid JSON: expected an object/,
      ),
    );
  } finally {
    await new Promise<void>((resolve) => server.close(resolve));
    rmSync(dir, { recursive: true, force: true });
  }
});

test("allowUnavailable swallows an unreachable core but NOT a local config error", async () => {
  const dir = mkdtempSync(join(tmpdir(), "qm-layer-sync-"));
  try {
    writeLayer(dir);
    const port = await freeUnboundPort();
    await withEnv({ CORE_SIGNING_SECRET: SECRET, QM_BASE_PORT: String(port) }, () =>
      syncDeploymentLayer({
        config: makeConfig("http://example.invalid"),
        transport: dockerDeploymentLayerTransport,
        configDir: dir,
        sandboxDir: join(dir, "sandbox"),
        allowUnavailable: true,
      }),
    );
    await withEnv({ CORE_SIGNING_SECRET: SECRET, QM_BASE_PORT: String(port) }, () =>
      assert.rejects(
        () =>
          syncDeploymentLayer({
            config: makeConfig("http://example.invalid"),
            transport: dockerDeploymentLayerTransport,
            configDir: dir,
            sandboxDir: join(dir, "sandbox"),
          }),
        /could not sync deployment layer/,
      ),
    );
    await withEnv({ CORE_SIGNING_SECRET: undefined, QM_BASE_PORT: String(port) }, () =>
      assert.rejects(
        () =>
          syncDeploymentLayer({
            config: makeConfig("http://example.invalid"),
            transport: dockerDeploymentLayerTransport,
            configDir: dir,
            sandboxDir: join(dir, "sandbox"),
            allowUnavailable: true,
          }),
        /CORE_SIGNING_SECRET is required/,
      ),
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

function fakeFly(dir: string, body: string): string {
  const bin = join(dir, "fake-fly.cjs");
  writeFileSync(bin, `#!/usr/bin/env node\nconst fs = require("node:fs");\n${body}\n`);
  chmodSync(bin, 0o755);
  return bin;
}

function flySyncOpts(dir: string, allowUnavailable?: boolean): Parameters<typeof syncDeploymentLayer>[0] {
  return {
    config: makeConfig("http://example.invalid"),
    transport: flyDeploymentLayerTransport,
    configDir: dir,
    sandboxDir: join(dir, "sandbox"),
    ...(allowUnavailable !== undefined ? { allowUnavailable } : {}),
  };
}

test("fly sync succeeds on the response marker, piping the exact bundle over stdin", async () => {
  const dir = mkdtempSync(join(tmpdir(), "qm-layer-fly-"));
  try {
    writeLayer(dir);
    const stdinLog = join(dir, "stdin.log");
    const argsLog = join(dir, "args.log");
    const bin = fakeFly(
      dir,
      [
        `fs.writeFileSync(${JSON.stringify(argsLog)}, JSON.stringify(process.argv.slice(2)));`,
        `fs.writeFileSync(${JSON.stringify(stdinLog)}, fs.readFileSync(0, "utf8"));`,
        `console.log('QM_LAYER_RESPONSE=' + JSON.stringify({ status: 200, body: JSON.stringify({ version: 7, contentHash: "abcdef123456" }) }));`,
      ].join("\n"),
    );
    await withEnv({ FLY_BIN: bin }, () => syncDeploymentLayer(flySyncOpts(dir)));
    assert.equal(
      readFileSync(stdinLog, "utf8"),
      JSON.stringify(deploymentLayerBundle(join(dir, "sandbox"))),
      "the full bundle reaches the remote script's stdin",
    );
    const args = JSON.parse(readFileSync(argsLog, "utf8")) as string[];
    assert.deepEqual(args.slice(0, 4), ["ssh", "console", "-a", "acme-core"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a 202 degraded response is accepted and warns with the core's persisted-but-partial message", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "qm-layer-fly-degraded-"));
  const warnings: string[] = [];
  t.mock.method(console, "warn", (...parts: unknown[]) => void warnings.push(parts.join(" ")));
  try {
    writeLayer(dir);
    const bin = fakeFly(
      dir,
      `console.log('QM_LAYER_RESPONSE=' + JSON.stringify({ status: 202, body: JSON.stringify({ status: "degraded", version: 8, contentHash: "abc", durable: true, message: "skill collision" }) }));`,
    );
    await withEnv({ FLY_BIN: bin }, () => syncDeploymentLayer(flySyncOpts(dir)));
    assert.ok(warnings.some((line) => /persisted but only partially applied: skill collision/.test(line)));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a remote-script error (signing secret missing on core) is NOT deferrable as core-unreachable", async () => {
  const dir = mkdtempSync(join(tmpdir(), "qm-layer-fly-"));
  try {
    writeLayer(dir);
    const bin = fakeFly(
      dir,
      `console.log('QM_LAYER_ERROR=' + JSON.stringify({ message: "CORE_SIGNING_SECRET is not set on core" }));`,
    );
    await withEnv({ FLY_BIN: bin }, () =>
      assert.rejects(
        () => syncDeploymentLayer(flySyncOpts(dir, true)),
        /could not sync deployment layer: .*CORE_SIGNING_SECRET is not set on core/,
      ),
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a remote connection failure (core process down inside the VM) IS deferrable", async () => {
  const dir = mkdtempSync(join(tmpdir(), "qm-layer-fly-"));
  try {
    writeLayer(dir);
    const bin = fakeFly(
      dir,
      `console.log('QM_LAYER_ERROR=' + JSON.stringify({ message: "fetch failed", code: "ECONNREFUSED" }));`,
    );
    await withEnv({ FLY_BIN: bin }, () => syncDeploymentLayer(flySyncOpts(dir, true)));
    await withEnv({ FLY_BIN: bin }, () =>
      assert.rejects(() => syncDeploymentLayer(flySyncOpts(dir)), /could not sync deployment layer/),
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a fly-ssh transport failure defers under allowUnavailable, but a missing app never does", async () => {
  const dir = mkdtempSync(join(tmpdir(), "qm-layer-fly-"));
  try {
    writeLayer(dir);
    const transport = fakeFly(dir, `console.error("Error: tunnel unavailable"); process.exit(1);`);
    await withEnv({ FLY_BIN: transport }, () => syncDeploymentLayer(flySyncOpts(dir, true)));
    const missingApp = fakeFly(dir, `console.error("Error: Could not find App 'acme-core'"); process.exit(1);`);
    await withEnv({ FLY_BIN: missingApp }, () =>
      assert.rejects(() => syncDeploymentLayer(flySyncOpts(dir, true)), /Fly app acme-core not found/),
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("junk files (.DS_Store, Thumbs.db, AppleDouble) are excluded from the bundle", () => {
  const dir = mkdtempSync(join(tmpdir(), "qm-layer-junk-"));
  try {
    writeLayer(dir);
    const clean = deploymentLayerBundle(join(dir, "sandbox"));
    writeFileSync(join(dir, "sandbox", "skills", "a", ".DS_Store"), Buffer.from([0x00, 0x01, 0x42, 0x75, 0x64, 0x31]));
    writeFileSync(join(dir, "sandbox", "skills", "a", "Thumbs.db"), Buffer.from([0xd0, 0xcf, 0x11, 0xe0]));
    writeFileSync(join(dir, "sandbox", "skills", "a", "._SKILL.md"), Buffer.from([0x00, 0x05, 0x16, 0x07]));
    assert.deepEqual(deploymentLayerBundle(join(dir, "sandbox")), clean);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("non-junk tools entries fail loudly unless they are directories with tool.json", () => {
  const dir = mkdtempSync(join(tmpdir(), "qm-layer-tools-shape-"));
  try {
    mkdirSync(join(dir, "sandbox", "tools"), { recursive: true });
    writeFileSync(join(dir, "sandbox", "tools", "README.md"), "not a tool\n");
    assert.throws(
      () => deploymentLayerBundle(join(dir, "sandbox")),
      /tools entry must be a directory containing tool\.json/,
    );
    rmSync(join(dir, "sandbox", "tools", "README.md"));
    mkdirSync(join(dir, "sandbox", "tools", "missing"));
    assert.throws(() => deploymentLayerBundle(join(dir, "sandbox")), /tool directory is missing tool\.json/);
    rmSync(join(dir, "sandbox", "tools", "missing"), { recursive: true });
    mkdirSync(join(dir, "sandbox", "tools", "linked"));
    writeFileSync(join(dir, "descriptor.json"), JSON.stringify({ id: "linked" }));
    symlinkSync(join(dir, "descriptor.json"), join(dir, "sandbox", "tools", "linked", "tool.json"));
    assert.throws(() => deploymentLayerBundle(join(dir, "sandbox")), /deployment layer file must be a regular file/);
    writeFileSync(join(dir, "sandbox", "tools", ".DS_Store"), "junk");
    rmSync(join(dir, "sandbox", "tools", "linked"), { recursive: true });
    assert.deepEqual(deploymentLayerBundle(join(dir, "sandbox")).tools, []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a core with no durable layer record bootstraps as empty regardless of its live source", async () => {
  const dir = mkdtempSync(join(tmpdir(), "qm-layer-boot-"));
  const captured: CapturedRequest[] = [];
  const { server } = await startCoreStub(
    () => ({
      body: JSON.stringify({
        contract: 1,
        version: 0,
        contentHash: null,
        source: "filesystem",
        resolved: { tools: [], skills: [] },
      }),
    }),
    captured,
  );
  try {
    await withEnv({ CORE_SIGNING_SECRET: SECRET }, async () => {
      const state = await currentDeploymentLayerState({
        config: makeConfig("http://localhost:8080"),
        transport: dockerDeploymentLayerTransport,
        configDir: dir,
      });
      assert.equal(state.body, JSON.stringify({ contract: 1, tools: [], skills: [] }));
      assert.equal(createHash("sha256").update(state.body).digest("hex"), state.contentHash);
      assert.equal(state.status, "applied");
      assert.equal(
        state.runtimeContentHash,
        null,
        "a bootstrap read must never claim the runtime applied it (skip-sync would wrongly skip)",
      );
      assert.equal(
        state.bootstrapped,
        true,
        "callers must be able to exclude the synthesized body from compensation restores",
      );
    });
    assert.equal(captured.length, 1);
  } finally {
    await new Promise<void>((resolve) => server.close(resolve));
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a durable record whose bundle is missing still fails the read", async () => {
  const dir = mkdtempSync(join(tmpdir(), "qm-layer-durable-"));
  const captured: CapturedRequest[] = [];
  const { server } = await startCoreStub(
    () => ({
      body: JSON.stringify({ contract: 1, version: 3, contentHash: "1234", source: "durable" }),
    }),
    captured,
  );
  try {
    await withEnv({ CORE_SIGNING_SECRET: SECRET }, async () => {
      await assert.rejects(
        currentDeploymentLayerState({
          config: makeConfig("http://localhost:8080"),
          transport: dockerDeploymentLayerTransport,
          configDir: dir,
        }),
        /did not return a restorable bundle/,
      );
    });
  } finally {
    await new Promise<void>((resolve) => server.close(resolve));
    rmSync(dir, { recursive: true, force: true });
  }
});
