import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const chart = fileURLToPath(new URL("../deploy/helm", import.meta.url));
const helm = process.env.HELM_BIN || "helm";
const helmAvailable = spawnSync(helm, ["version", "--short"]).status === 0;
if (process.env.CI) assert.ok(helmAvailable, "Install Helm 3 before running the chart regression tests in CI");
const options = { skip: !helmAvailable && "Helm 3 is required" };

type Resource = {
  kind: string;
  stringData?: Record<string, string>;
  metadata: { name: string; annotations?: Record<string, string> };
  spec: {
    replicas: number;
    selector?: Record<string, string>;
    strategy?: { type: string; rollingUpdate?: null };
    accessModes?: string[];
    storageClassName?: string;
    resources?: { requests: { storage: string } };
    ports?: { name: string; port: number; targetPort: number }[];
    rules?: { http: { paths: { backend: { service: { name: string; port: { number: number } } } }[] } }[];
    template: {
      spec: {
        terminationGracePeriodSeconds?: number;
        affinity?: {
          podAffinity: {
            requiredDuringSchedulingIgnoredDuringExecution: {
              topologyKey: string;
              labelSelector: { matchLabels: Record<string, string> };
            }[];
          };
        };
        securityContext?: { fsGroup: number };
        volumes?: { name: string; persistentVolumeClaim: { claimName: string } }[];
        containers: {
          image: string;
          command: string[];
          env: { name: string; value: string }[];
          ports: { containerPort: number; name: string }[];
          volumeMounts?: { name: string; mountPath: string }[];
          readinessProbe: { httpGet: { path: string; port: number } };
          livenessProbe: { httpGet: { path: string; port: number } };
          startupProbe?: { httpGet: { path: string; port: string }; failureThreshold: number };
        }[];
      };
    };
  };
};

