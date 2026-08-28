import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CONFIG_FILENAME, loadConfigAt } from "../src/config.ts";
import { dockerUp } from "../src/backends/docker.ts";

function makeDeployment(config: Record<string, unknown>, setup: (dir: string) => void = () => {}): string {
  const dir = mkdtempSync(join(tmpdir(), "qm-wiring-"));
  writeFileSync(
    join(dir, CONFIG_FILENAME),
    JSON.stringify({
      contract: 1,
      orgId: "wiretest",
      publicUrl: "http://localhost:8080",
      target: "docker",
      services: ["core"],
      sandbox: {
        app: "wiretest-sandboxes",
        image:
          "registry.fly.io/wiretest-sandboxes@sha256:1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a",
      },
      ...config,
    }),
  );
  setup(dir);
  return dir;
}

function sandboxLayer(dir: string): void {
  mkdirSync(join(dir, "sandbox", "tools", "example-tool"), { recursive: true });
  writeFileSync(join(dir, "sandbox", "tools", "example-tool", "tool.json"), JSON.stringify({ id: "example-tool" }));
  writeFileSync(join(dir, "sandbox", "tools", "example-tool", "example-tool"), "#!/usr/bin/env bash\necho hi\n");
  chmodSync(join(dir, "sandbox", "tools", "example-tool", "example-tool"), 0o755);
  mkdirSync(join(dir, "sandbox", "skills", "greet"), { recursive: true });
  writeFileSync(join(dir, "sandbox", "skills", "greet", "SKILL.md"), "---\nname: greet\ndescription: x\n---\nbody\n");
}

async function plan(configDir: string, opts: { sandboxDir?: string } = {}): Promise<string> {
  const xdg = mkdtempSync(join(tmpdir(), "qm-xdg-"));
  const prevXdg = process.env.XDG_CONFIG_HOME;
  process.env.XDG_CONFIG_HOME = xdg;
  const lines: string[] = [];
  const log = console.log,
    warn = console.warn;
  console.log = (...a: unknown[]): void => void lines.push(a.join(" "));
  console.warn = (...a: unknown[]): void => void lines.push(a.join(" "));
  try {
    const { config } = loadConfigAt(join(configDir, CONFIG_FILENAME));
    await dockerUp(config, configDir, { dryRun: true, ...(opts.sandboxDir ? { sandboxDir: opts.sandboxDir } : {}) });
  } finally {
    console.log = log;
    console.warn = warn;
    if (prevXdg === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = prevXdg;
    rmSync(xdg, { recursive: true, force: true });
  }
  return lines.join("\n").replace(/\x1b\[[0-9;]*m/g, "");
}

test("local sandbox dry-run derives a deployment-scoped runnable image", async () => {
  const dir = makeDeployment({ sandbox: { backend: "local" } });
  try {
    const out = await plan(dir);
    assert.match(out, /sandbox: local image qm-wiretest-sandbox-local:latest/);
    assert.match(out, /LOCAL_SANDBOX_IMAGE/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the deployment's sandbox/ skills + tools wire into the core via DEPLOYMENT_LAYER", async () => {
  const dir = makeDeployment({}, sandboxLayer);
  try {
    const out = await plan(dir);
    assert.match(out, /DEPLOYMENT_LAYER/, "core env advertises DEPLOYMENT_LAYER");
    assert.match(out, new RegExp(`${join(dir, "sandbox")} → /layer \\(skills, tools\\)`));
    assert.doesNotMatch(
      out,
      /PLUGIN_SKILLS_DIRS/,
      "layer skills seed via the DEPLOYMENT_LAYER store, not PLUGIN_SKILLS_DIRS (which would replace the image's plugin defaults)",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a bare deployment sets no DEPLOYMENT_LAYER and reports an empty layer", async () => {
  const dir = makeDeployment({});
  try {
    const out = await plan(dir);
    assert.doesNotMatch(out, /DEPLOYMENT_LAYER/);
    assert.match(out, /no skills\/ or tools\/ in/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("--sandbox-dir sources the layer from a shared dir while config stays in the deployment dir", async () => {
  const dir = makeDeployment({});
  const shared = mkdtempSync(join(tmpdir(), "qm-shared-"));
  sandboxLayer(shared);
  try {
    const out = await plan(dir, { sandboxDir: join(shared, "sandbox") });
    assert.match(out, new RegExp(`${join(shared, "sandbox")} → /layer`));
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(shared, { recursive: true, force: true });
  }
});

test("sandbox.app/env/secretEnv become the core's FLY_* + FLY_RESIDENT_ENV_* env", async () => {
  const dir = makeDeployment(
    {
      sandbox: {
        app: "wire-sandboxes",
        image: "registry.fly.io/wire-sandboxes@sha256:1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a",
        env: { TZ: "UTC" },
        secretEnv: ["COMPANY_API_TOKEN"],
      },
    },
    (d) => writeFileSync(join(d, ".env"), "COMPANY_API_TOKEN=sek-ret\n"),
  );
  try {
    const out = await plan(dir);
    assert.match(out, /FLY_SANDBOX_APP_NAME/);
    assert.match(out, /FLY_BASE_IMAGE/);
    assert.match(out, /FLY_RESIDENT_ENV_TZ/);
    assert.match(out, /FLY_RESIDENT_ENV_COMPANY_API_TOKEN/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a missing secretEnv value is warned, not invented", async () => {
  const dir = makeDeployment({
    sandbox: {
      app: "s",
      image: "registry.fly.io/s@sha256:1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a",
      secretEnv: ["NOPE_TOKEN"],
    },
  });
  try {
    const out = await plan(dir);
    assert.match(out, /sandbox.secretEnv "NOPE_TOKEN" has no value/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("model → PI_MODEL and host ports follow the offset map (core+0, portal+1, web-ui+2, admin+3)", async () => {
  const dir = makeDeployment({ model: "claude-opus-4-8", services: ["core", "portal", "web-ui", "admin"] });
  try {
    const out = await plan(dir);
    assert.match(out, /PI_MODEL/);
    assert.match(out, /host :8080/);
    assert.match(out, /host :8081/);
    assert.match(out, /host :8082/);
    assert.match(out, /host :8083/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("QM_BASE_PORT overrides the host port base for one run", async () => {
  const dir = makeDeployment({ services: ["core"] });
  const prev = process.env.QM_BASE_PORT;
  process.env.QM_BASE_PORT = "9000";
  try {
    const out = await plan(dir);
    assert.match(out, /host :9000/);
  } finally {
    if (prev === undefined) delete process.env.QM_BASE_PORT;
    else process.env.QM_BASE_PORT = prev;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("source + image plugins both appear in the plan", async () => {
  const dir = makeDeployment({ plugins: [{ name: "linear", image: "ghcr.io/acme/linear:1" }] }, (d) => {
    mkdirSync(join(d, "plugins", "intercom"), { recursive: true });
    writeFileSync(join(d, "plugins", "intercom", "Dockerfile"), "FROM scratch\n");
  });
  try {
    const out = await plan(dir);
    assert.match(out, /plugin intercom: build plugins\/intercom\/Dockerfile/);
    assert.match(out, /plugin linear: pull ghcr\.io\/acme\/linear:1/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
