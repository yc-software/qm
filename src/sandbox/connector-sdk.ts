import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { shq } from "../util/shell.ts";
import type { LayerToolInstaller, LayerToolInstallIo } from "./layer-tool-install.ts";

export interface ConnectorSdkBundle {
  sdk: Uint8Array;
  licenses: Uint8Array;
  sha: string;
}

export async function loadConnectorSdk(): Promise<ConnectorSdkBundle> {
  const base = new URL("../../.generated/connector-sdk/", import.meta.url);
  const [sdk, licenses, hash] = await Promise.all([
    readFile(new URL("sdk.cjs", base)),
    readFile(new URL("LICENSES.txt", base)),
    readFile(new URL("sha256", base), "utf8"),
  ]).catch((cause) => {
    throw new Error("Connector SDK bundle missing; run npm run build:connector-sdk before starting QM", { cause });
  });
  const sha = createHash("sha256").update(sdk).digest("hex");
  if (hash.trim() !== sha) throw new Error("Connector SDK bundle checksum mismatch");
  return { sdk, licenses, sha };
}

export function withConnectorSdk(
  home: string,
  installTools: LayerToolInstaller,
  load?: () => Promise<ConnectorSdkBundle>,
): LayerToolInstaller {
  return async (io, prepare) => {
    await installTools(io, prepare);
    if (load) await installConnectorSdk(io, home, await load());
  };
}

export async function installConnectorSdk(
  io: LayerToolInstallIo,
  home: string,
  bundle: ConnectorSdkBundle,
): Promise<void> {
  if (!/^[a-f0-9]{64}$/.test(bundle.sha) || createHash("sha256").update(bundle.sdk).digest("hex") !== bundle.sha)
    throw new Error("Connector SDK bundle checksum mismatch");
  const root = `${home}/.qm/composio`;
  const target = `${root}/${bundle.sha}`;
  const current = `${root}/current`;
  const nonce = randomUUID();
  const link = `${root}/.link-${nonce}`;
  const baked = "/opt/qm/composio";
  const probe = (dir: string) => `printf '%s\\n' ${shq(`${bundle.sha}  ${dir}/sdk.cjs`)} | sha256sum -c --status`;
  const activate = (dir: string) =>
    `node -e ${shq(`const fs = require('node:fs'); fs.symlinkSync(${JSON.stringify(dir)}, ${JSON.stringify(link)}); fs.renameSync(${JSON.stringify(link)}, ${JSON.stringify(current)});`)}`;
  const result = await io.exec(
    `mkdir -p ${shq(root)} && { if ${probe(current)}; then exit 0; fi; if ${probe(baked)}; then ${activate(baked)}; elif ${probe(target)}; then ${activate(target)}; else exit 44; fi; }`,
    60,
  );
  if (result.code === 0) return;
  if (result.code !== 44) throw new Error(`Connector SDK probe failed (rc=${result.code})`);
  const stage = `${root}/.stage-${nonce}`;
  try {
    const prep = await io.exec(`mkdir -p ${shq(stage)} ${shq(target)}`, 60);
    if (prep.code !== 0) throw new Error(`Connector SDK staging failed (rc=${prep.code})`);
    await io.writeAbs(`${stage}/sdk.cjs`, bundle.sdk);
    await io.writeAbs(`${stage}/LICENSES.txt`, bundle.licenses);
    const commit = await io.exec(
      `${probe(stage)} && node -e ${shq(`if(typeof require(${JSON.stringify(`${stage}/sdk.cjs`)}).Composio !== 'function') process.exit(1)`)} && chmod 0644 ${shq(stage)}/sdk.cjs ${shq(stage)}/LICENSES.txt && mv -f ${shq(stage)}/LICENSES.txt ${shq(target)}/LICENSES.txt && mv -f ${shq(stage)}/sdk.cjs ${shq(target)}/sdk.cjs && ${activate(target)} && ${probe(current)}`,
      60,
    );
    if (commit.code !== 0) throw new Error(`Connector SDK installation failed (rc=${commit.code})`);
  } finally {
    await io
      .exec(
        `rm -f ${shq(stage)}/sdk.cjs ${shq(stage)}/LICENSES.txt ${shq(link)}; rmdir ${shq(stage)} 2>/dev/null || true`,
        60,
      )
      .catch(() => {});
  }
}
