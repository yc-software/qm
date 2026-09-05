import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { CONFIG_FILENAME, loadConfigAt, type QmConfig } from "../src/config.ts";
import { dockerServiceEnv } from "../src/backends/docker.ts";
import { derivedTomlFor, derivedPluginTomlFor } from "../src/backends/fly.ts";
import { discoverPlugins } from "../src/plugins.ts";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

const BASE = {
  contract: 1,
  orgId: "acme",
  publicUrl: "http://localhost:8080",
  target: "docker",
  services: ["core", "web-ui", "admin", "portal"],
};

function withConfig(extra: Record<string, unknown>, fn: (path: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), "qm-portal-path-"));
  try {
    const path = join(dir, CONFIG_FILENAME);
    writeFileSync(path, JSON.stringify({ ...BASE, ...extra }));
    fn(path);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const loadPlugins = (plugins: unknown[]): QmConfig => {
  let config!: QmConfig;
  withConfig({ plugins }, (path) => {
    config = loadConfigAt(path).config;
  });
  return config;
};

test("portalPath mounts a plugin surface under the portal on the docker target", () => {
  const config = loadPlugins([{ name: "reports", image: "ghcr.io/acme/reports:1", portalPath: "reports" }]);
  assert.equal(config.plugins[0]?.portalPath, "reports");
  const portal = dockerServiceEnv(config, "portal");
  assert.equal(portal.PORTAL_PLUGIN_UPSTREAMS, "reports=http://reports:8080");
});

test("a plugin without portalPath adds nothing to the portal's environment", () => {
  const config = loadPlugins([{ name: "reports", image: "ghcr.io/acme/reports:1" }]);
  assert.equal(dockerServiceEnv(config, "portal").PORTAL_PLUGIN_UPSTREAMS, undefined);
});

test("the mounted surface is told the prefix the portal strips", () => {
  const config = loadPlugins([{ name: "reports", image: "ghcr.io/acme/reports:1", portalPath: "monthly" }]);
  const dir = mkdtempSync(join(tmpdir(), "qm-portal-path-plugins-"));
  try {
    const { plugins, errors } = discoverPlugins(dir, config);
    assert.deepEqual(errors, []);
    assert.equal(plugins[0]?.portalPath, "monthly");
    const toml = derivedPluginTomlFor({ ...config, target: "fly", appPrefix: "acme-stack" } as QmConfig, plugins[0]!);
    assert.match(toml, /^\s*PORTAL_BASE_PATH = "\/monthly"$/m);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the fly target points the portal at the plugin's own app over 6PN", () => {
  const config = {
    ...loadPlugins([{ name: "reports", image: "ghcr.io/acme/reports:1", portalPath: "reports" }]),
    target: "fly",
    appPrefix: "acme-stack",
    region: "ord",
    flyOrg: "acme-org",
    publicUrl: "https://acme.invalid",
    sandbox: { app: "acme-sandboxes" },
  } as QmConfig;
  const portal = derivedTomlFor(config, "portal", repoRoot);
  assert.match(portal, /^\s*PORTAL_PLUGIN_UPSTREAMS = "reports=http:\/\/acme-stack-reports\.internal:8080"$/m);
});

test("portalPath is refused when it would shadow a route the portal answers itself", () => {
  for (const portalPath of ["admin", "auth", "web-ui", "v1", "healthz", "d", "deployments", "idp", "connect", "drop"]) {
    withConfig({ plugins: [{ name: "reports", image: "x:1", portalPath }] }, (path) =>
      assert.throws(() => loadConfigAt(path), /is a portal route/, `${portalPath} must be refused`),
    );
  }
});

test("portalPath must be one lowercase path segment", () => {
  for (const portalPath of ["Reports", "a/b", "..", "", "-x", "x-", "a b"]) {
    withConfig({ plugins: [{ name: "reports", image: "x:1", portalPath }] }, (path) =>
      assert.throws(() => loadConfigAt(path), /single lowercase DNS label/, `${portalPath} must be refused`),
    );
  }
  withConfig({ plugins: [{ name: "reports", image: "x:1", portalPath: 1 }] }, (path) =>
    assert.throws(() => loadConfigAt(path), /portalPath must be a string/),
  );
});

test("a leading or trailing slash is accepted and normalised away", () => {
  const config = loadPlugins([{ name: "reports", image: "x:1", portalPath: "/reports/" }]);
  assert.equal(config.plugins[0]?.portalPath, "reports");
});

test("two plugins cannot claim the same portal path", () => {
  withConfig(
    {
      plugins: [
        { name: "reports", image: "x:1", portalPath: "shared" },
        { name: "charts", image: "y:1", portalPath: "shared" },
      ],
    },
    (path) => assert.throws(() => loadConfigAt(path), /already used by plugin "reports"/),
  );
});

test("portalPath without the portal service is a configuration error, not a silent no-op", () => {
  withConfig({ services: ["core"], plugins: [{ name: "reports", image: "x:1", portalPath: "reports" }] }, (path) =>
    assert.throws(() => loadConfigAt(path), /needs "portal" in "services"/),
  );
});

test("PORTAL_BASE_PATH is the target's to set, not the operator's", () => {
  withConfig(
    { plugins: [{ name: "reports", image: "x:1", portalPath: "reports", env: { PORTAL_BASE_PATH: "/elsewhere" } }] },
    (path) => assert.throws(() => loadConfigAt(path), /is managed by the deployment target/),
  );
});
