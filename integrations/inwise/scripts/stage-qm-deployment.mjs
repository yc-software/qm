import { chmod, copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const destination = resolve(root, process.argv[2] ?? "e2e");
const relayHost = process.env.INWISE_QM_EGRESS_HOST ?? "host.docker.internal";
const toolsDirectory = resolve(destination, "sandbox", "tools", "inwise");
const skillsDirectory = resolve(
  destination,
  "sandbox",
  "skills",
  "inwise-meeting-memory",
);

await mkdir(toolsDirectory, { recursive: true });
await mkdir(skillsDirectory, { recursive: true });

const descriptor = (
  await readFile(resolve(root, "qm", "tool.json"), "utf8")
).replace("relay.example.com", relayHost);
await writeFile(resolve(toolsDirectory, "tool.json"), descriptor);
await copyFile(
  resolve(root, "dist", "qm", "inwise"),
  resolve(toolsDirectory, "inwise"),
);
await chmod(resolve(toolsDirectory, "inwise"), 0o755);
await copyFile(
  resolve(root, "skill", "SKILL.md"),
  resolve(skillsDirectory, "SKILL.md"),
);

console.log(`Staged Inwise QM layer: ${destination}`);
