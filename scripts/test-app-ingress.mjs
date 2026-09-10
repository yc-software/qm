import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import YAML from "yaml";

const helm = process.env.HELM ?? "helm";
const chart = fileURLToPath(new URL("../deploy/helm", import.meta.url));
function render(values) {
  return spawnSync(
    helm,
    ["template", "check", chart, ...Object.entries(values).flatMap(([key, value]) => ["--set", `${key}=${value}`])],
    { encoding: "utf8" },
  );
}
const good = {
  "ingress.enabled": true,
  "ingress.hosts[0]": "qm.example.test",
  "appsIngress.enabled": true,
  "env.DEPLOY_APPS_DOMAIN": "apps.example.test",
  "appsIngress.tlsSecretName": "apps-tls",
};
const rendered = render(good);
assert.equal(rendered.status, 0, rendered.error?.message ?? rendered.stderr);
const ingress = YAML.parseAllDocuments(rendered.stdout)
  .map((doc) => doc.toJSON())
  .filter((doc) => doc?.kind === "Ingress");
assert.equal(ingress.length, 2);
const apps = ingress.find((doc) => doc.metadata.name.endsWith("-apps"));
assert.equal(apps.spec.rules[0].host, "*.apps.example.test");
assert.equal(apps.spec.rules[0].http.paths[0].backend.service.name, "check-qm-core");
assert.equal(apps.spec.tls[0].secretName, "apps-tls");
assert.equal(ingress.find((doc) => doc !== apps).spec.rules[0].http.paths[0].backend.service.name, "check-qm-portal");
for (const invalid of [
  { "appsIngress.enabled": true },
  { ...good, "appsIngress.tlsSecretName": "" },
  { ...good, "services.core.enabled": false },
  { ...good, "env.DEPLOY_APPS_DOMAIN": "bad/path" },
  { ...good, "env.DEPLOY_APPS_DOMAIN": "a".repeat(64) + ".example.test" },
  { ...good, "env.DEPLOY_APPS_DOMAIN": "", "secretEnv.DEPLOY_APPS_DOMAIN": "apps.example.test" },
  { ...good, "services.core.env.DEPLOY_APPS_DOMAIN": "", "secretEnv.DEPLOY_APPS_DOMAIN": "apps.example.test" },
])
  assert.notEqual(render(invalid).status, 0, JSON.stringify(invalid));
assert.equal(
  YAML.parseAllDocuments(render({}).stdout)
    .map((doc) => doc.toJSON())
    .filter((doc) => doc?.kind === "Ingress").length,
  0,
);
console.log("PASS: portal/app ingress separation, wildcard TLS, defaults, and seven invalid configurations");