function render(values: object = {}, explicitImages = true): Resource[] {
  const dir = mkdtempSync(join(tmpdir(), "qm-helm-test-"));
  try {
    const valuesFile = join(dir, "values.json");
    writeFileSync(valuesFile, JSON.stringify(values));
    const result = spawnSync(
      helm,
      ["template", "test", chart, ...(explicitImages ? ["--set", "image.tag=fixture"] : []), "-f", valuesFile],
      { encoding: "utf8" },
    );
    assert.equal(result.status, 0, result.stderr);
    writeFileSync(join(dir, "Chart.yaml"), "apiVersion: v2\nname: parser\nversion: 0.1.0\n");
    writeFileSync(join(dir, "rendered.yaml"), result.stdout);
    mkdirSync(join(dir, "templates"));
    writeFileSync(
      join(dir, "templates", "parse.yaml"),
      '{{- range splitList "\\n---\\n" (.Files.Get "rendered.yaml") }}\n---\n{{ . | fromYaml | toJson }}\n{{- end }}\n',
    );
    const parsed = spawnSync(helm, ["template", "parser", dir], { encoding: "utf8" });
    assert.equal(parsed.status, 0, parsed.stderr);
    return parsed.stdout
      .split("\n")
      .filter((line) => line.startsWith("{"))
      .map((line) => JSON.parse(line) as Resource);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function deployment(resources: Resource[], name = "edge") {
  const resource = resources.find((r) => r.kind === "Deployment" && r.metadata.name === `test-qm-${name}`);
  assert.ok(resource, `missing ${name} deployment`);
  return resource;
}

function container(resources: Resource[], name = "edge") {
  const result = deployment(resources, name).spec.template.spec.containers[0];
  assert.ok(result, `missing ${name} container`);
  return result;
}

function env(resources: Resource[], name = "edge") {
  return {
    ...resources.find((r) => r.kind === "Secret" && r.metadata.name === "test-qm-env")?.stringData,
    ...Object.fromEntries((container(resources, name).env ?? []).map((e) => [e.name, e.value])),
  };
}

const workloads = ["edge", "harness"] as const;

function service(resources: Resource[], name = "core") {
  const resource = resources.find((r) => r.kind === "Service" && r.metadata.name === `test-qm-${name}`);
  assert.ok(resource, `missing ${name} service`);
  return resource;
}

test("Helm requires an explicit compatible image and supports full digest references", options, () => {
  assert.throws(() => render({}, false), /services.core.imageRef.*image.tag/);
  const ref = `registry.example.com/qm/core@sha256:${"a".repeat(64)}`;
  const resources = render({ services: { core: { imageRef: ref }, "egress-proxy": { tag: "proxy-fixture" } } });
  for (const name of workloads) assert.equal(container(resources, name).image, ref);
  assert.equal(container(resources, "egress-proxy").image, "ghcr.io/yc-software/qm/egress-proxy:proxy-fixture");
  const byReference = render({ services: { core: { imageRef: ref }, "egress-proxy": { imageRef: ref } } }, false);
  for (const name of [...workloads, "egress-proxy"]) assert.equal(container(byReference, name).image, ref);
});

test("Helm runs edge, harness and egress-proxy only, from the core image", options, () => {
  const resources = render();
  assert.deepEqual(
    resources
      .filter((r) => r.kind === "Deployment")
      .map((r) => r.metadata.name)
      .sort(),
    ["test-qm-edge", "test-qm-egress-proxy", "test-qm-harness"],
  );
  assert.deepEqual(
    resources
      .filter((r) => r.kind === "Service")
      .map((r) => r.metadata.name)
      .sort(),
    ["test-qm-core", "test-qm-egress-proxy"],
  );
  assert.deepEqual(container(resources).command, ["node", "src/edge/main.ts"]);
  assert.deepEqual(container(resources, "harness").command, ["node", "src/harness/main.ts"]);
  for (const name of workloads) assert.equal(container(resources, name).image, "ghcr.io/yc-software/qm/core:fixture");
  assert.equal(service(resources).spec.selector?.["app.kubernetes.io/component"], "edge");
});

test("Helm runs the harness as an unexposed worker that drains before shutdown", options, () => {
  const resources = render({
    publicUrl: "https://qm.example.com",
    ingress: { enabled: true, hosts: ["qm.example.com"] },
  });
  const harness = deployment(resources, "harness");
  const main = container(resources, "harness");
  assert.equal(harness.spec.replicas, 1);
  assert.equal(harness.spec.template.spec.terminationGracePeriodSeconds, 300);
  assert.deepEqual(main.ports, [{ name: "http", containerPort: 8080 }]);
  assert.equal(main.readinessProbe.httpGet.path, "/readyz");
  assert.equal(main.readinessProbe.httpGet.port, 8080);
  assert.equal(main.livenessProbe.httpGet.path, "/healthz");
  assert.equal(main.livenessProbe.httpGet.port, 8080);
  assert.equal(main.startupProbe?.httpGet.path, "/readyz");
  const harnessEnv = env(resources, "harness");
  assert.equal(harnessEnv.PORT, "8080");
  assert.equal(harnessEnv.PUBLIC_WEB_URL, "https://qm.example.com");
  for (const key of ["PUBLIC_PORT", "PORTAL_PUBLIC_URL", "AUTH_EMBEDDED", "OIDC_ISSUER", "ADMIN_ENABLED"]) {
    assert.equal(harnessEnv[key], undefined, key);
  }
  assert.ok(
    !resources.some((r) => r.kind === "Service" && r.spec.selector?.["app.kubernetes.io/component"] === "harness"),
  );
  const backends = resources
    .filter((r) => r.kind === "Ingress")
    .flatMap((r) => r.spec.rules ?? [])
    .flatMap((rule) => rule.http.paths.map((path) => path.backend.service.name));
  assert.deepEqual(backends, ["test-qm-core"]);
  assert.equal(
    deployment(
      render({ services: { core: { harness: { replicas: 3, terminationGracePeriodSeconds: 600 } } } }),
      "harness",
    ).spec.template.spec.terminationGracePeriodSeconds,
    600,
  );
});

test("Helm serves the API and the embedded front door from the edge", options, () => {
  const resources = render({ publicUrl: "https://qm.example.com/" });
  const edge = container(resources);
  assert.deepEqual(edge.ports, [
    { name: "http", containerPort: 8080 },
    { name: "public", containerPort: 8000 },
  ]);
  assert.deepEqual(
    service(resources).spec.ports?.map((p) => [p.name, p.port, p.targetPort]),
    [
      ["http", 8080, 8080],
      ["public", 8000, 8000],
    ],
  );
  const edgeEnv = env(resources);
  for (const [key, value] of Object.entries({
    PORT: "8080",
    PUBLIC_PORT: "8000",
    ADMIN_ENABLED: "1",
    ADMIN_BASE_PATH: "/admin",
    PORTAL_PUBLIC_URL: "https://qm.example.com/",
    WEB_UI_PUBLIC_URL: "https://qm.example.com/",
    PUBLIC_WEB_URL: "https://qm.example.com/",
    AUTH_EMBEDDED: "1",
    AUTH_BROKER_UPSTREAM: "http://127.0.0.1:8099",
    AUTH_BROKER_PREFIX: "/idp",
    AUTH_ISSUER: "https://qm.example.com/idp",
    AUTH_CLIENT_ID: "qm-portal",
    AUTH_REDIRECT_URI: "https://qm.example.com/auth/callback",
  })) {
    assert.equal(edgeEnv[key], value, key);
  }
  assert.equal(edgeEnv.REQUIRE_SIGNED_PORTAL_IDENTITY, undefined);
  assert.ok(!Object.keys(edgeEnv).some((key) => key.startsWith("OIDC_")), "sign-in settings are tenant settings");
  for (const key of ["WEB_UI_UPSTREAM", "ADMIN_UPSTREAM", "CORE_API_URL"]) assert.equal(edgeEnv[key], undefined, key);
  assert.equal(env(render({ services: { admin: { enabled: false } } })).ADMIN_ENABLED, "0");
  const noAuth = env(render({ publicUrl: "https://qm.example.com", services: { auth: { enabled: false } } }));
  assert.equal(noAuth.PUBLIC_PORT, "8000");
  assert.equal(noAuth.AUTH_EMBEDDED, undefined);
  assert.equal(noAuth.OIDC_ISSUER, undefined);
});

test("Helm runs an API-only edge when the portal is disabled", options, () => {
  const off = { portal: { enabled: false }, auth: { enabled: false }, admin: { enabled: false } };
  const resources = render({ publicUrl: "https://qm.example.com", services: off });
  assert.deepEqual(container(resources).ports, [{ name: "http", containerPort: 8080 }]);
  assert.deepEqual(
    service(resources).spec.ports?.map((p) => p.name),
    ["http"],
  );
  const edgeEnv = env(resources);
  for (const key of ["PUBLIC_PORT", "PORTAL_PUBLIC_URL", "REQUIRE_SIGNED_PORTAL_IDENTITY", "AUTH_EMBEDDED"]) {
    assert.equal(edgeEnv[key], undefined, key);
  }
  for (const module of ["auth", "admin"] as const) {
    assert.throws(
      () => render({ services: { ...off, [module]: { enabled: true } } }),
      new RegExp(`${module} requires services.portal.enabled=true`),
    );
  }
});

test("Helm mounts a retained core PVC on co-located edge and harness pods with no overlap", options, () => {
  const resources = render({
    services: { core: { persistence: { enabled: true, size: "20Gi", storageClass: "block" } } },
  });
  const pvc = resources.find((r) => r.kind === "PersistentVolumeClaim");
  assert.ok(pvc);
  assert.equal(pvc.metadata.name, "test-qm-core-data");
  assert.equal(pvc.metadata.annotations?.["helm.sh/resource-policy"], "keep");
  assert.deepEqual(pvc.spec.accessModes, ["ReadWriteOnce"]);
  assert.equal(pvc.spec.storageClassName, "block");
  assert.equal(pvc.spec.resources?.requests.storage, "20Gi");
  for (const name of workloads) {
    const workload = deployment(resources, name);
    assert.equal(workload.spec.strategy?.type, "Recreate");
    assert.equal(workload.spec.strategy?.rollingUpdate, null);
    assert.equal(workload.spec.template.spec.securityContext?.fsGroup, 1000);
    assert.equal(workload.spec.template.spec.volumes?.[0]?.persistentVolumeClaim.claimName, pvc.metadata.name);
    assert.deepEqual(container(resources, name).volumeMounts, [{ name: "data", mountPath: "/data" }]);
    assert.equal(env(resources, name).DATA_DIR, "/data");
  }
  assert.equal(deployment(resources).spec.template.spec.affinity, undefined);
  const affinity = deployment(resources, "harness").spec.template.spec.affinity?.podAffinity
    .requiredDuringSchedulingIgnoredDuringExecution[0];
  assert.equal(affinity?.topologyKey, "kubernetes.io/hostname");
  assert.equal(affinity?.labelSelector.matchLabels["app.kubernetes.io/component"], "edge");
  for (const name of workloads) {
    assert.throws(
      () => render({ services: { core: { [name]: { replicas: 2 }, persistence: { enabled: true } } } }),
      /at most one replica/,
    );
  }
  assert.throws(
    () => render({ services: { core: { env: { DATA_DIR: "/wrong" }, persistence: { enabled: true } } } }),
    /DATA_DIR=\/data/,
  );
  const shared = render();
  for (const name of workloads) {
    assert.equal(deployment(shared, name).spec.strategy, undefined);
    assert.equal(deployment(shared, name).spec.template.spec.affinity, undefined);
  }
  assert.equal(deployment(render({ services: { core: { harness: { replicas: 4 } } } }), "harness").spec.replicas, 4);
});

test("Helm supports existing claims, default or empty storage class, and opting out", options, () => {
  const resources = render({ services: { core: { persistence: { enabled: true, existingClaim: "restored-data" } } } });
  assert.ok(!resources.some((r) => r.kind === "PersistentVolumeClaim"));
  for (const name of workloads) {
    assert.equal(
      deployment(resources, name).spec.template.spec.volumes?.[0]?.persistentVolumeClaim.claimName,
      "restored-data",
    );
  }
  for (const storageClass of [null, ""]) {
    const pvc = render({ services: { core: { persistence: { enabled: true, storageClass } } } }).find(
      (r) => r.kind === "PersistentVolumeClaim",
    );
    assert.ok(pvc);
    assert.equal(pvc.spec.storageClassName, storageClass === null ? undefined : "");
  }
  const disabled = render();
  assert.ok(!disabled.some((r) => r.kind === "PersistentVolumeClaim"));
  for (const name of workloads) assert.equal(deployment(disabled, name).spec.template.spec.volumes, undefined);
});

test("Helm preserves zero replicas including a stopped persistent core", options, () => {
  const resources = render({
    services: { core: { edge: { replicas: 0 }, harness: { replicas: 0 }, persistence: { enabled: true } } },
  });
  for (const name of workloads) assert.equal(deployment(resources, name).spec.replicas, 0);
});

test("Helm keeps process ports, probes, Services and upstreams consistent", options, () => {
  const resources = render({ services: { core: { port: 9090, publicPort: 9091 } } });
  for (const name of workloads) {
    assert.equal(env(resources, name).PORT, "9090");
    assert.equal(container(resources, name).ports[0]?.containerPort, 9090);
    assert.equal(container(resources, name).readinessProbe.httpGet.port, 9090);
    assert.equal(container(resources, name).livenessProbe.httpGet.port, 9090);
  }
  assert.equal(env(resources).PUBLIC_PORT, "9091");
  assert.equal(container(resources).ports[1]?.containerPort, 9091);
  assert.deepEqual(
    service(resources).spec.ports?.map((p) => [p.port, p.targetPort]),
    [
      [9090, 9090],
      [9091, 9091],
    ],
  );
  assert.equal(env(resources, "egress-proxy").CORE_API_URL, "http://test-qm-core.default.svc.cluster.local:9090");
  assert.throws(() => render({ services: { core: { env: { PORT: "9999" } } } }), /edge PORT conflicts/);
  assert.throws(
    () => render({ env: { PUBLIC_PORT: "9999" } }),
    /edge PUBLIC_PORT conflicts with services.core.publicPort/,
  );
  assert.throws(() => render({ services: { "egress-proxy": { port: 49000 } } }), /Envoy listener is fixed/);
});

test("Helm separates startup/readiness from liveness and allows probe overrides", options, () => {
  const resources = render();
  for (const name of workloads) {
    const main = container(resources, name);
    assert.equal(main.readinessProbe.httpGet.path, "/readyz");
    assert.equal(main.livenessProbe.httpGet.path, "/healthz");
    assert.equal(main.startupProbe?.httpGet.path, "/readyz");
    assert.equal(main.startupProbe?.httpGet.port, "http");
    assert.equal(main.startupProbe?.failureThreshold, 60);
  }
  const custom = render({ services: { core: { readinessPath: "/custom-ready", startupProbe: null } } });
  for (const name of workloads) {
    assert.equal(container(custom, name).readinessProbe.httpGet.path, "/custom-ready");
    assert.equal(container(custom, name).livenessProbe.httpGet.path, "/healthz");
    assert.equal(container(custom, name).startupProbe, undefined);
  }
});

test("Helm ingress targets the edge's front door or API port only", options, () => {
  for (const service of ["web-ui", "auth", "admin", "harness", "egress-proxy", "missing"]) {
    assert.throws(() => render({ ingress: { enabled: true, service } }), /ingress.service must be portal/);
  }
  assert.throws(
    () =>
      render({
        ingress: { enabled: true },
        services: { portal: { enabled: false }, auth: { enabled: false }, admin: { enabled: false } },
      }),
    /portal is disabled/,
  );
  for (const [target, port] of [
    ["portal", 8000],
    ["core", 8080],
  ] as const) {
    const ingress = render({ ingress: { enabled: true, service: target, hosts: ["qm.example.com"] } }).find(
      (r) => r.kind === "Ingress",
    );
    const backend = ingress?.spec.rules?.[0]?.http.paths[0]?.backend.service;
    assert.equal(backend?.name, "test-qm-core");
    assert.equal(backend?.port.number, port);
  }
});

test("Helm rejects conflicting settings across modules hosted by the edge", options, () => {
  assert.throws(
    () => render({ services: { portal: { env: { SHARED: "a" } }, admin: { env: { SHARED: "b" } } } }),
    /Conflicting SHARED settings in services hosted by edge/,
  );
  const merged = env(render({ services: { portal: { env: { SHARED: "a" } }, auth: { env: { SHARED: "a" } } } }));
  assert.equal(merged.SHARED, "a");
  assert.equal(env(render({ services: { admin: { env: { ONLY_EDGE: "1" } } } }), "harness").ONLY_EDGE, undefined);
});

function tenantImport(resources: Resource[]): { tenant: string; env: Record<string, string> } {
  const secret = resources.find((r) => r.kind === "Secret" && r.metadata.name === "test-qm-tenant-settings");
  assert.ok(secret?.stringData?.["settings.json"], "missing tenant settings secret");
  return JSON.parse(secret.stringData["settings.json"]) as { tenant: string; env: Record<string, string> };
}

const tenantSettings = (resources: Resource[]): Record<string, string> => tenantImport(resources).env;

test("Helm sends the configured tenant slug and refuses an invalid one", options, () => {
  assert.equal(tenantImport(render()).tenant, "main");
  assert.equal(tenantImport(render({ tenant: "acme" })).tenant, "acme");
  assert.throws(() => render({ tenant: "Acme" }), /tenant must be a tenant slug/);
});

test("Helm pushes sign-in and admin settings to the install tenant instead of any service env", options, () => {
  const resources = render({
    publicUrl: "https://qm.example.com",
    secretEnv: { AUTH_CLIENT_ID: "qm-portal", AUTH_CLIENT_SECRET: "client-secret" },
    tenantSettings: { AUTH_ALLOWED_EMAILS: "member@example.com", ADMIN_GRANTS: "member@example.com:org_admin" },
  });
  for (const service of ["edge", "harness"]) {
    const names = (container(resources, service).env ?? []).map((entry) => entry.name);
    assert.ok(!names.some((name) => /^OIDC_|^AUTH_ALLOWED_|^ADMIN_GRANTS$/.test(name)), service);
  }
  const settings = tenantSettings(resources);
  assert.equal(settings.ADMIN_GRANTS, "member@example.com:org_admin");
  assert.equal(settings.OIDC_ALLOWED_EMAILS, "member@example.com");
  assert.equal(settings.OIDC_ISSUER, "https://qm.example.com/idp");
  assert.equal(settings.OIDC_TOKEN_ENDPOINT, "http://127.0.0.1:8099/token");
  assert.equal(settings.OIDC_CLIENT_ID, "qm-portal");
  assert.equal(settings.OIDC_CLIENT_SECRET, "client-secret");
  const explicit = tenantSettings(
    render({ tenantSettings: { AUTH_ALLOWED_EMAILS: "member@example.com", OIDC_ALLOWED_EMAILS: "other@example.org" } }),
  );
  assert.equal(explicit.OIDC_ALLOWED_EMAILS, "other@example.org");
  const external = tenantSettings(render({ services: { auth: { enabled: false } } }));
  assert.equal(external.OIDC_ISSUER, undefined);
  const job = resources.find((r) => r.kind === "Job" && r.metadata.name === "test-qm-tenant-settings");
  assert.equal(job?.metadata.annotations?.["helm.sh/hook"], "post-install,post-upgrade");
  const push = job!.spec.template.spec.containers[0]!;
  assert.equal(push.image, container(resources, "edge").image);
  assert.match(push.env.find((entry) => entry.name === "QM_CORE_URL")!.value, /^http:\/\/test-qm-core\./);
});

test(
  "Helm imports the web UI's access lists, empty when unset, only when the edge serves the web UI, and keeps them out of service env",
  options,
  () => {
    const access = (env: Record<string, string>) => [env.WEB_UI_PRINCIPALS, env.LOOPS_USERS, env.WEB_UI_VOICE_USERS];
    assert.deepEqual(access(tenantSettings(render())), ["", "", ""]);
    const listed = tenantSettings(
      render({
        env: { LOOPS_USERS: "a@example.com" },
        services: {
          core: { env: { WEB_UI_PRINCIPALS: "a@example.com,b@example.com", WEB_UI_VOICE_USERS: "all" } },
        },
      }),
    );
    assert.deepEqual(access(listed), ["a@example.com,b@example.com", "a@example.com", "all"]);
    const withSecret = render({
      secretEnv: { WEB_UI_VOICE_USERS: "all", AUTH_CLIENT_SECRET: "client-secret" },
      services: { core: { env: { WEB_UI_PRINCIPALS: "a@example.com" } } },
    });
    assert.equal(access(tenantSettings(withSecret))[2], "all");
    for (const service of ["edge", "harness"]) {
      const names = (container(withSecret, service).env ?? []).map((entry) => entry.name);
      assert.ok(!names.some((name) => /^(WEB_UI_PRINCIPALS|LOOPS_USERS|WEB_UI_VOICE_USERS)$/.test(name)), service);
    }
    const envSecret = withSecret.find((r) => r.kind === "Secret" && r.metadata.name === "test-qm-env");
    assert.equal(envSecret?.stringData?.AUTH_CLIENT_SECRET, "client-secret");
    assert.equal(envSecret?.stringData?.WEB_UI_VOICE_USERS, undefined);
    const without = tenantSettings(
      render({
        services: {
          portal: { enabled: false },
          admin: { enabled: false },
          auth: { enabled: false },
        },
      }),
    );
    assert.deepEqual(access(without), [undefined, undefined, undefined]);
  },
);

test("Helm refuses tenant settings placed in service env", options, () => {
  for (const values of [
    { env: { AUTH_ALLOWED_EMAILS: "member@example.com" } },
    { secretEnv: { ADMIN_GRANTS: "member@example.com:org_admin" } },
    { services: { auth: { env: { AUTH_ALLOWED_EMAIL_DOMAIN: "example.com" } } } },
    { services: { portal: { env: { OIDC_ALLOWED_EMAILS: "member@example.com" } } } },
  ])
    assert.throws(() => render(values), /is a tenant setting; move it to tenantSettings/);
});
