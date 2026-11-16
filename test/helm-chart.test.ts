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
  metadata: { name: string; annotations?: Record<string, string>; labels: Record<string, string> };
  spec: {
    selector?: Record<string, unknown>;
    replicas: number;
    strategy?: { type: string; rollingUpdate?: null };
    accessModes?: string[];
    storageClassName?: string;
    resources?: { requests: { storage: string } };
    ports?: { name: string; port: number; targetPort: number }[];
    rules?: { http: { paths: { backend: { service: { name: string; port: { number: number } } } }[] } }[];
    template: {
      metadata: { annotations: Record<string, string>; labels: Record<string, string> };
      spec: {
        securityContext?: { fsGroup: number };
        terminationGracePeriodSeconds?: number;
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
    const baseFile = join(dir, "base.json");
    writeFileSync(baseFile, JSON.stringify({ publicUrl: "https://qm.example.com" }));
    const valuesFile = join(dir, "values.json");
    writeFileSync(valuesFile, JSON.stringify(values));
    const result = spawnSync(
      helm,
      [
        "template",
        "test",
        chart,
        ...(explicitImages ? ["--set", "image.tag=fixture"] : []),
        "-f",
        baseFile,
        "-f",
        valuesFile,
      ],
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

function env(resources: Resource[], name = "core") {
  return {
    ...resources.find((r) => r.kind === "Secret" && r.metadata.name === "test-qm-env")?.stringData,
    ...Object.fromEntries((container(resources, name).env ?? []).map((e) => [e.name, e.value])),
  };
}

test("Helm applies additional labels to all chart resources and preserves their standard labels", options, () => {
  const values = {
    serviceAccount: { create: true },
    ingress: { enabled: true, hosts: ["qm.example.com"] },
    services: { core: { persistence: { enabled: true } } },
    secretEnv: { CORE_SIGNING_SECRET: "fixture" },
  };
  const baseline = render(values);
  assert.deepEqual(render({ ...values, additionalLabels: {} }), baseline);
  const additionalLabels = { "example.com/revision": "123", "example.com/enabled": "true", "example.com/empty": "" };
  const labeled = render({ ...values, additionalLabels });
  assert.deepEqual([...new Set(labeled.map((r) => r.kind))].sort(), [
    "Deployment",
    "Ingress",
    "PersistentVolumeClaim",
    "Secret",
    "Service",
    "ServiceAccount",
  ]);
  assert.equal(labeled.length, baseline.length);
  for (const resource of labeled) {
    const original = baseline.find((r) => r.kind === resource.kind && r.metadata.name === resource.metadata.name);
    assert.ok(original);
    assert.deepEqual(resource.metadata.labels, { ...original.metadata.labels, ...additionalLabels });
    if (resource.kind === "Deployment" || resource.kind === "Service") {
      assert.deepEqual(resource.spec.selector, original.spec.selector);
    }
    if (resource.kind === "Deployment") {
      assert.deepEqual(resource.spec.template.metadata.labels, original.spec.template.metadata.labels);
    }
  }
});

test("Helm rejects additional labels that collide with chart-owned labels", options, () => {
  for (const key of [
    "helm.sh/chart",
    "app.kubernetes.io/name",
    "app.kubernetes.io/instance",
    "app.kubernetes.io/managed-by",
    "app.kubernetes.io/version",
    "app.kubernetes.io/component",
  ]) {
    assert.throws(
      () => render({ additionalLabels: { [key]: "override" } }),
      (error) => {
        assert.ok(error instanceof Error);
        assert.ok(error.message.includes(`additionalLabels cannot override chart-owned label ${key}`));
        return true;
      },
    );
  }
});

test("Helm requires additional label values to be strings", options, () => {
  for (const value of [123, true, null, {}, []]) {
    assert.throws(
      () => render({ additionalLabels: { "example.com/revision": value } }),
      /additionalLabels value for example.com\/revision must be a string/,
    );
  }
});

test("Helm includes resource labels in the checksum only when the chart Secret renders", options, () => {
  for (const secretEnv of [null, { CORE_SIGNING_SECRET: "fixture" }]) {
    const before = render({ secretEnv });
    const after = render({ secretEnv, additionalLabels: { "example.com/revision": "123" } });
    const hasSecret = before.some((r) => r.kind === "Secret");
    assert.equal(hasSecret, secretEnv !== null);
    for (const name of ["core", "egress-proxy"]) {
      const previous = deployment(before, name).spec.template.metadata.annotations["checksum/secret-env"];
      const current = deployment(after, name).spec.template.metadata.annotations["checksum/secret-env"];
      assert.ok(previous);
      assert.ok(current);
      assert.equal(current === previous, !hasSecret);
    }
  }
});

test("Helm requires an explicit compatible image and supports full digest references", options, () => {
  assert.throws(() => render({}, false), /imageRef.*image.tag/);
  const ref = `registry.example.com/qm/core@sha256:${"a".repeat(64)}`;
  const resources = render({ services: { core: { imageRef: ref }, "egress-proxy": { tag: "proxy-fixture" } } });
  assert.equal(container(resources).image, ref);
  assert.equal(container(resources, "egress-proxy").image, "ghcr.io/yc-software/qm/egress-proxy:proxy-fixture");
  assert.deepEqual(
    resources.filter((r) => r.kind === "Deployment").map((r) => r.metadata.name),
    ["test-qm-core", "test-qm-egress-proxy"],
  );
  const byReference = render(
    { services: Object.fromEntries(["core", "egress-proxy"].map((name) => [name, { imageRef: ref }])) },
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
  assert.equal(env(resources).DATA_DIR, "/data");
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
    services: { core: { replicas: 0, persistence: { enabled: true } }, "egress-proxy": { replicas: 0 } },
  });
  assert.equal(deployment(resources).spec.replicas, 0);
  assert.equal(deployment(resources, "egress-proxy").spec.replicas, 0);
});

test("Helm serves core's API and public front door on consistent ports", options, () => {
  const resources = render({ services: { core: { port: 9090, publicPort: 9091 } } });
  assert.equal(env(resources).PORT, "9090");
  assert.equal(env(resources).PUBLIC_PORT, "9091");
  assert.deepEqual(
    container(resources).ports.map((p) => [p.name, p.containerPort]),
    [
      ["http", 9090],
      ["public", 9091],
    ],
  );
  const service = resources.find((r) => r.kind === "Service" && r.metadata.name === "test-qm-core");
  assert.deepEqual(
    service?.spec.ports?.map((p) => [p.name, p.port, p.targetPort]),
    [
      ["http", 9090, 9090],
      ["public", 9091, 9091],
    ],
  );
  assert.equal(container(resources).readinessProbe.httpGet.port, 9090);
  assert.equal(env(resources, "egress-proxy").CORE_API_URL, "http://test-qm-core.default.svc.cluster.local:9090");
  assert.throws(() => render({ services: { core: { env: { PORT: "9999" } } } }), /PORT conflicts/);
  assert.throws(() => render({ env: { PUBLIC_PORT: "9999" } }), /PUBLIC_PORT conflicts/);
  assert.throws(() => render({ services: { core: { publicPort: 8080 } } }), /must differ/);
  assert.throws(() => render({ services: { "egress-proxy": { port: 49000 } } }), /Envoy listener is fixed/);
});

test("Helm gives core its shutdown drain plus 30 s before the kubelet kills it", options, () => {
  const grace = (values: object = {}, name = "core") =>
    deployment(render(values), name).spec.template.spec.terminationGracePeriodSeconds;
  assert.equal(grace(), 60);
  assert.equal(grace({ env: { SHUTDOWN_DRAIN_MS: "45001" } }), 76);
  assert.equal(
    grace({ env: { SHUTDOWN_DRAIN_MS: "1000" }, services: { core: { env: { SHUTDOWN_DRAIN_MS: "90000" } } } }),
    120,
  );
  assert.equal(grace({ env: { SHUTDOWN_DRAIN_MS: 0 } }), 30);
  assert.equal(grace({ env: { SHUTDOWN_DRAIN_MS: null } }), 60);
  assert.equal(grace({ env: { SHUTDOWN_DRAIN_MS: "9e4" } }), 120);
  assert.equal(
    grace({ env: { SHUTDOWN_DRAIN_MS: "90000" }, services: { core: { env: { SHUTDOWN_DRAIN_MS: "" } } } }),
    60,
  );
  assert.equal(grace({}, "egress-proxy"), undefined);
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

test("Helm ingress routes the public hosts to core's front door", options, () => {
  const ingress = render({ ingress: { enabled: true, hosts: ["qm.example.com"] } }).find((r) => r.kind === "Ingress");
  const backend = ingress?.spec.rules?.[0]?.http.paths[0]?.backend.service;
  assert.deepEqual(backend, { name: "test-qm-core", port: { number: 8000 } });
  assert.throws(
    () => render({ ingress: { enabled: true }, services: { core: { enabled: false } } }),
    /enable services.core or disable ingress/,
  );
});

test("Helm rejects services it does not run, including the retired surface workloads", options, () => {
  for (const name of ["unknown", "web-ui", "portal", "auth"]) {
    assert.throws(
      () => render({ services: { [name]: { enabled: true } } }),
      new RegExp(`unknown service "${name}" in services`),
    );
  }
});

test("Helm requires the public URL core's front door derives its addresses from", options, () => {
  assert.throws(() => render({ publicUrl: "" }), /Set publicUrl/);
});

test("Helm wires core's front door and embedded sign-in broker from the public URL", options, () => {
  const wired = env(render({ publicUrl: "https://qm.example.com/" }));
  for (const key of ["AGENT_API_URL", "PUBLIC_WEB_URL"]) {
    assert.equal(wired[key], "https://qm.example.com");
  }
  assert.equal(wired.AUTH_ISSUER, "https://qm.example.com/idp");
  assert.equal(wired.OIDC_ISSUER, wired.AUTH_ISSUER);
  assert.equal(wired.OIDC_AUTH_ENDPOINT, `${wired.AUTH_ISSUER}/authorize`);
  assert.equal(wired.AUTH_REDIRECT_URI, "https://qm.example.com/auth/callback");
  const broker = new URL(wired.AUTH_BROKER_UPSTREAM ?? "");
  assert.equal(broker.hostname, "127.0.0.1");
  for (const key of ["OIDC_TOKEN_ENDPOINT", "OIDC_USERINFO_ENDPOINT", "OIDC_JWKS_URI"]) {
    assert.equal(new URL(wired[key] ?? "").origin, broker.origin, key);
  }
  assert.equal(
    render({ secretEnv: { AUTH_CLIENT_SECRET: "broker-secret" } }).find((r) => r.kind === "Secret")?.stringData
      ?.OIDC_CLIENT_SECRET,
    "broker-secret",
  );
  const external = env(render({ auth: { enabled: false }, secretEnv: { OIDC_CLIENT_ID: "external-client" } }));
  assert.equal(external.PUBLIC_WEB_URL, "https://qm.example.com");
  assert.equal(external.OIDC_CLIENT_ID, "external-client");
  const derived = Object.keys(external).filter(
    (key) => (key.startsWith("AUTH_") || key.startsWith("OIDC_")) && key !== "OIDC_CLIENT_ID",
  );
  assert.deepEqual(derived, []);
  assert.ok(
    !container(render(), "egress-proxy").env.some((e) => e.name.startsWith("AUTH_") || e.name === "PUBLIC_PORT"),
  );
});

test("Helm propagates the effective embedded auth allowlist without overriding explicit policy", options, () => {
  const auth = { AUTH_ALLOWED_EMAILS: "member@example.com", AUTH_ALLOWED_EMAIL_DOMAIN: "example.com" };
  for (const values of [{ env: auth }, { services: { core: { env: auth } } }, { secretEnv: auth }]) {
    const core = env(render(values));
    assert.equal(core.OIDC_ALLOWED_EMAILS, auth.AUTH_ALLOWED_EMAILS);
    assert.equal(core.OIDC_ALLOWED_EMAIL_DOMAIN, auth.AUTH_ALLOWED_EMAIL_DOMAIN);
  }
  assert.ok(!container(render({ secretEnv: auth })).env.some((e) => e.name === "OIDC_ALLOWED_EMAILS"));
  const values = { env: { AUTH_ALLOWED_EMAILS: "global@example.com" }, services: { core: { env: auth } } };
  assert.equal(env(render(values)).OIDC_ALLOWED_EMAILS, auth.AUTH_ALLOWED_EMAILS);
  const explicit = { OIDC_ALLOWED_EMAILS: "other@example.org", OIDC_ALLOWED_EMAIL_DOMAIN: "example.org" };
  for (const overrides of [
    { env: { ...auth, ...explicit } },
    { env: auth, secretEnv: explicit },
    { env: auth, services: { core: { env: explicit } } },
  ]) {
    const core = env(render(overrides));
    assert.equal(core.OIDC_ALLOWED_EMAILS, explicit.OIDC_ALLOWED_EMAILS);
    assert.equal(core.OIDC_ALLOWED_EMAIL_DOMAIN, explicit.OIDC_ALLOWED_EMAIL_DOMAIN);
  }
  assert.equal(env(render({ auth: { enabled: false }, env: auth })).OIDC_ALLOWED_EMAILS, undefined);
});

test("Helm does not shadow an external OIDC allowlist with a derived value", options, () => {
  const envFrom = [{ secretRef: { name: "narrow-oidc-policy" } }];
  for (const [authKey, oidcKey, broad, narrow] of [
    ["AUTH_ALLOWED_EMAILS", "OIDC_ALLOWED_EMAILS", "alice@example.com,bob@example.com", "alice@example.com"],
    ["AUTH_ALLOWED_EMAIL_DOMAIN", "OIDC_ALLOWED_EMAIL_DOMAIN", "example.com", "staff.example.com"],
  ] as const) {
    for (const source of [{ env: { [authKey]: broad } }, { services: { core: { env: { [authKey]: broad } } } }]) {
      assert.ok(!container(render({ ...source, envFrom })).env.some((entry) => entry.name === oidcKey));
      assert.equal(env(render({ ...source, envFrom, secretEnv: { [oidcKey]: narrow } }))[oidcKey], narrow);
    }
    assert.equal(
      env(render({ envFrom, services: { core: { env: { [authKey]: broad, [oidcKey]: narrow } } } }))[oidcKey],
      narrow,
    );
    assert.equal(env(render({ envFrom, env: { [authKey]: broad, [oidcKey]: narrow } }))[oidcKey], narrow);
  }
  assert.ok(!container(render({ envFrom })).env.some((entry) => entry.name.startsWith("OIDC_ALLOWED_")));
});
