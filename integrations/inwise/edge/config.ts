import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { EdgeFile } from "../common/protocol.js";

export function edgeConfigPath(): string {
  if (process.env.INWISE_QM_EDGE_CONFIG)
    return process.env.INWISE_QM_EDGE_CONFIG;
  if (process.platform === "win32") {
    return join(
      process.env.APPDATA ?? join(homedir(), "AppData", "Roaming"),
      "inwise-opensource",
      "qm-edge.json",
    );
  }
  if (process.platform === "darwin") {
    return join(
      homedir(),
      "Library",
      "Application Support",
      "inwise-opensource",
      "qm-edge.json",
    );
  }
  return join(
    process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config"),
    "inwise-opensource",
    "qm-edge.json",
  );
}

export function loadEdgeConfig(): EdgeFile {
  const path = edgeConfigPath();
  if (!existsSync(path))
    throw new Error(`Inwise is not paired with QM. Missing ${path}`);
  return JSON.parse(readFileSync(path, "utf8")) as EdgeFile;
}

export function saveEdgeConfig(config: EdgeFile): void {
  const path = edgeConfigPath();
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(config, null, 2)}\n`, {
    mode: 0o600,
  });
  renameSync(temporary, path);
}
