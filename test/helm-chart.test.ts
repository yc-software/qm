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
    strategy?: { type: string; rollingUpdate?: null };
    accessModes?: string[];
    storageClassName?: string;
    resources?: { requests: { storage: string } };
    ports?: { port: number; targetPort: number }[];
    rules?: { http: { paths: { backend: { service: { name: string; port: { number: number } } } }[] } }[];
    template: {
      spec: {
        securityContext?: { fsGroup: number };
        volumes?: { name: string; persistentVolumeClaim: { claimName: string } }[];
        containers: {
          image: string;
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
    // Use Helm's YAML parser rather than require a second YAML implementation.
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

function deployment(resources: Resource[], name = "core") {
  const resource = resources.find((r) => r.kind === "Deployment" && r.metadata.name === `test-qm-${name}`);
  assert.ok(resource, `missing ${name} deployment`);
  return resource;
}

function container(resources: Resource[], name = "core") {
  const result = deployment(resources, name).spec.template.spec.containers[0];
  assert.ok(result, `missing ${name} container`);
  return result;
}

function env(resources: Resource[], name = "portal") {
  return {
    ...resources.find((r) => r.kind === "Secret" && r.metadata.name === "test-qm-env")?.stringData,
    ...Object.fromEntries((container(resources, name).env ?? []).map((e) => [e.name, e.value])),
  };
}

test("Helm requires an explicit compatible image and supports full digest references", options, () => {
  assert.throws(() => render({}, false), /imageRef.*image.tag/);
  const ref = `registry.example.com/qm/core@sha256:${"a".repeat(64)}`;
  const resources = render({ services: { core: { imageRef: ref }, portal: { tag: "portal-fixture" } } });
  assert.equal(container(resources).image, ref);
  assert.equal(container(resources, "portal").image, "ghcr.io/yc-software/qm/portal:portal-fixture");
  assert.equal(resources.filter((r) => r.kind === "Deployment").length, 4);
  const byReference = render(
    {
      services: Object.fromEntries(
        ["core", "portal", "web-ui", "egress-proxy"].map((name) => [name, { imageRef: ref }]),
      ),
    },
    false,
  );
  assert.ok(
    byReference
      .filter((r) => r.kind === "Deployment")
      .every((r) => container(byReference, r.metadata.name.replace("test-qm-", "")).image === ref),
  );
});

test("Helm mounts a retained core PVC with node group permissions and no overlapping pods", options, () => {
  const resources = render({
    services: { core: { persistence: { enabled: true, size: "20Gi", storageClass: "block" } } },
  });
  const core = deployment(resources);
  const pvc = resources.find((r) => r.kind === "PersistentVolumeClaim");
  assert.ok(pvc);
  assert.equal(pvc.metadata.annotations?.["helm.sh/resource-policy"], "keep");
  assert.deepEqual(pvc.spec.accessModes, ["ReadWriteOnce"]);
  assert.equal(pvc.spec.storageClassName, "block");
  assert.equal(pvc.spec.resources?.requests.storage, "20Gi");
  assert.equal(core.spec.strategy?.type, "Recreate");
  assert.equal(core.spec.strategy?.rollingUpdate, null);
  assert.equal(core.spec.template.spec.securityContext?.fsGroup, 1000);
  assert.equal(core.spec.template.spec.volumes?.[0]?.persistentVolumeClaim.claimName, pvc.metadata.name);
  assert.deepEqual(container(resources).volumeMounts, [{ name: "data", mountPath: "/data" }]);
  assert.equal(env(resources, "core").DATA_DIR, "/data");
  assert.throws(
    () => render({ services: { core: { replicas: 2, persistence: { enabled: true } } } }),
    /at most one replica/,
  );
  assert.throws(
    () => render({ services: { core: { env: { DATA_DIR: "/wrong" }, persistence: { enabled: true } } } }),
    /DATA_DIR=\/data/,
  );
});

test("Helm supports existing claims, default or empty storage class, and opting out", options, () => {
  const resources = render({ services: { core: { persistence: { enabled: true, existingClaim: "restored-data" } } } });
  assert.ok(!resources.some((r) => r.kind === "PersistentVolumeClaim"));
  assert.equal(deployment(resources).spec.template.spec.volumes?.[0]?.persistentVolumeClaim.claimName, "restored-data");
  for (const storageClass of [null, ""]) {
    const pvc = render({ services: { core: { persistence: { enabled: true, storageClass } } } }).find(
      (r) => r.kind === "PersistentVolumeClaim",
    );
    assert.ok(pvc);
    assert.equal(pvc.spec.storageClassName, storageClass === null ? undefined : "");
  }
  const disabled = render();
  assert.ok(!disabled.some((r) => r.kind === "PersistentVolumeClaim"));
  assert.equal(deployment(disabled).spec.template.spec.volumes, undefined);
});

test("Helm preserves zero replicas including a stopped persistent core", options, () => {
  const resources = render({
    services: { core: { replicas: 0, persistence: { enabled: true } }, portal: { replicas: 0 } },
  });
  assert.equal(deployment(resources).spec.replicas, 0);
  assert.equal(deployment(resources, "portal").spec.replicas, 0);
});

test("Helm keeps process ports, probes, Services and upstreams consistent", options, () => {
  const resources = render({ services: { core: { port: 9090 }, portal: { port: 9091 }, "web-ui": { port: 9092 } } });
  for (const [name, port] of [
    ["core", 9090],
    ["portal", 9091],
    ["web-ui", 9092],
  ] as const) {
    assert.equal(env(resources, name).PORT, String(port));
    assert.equal(container(resources, name).ports[0]?.containerPort, port);
    const service = resources.find((r) => r.kind === "Service" && r.metadata.name === `test-qm-${name}`);
    assert.equal(service?.spec.ports?.[0]?.targetPort, port);
    assert.equal(service?.spec.ports?.[0]?.port, port);
  }
  assert.equal(container(resources).readinessProbe.httpGet.port, 9090);
  assert.equal(env(resources).CORE_API_URL, "http://test-qm-core.default.svc.cluster.local:9090");
  assert.equal(env(resources).WEB_UI_UPSTREAM, "http://test-qm-web-ui.default.svc.cluster.local:9092");
  assert.throws(() => render({ services: { core: { env: { PORT: "9999" } } } }), /PORT conflicts/);
  assert.throws(() => render({ services: { "egress-proxy": { port: 49000 } } }), /Envoy listener is fixed/);
});

test("Helm separates core startup/readiness from liveness and allows probe overrides", options, () => {
  const core = container(render());
  assert.equal(core.readinessProbe.httpGet.path, "/readyz");
  assert.equal(core.livenessProbe.httpGet.path, "/healthz");
  assert.equal(core.startupProbe?.httpGet.path, "/readyz");
  assert.equal(core.startupProbe?.httpGet.port, "http");
  assert.equal(core.startupProbe?.failureThreshold, 60);
  const custom = container(render({ services: { core: { readinessPath: "/custom-ready", startupProbe: null } } }));
  assert.equal(custom.readinessProbe.httpGet.path, "/custom-ready");
  assert.equal(custom.livenessProbe.httpGet.path, "/healthz");
  assert.equal(custom.startupProbe, undefined);
});

test("Helm ingress rejects embedded, missing, worker and disabled targets", options, () => {
  for (const service of ["auth", "admin", "egress-proxy", "missing"]) {
    assert.throws(() => render({ ingress: { enabled: true, service } }), /ingress.service must name/);
  }
  assert.throws(
    () => render({ ingress: { enabled: true }, services: { portal: { enabled: false }, auth: { enabled: false } } }),
    /portal is disabled/,
  );
  const ingress = render({ ingress: { enabled: true, hosts: ["qm.example.com"] } }).find((r) => r.kind === "Ingress");
  assert.equal(ingress?.spec.rules?.[0]?.http.paths[0]?.backend.service.name, "test-qm-portal");
});

function tenantSettings(resources: Resource[]): Record<string, string> {
  const secret = resources.find((r) => r.kind === "Secret" && r.metadata.name === "test-qm-tenant-settings");
  assert.ok(secret?.stringData?.["settings.json"], "missing tenant settings secret");
  return (JSON.parse(secret.stringData["settings.json"]) as { env: Record<string, string> }).env;
}

test("Helm pushes sign-in and admin settings to the install tenant instead of any service env", options, () => {
  const resources = render({
    publicUrl: "https://qm.example.com",
    secretEnv: { AUTH_CLIENT_ID: "qm-portal", AUTH_CLIENT_SECRET: "client-secret" },
    tenantSettings: { AUTH_ALLOWED_EMAILS: "member@example.com", ADMIN_GRANTS: "member@example.com:org_admin" },
  });
  for (const service of ["core", "portal", "web-ui"]) {
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
  assert.equal(push.image, container(resources, "core").image);
  assert.match(push.env.find((entry) => entry.name === "QM_CORE_URL")!.value, /^http:\/\/test-qm-core\./);
});

test(
  "Helm imports the web UI's access lists, empty when unset, only when the web UI runs, and keeps them out of service env",
  options,
  () => {
    const access = (env: Record<string, string>) => [env.WEB_UI_PRINCIPALS, env.LOOPS_USERS, env.WEB_UI_VOICE_USERS];
    assert.deepEqual(access(tenantSettings(render())), ["", "", ""]);
    const listed = tenantSettings(
      render({
        env: { LOOPS_USERS: "a@example.com" },
        services: {
          "web-ui": { env: { WEB_UI_PRINCIPALS: "a@example.com,b@example.com", WEB_UI_VOICE_USERS: "all" } },
        },
      }),
    );
    assert.deepEqual(access(listed), ["a@example.com,b@example.com", "a@example.com", "all"]);
    const withSecret = render({
      secretEnv: { WEB_UI_VOICE_USERS: "all", AUTH_CLIENT_SECRET: "client-secret" },
      services: { "web-ui": { env: { WEB_UI_PRINCIPALS: "a@example.com" } } },
    });
    assert.equal(access(tenantSettings(withSecret))[2], "all");
    for (const service of ["core", "portal", "web-ui"]) {
      const names = (container(withSecret, service).env ?? []).map((entry) => entry.name);
      assert.ok(!names.some((name) => /^(WEB_UI_PRINCIPALS|LOOPS_USERS|WEB_UI_VOICE_USERS)$/.test(name)), service);
    }
    const envSecret = withSecret.find((r) => r.kind === "Secret" && r.metadata.name === "test-qm-env");
    assert.equal(envSecret?.stringData?.AUTH_CLIENT_SECRET, "client-secret");
    assert.equal(envSecret?.stringData?.WEB_UI_VOICE_USERS, undefined);
    const without = tenantSettings(
      render({
        services: {
          "web-ui": { enabled: false },
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
