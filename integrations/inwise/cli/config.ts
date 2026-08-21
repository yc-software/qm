import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { PairingFile } from "../common/protocol.js";

export function cliConfigPath(): string {
  if (process.env.INWISE_QM_CONFIG) return process.env.INWISE_QM_CONFIG;
  return join(
    process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config"),
    "inwise-qm",
    "credentials.json",
  );
}

export function loadCliConfig(): PairingFile {
  const path = cliConfigPath();
  if (!existsSync(path))
    throw new Error("Inwise is not connected. Run `inwise auth login` first.");
  return JSON.parse(readFileSync(path, "utf8")) as PairingFile;
}

export function saveCliConfig(config: PairingFile): void {
  const path = cliConfigPath();
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(config, null, 2)}\n`, {
    mode: 0o600,
  });
  renameSync(temporary, path);
}
