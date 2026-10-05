import { execFileSync } from "node:child_process";

const networks = execFileSync("docker", ["network", "ls", "--format", "{{.Name}}"], { encoding: "utf8" }).split("\n");
if (networks.includes("agent-deploynet")) {
  const [network] = JSON.parse(execFileSync("docker", ["network", "inspect", "agent-deploynet"], { encoding: "utf8" }));
  const containers = Object.values(network.Containers ?? {}).map((c) => (c as { Name: string }).Name);
  if (containers.length) {
    console.error("Redeploy these apps onto their per-app networks before upgrading:", containers);
    process.exitCode = 1;
  }
}
