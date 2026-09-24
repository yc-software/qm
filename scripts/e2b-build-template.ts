import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Template, defaultBuildLogger, type CopyItem } from "e2b";
import { loadDeploymentLayer } from "../src/deployment/load-layer.ts";

const positiveInt = (name: string): number | undefined => {
  const raw = process.env[name];
  if (!raw) return undefined;
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) throw new Error(`${name} must be a positive integer, got ${JSON.stringify(raw)}`);
  return n;
};

const baseName = process.env.E2B_TEMPLATE_NAME ?? "qm-base";
const cpuCount = positiveInt("E2B_TEMPLATE_CPUS");
const memoryMB = positiveInt("E2B_TEMPLATE_MEMORY_MB");
const resources = { ...(cpuCount ? { cpuCount } : {}), ...(memoryMB ? { memoryMB } : {}) };
const dockerfile = readFileSync(new URL("../deploy/e2b/e2b.Dockerfile", import.meta.url), "utf8");

const base = await Template.build(Template().fromDockerfile(dockerfile), baseName, {
  ...resources,
  onBuildLogs: defaultBuildLogger(),
});
console.log(`E2B_TEMPLATE_ID=${base.name} (templateId ${base.templateId}, build ${base.buildId})`);

const layerDir = process.env.DEPLOYMENT_LAYER;
if (layerDir) {
  const files = loadDeploymentLayer(layerDir).installFiles;
  if (files.length === 0) {
    console.log(`DEPLOYMENT_LAYER=${layerDir} declares no install files; no layer template built`);
  } else {
    const staging = mkdtempSync(join(tmpdir(), "e2b-layer-"));
    const items: CopyItem[] = files.map((file, index) => {
      writeFileSync(join(staging, String(index)), file.content);
      return { src: String(index), dest: file.to, mode: parseInt(file.mode, 8), user: "user" };
    });
    const layerName = process.env.E2B_LAYER_TEMPLATE_NAME ?? `${baseName}-layer`;
    const layered = await Template.build(
      Template({ fileContextPath: staging }).fromTemplate(base.name).copyItems(items),
      layerName,
      { ...resources, onBuildLogs: defaultBuildLogger() },
    );
    console.log(`E2B_TEMPLATE_ID=${layered.name} (templateId ${layered.templateId}, build ${layered.buildId})`);
  }
}
