import type { Sandbox, SandboxHandle } from "../sandbox/sandbox.ts";
import type { ProcessRegistry } from "../processes/process-registry.ts";
import { parseTar } from "../sandbox/tar.ts";
import { shq } from "../util/shell.ts";
import { pathUnder } from "../util/paths.ts";
import { homeRelativePath } from "./paths.ts";
import { builtInCredentialPaths, type CredentialPathSpec } from "./resident-paths.ts";
import {
  credentialFilesFingerprint,
  fileCredentialEnvironment,
  restoredFileMode,
  type CredentialFile,
  type FileCredentialSource,
  type Keychain,
} from "./keychain.ts";

export interface ExecutionFileCredential {
  files: CredentialFile[];
  save(files: CredentialFile[]): Promise<void>;
  source?: FileCredentialSource;
}

export interface ExecutionFilePlan {
  directory: string;
  credentials: Array<{ paths: string[]; roots: CredentialPathSpec[] }>;
}

export interface ProcessCredentialFiles {
  plan: ExecutionFilePlan;
  sources: Array<FileCredentialSource & { fingerprint: string }>;
}

export function processCredentialFiles(
  plan: ExecutionFilePlan,
  credentials: readonly ExecutionFileCredential[],
): ProcessCredentialFiles {
  return {
    plan,
    sources: credentials.map((credential) => {
      if (!credential.source) throw new Error("Background credentials need a keychain source");
      return { ...credential.source, fingerprint: credentialFilesFingerprint(credential.files) };
    }),
  };
}

export async function finishProcessCredentials(
  deps: {
    sandbox: Sandbox;
    processes: Pick<ProcessRegistry, "takeCredentialFiles">;
    keychain?: Pick<Keychain, "writebackBaseline" | "updateFiles">;
  },
  handle: SandboxHandle,
  processId: string,
): Promise<void> {
  const stored = await deps.processes.takeCredentialFiles(processId);
  if (!stored) return;
  const keychain = deps.keychain;
  await finishExecutionFiles(
    deps.sandbox,
    handle,
    stored.plan,
    stored.sources.map(({ fingerprint, ...source }) => async (files: CredentialFile[]) => {
      if (!keychain) throw new Error("Refreshed credentials cannot be saved without a keychain");
      await keychain.updateFiles(await keychain.writebackBaseline(source, fingerprint), files);
    }),
  );
}

const belongsTo = (path: string, roots: readonly CredentialPathSpec[]) =>
  roots.some((root) => (root.kind === "directory" ? pathUnder(path, root.path) : path === root.path));

export async function prepareExecutionFiles(
  sandbox: Sandbox,
  handle: SandboxHandle,
  credentials: ExecutionFileCredential[],
): Promise<{ env: Record<string, string>; plan: ExecutionFilePlan; finish(): Promise<void> }> {
  const files = credentials
    .flatMap((credential) => credential.files)
    .map((file) => ({
      ...file,
      path: homeRelativePath(file.path),
    }));
  if (new Set(files.map((file) => file.path)).size !== files.length)
    throw new Error("Requested credentials contain overlapping file paths");
  const roots = credentials.map((credential) =>
    credential.files.map((file) => {
      const path = homeRelativePath(file.path);
      return (
        builtInCredentialPaths().find((root) => root.kind === "directory" && pathUnder(path, root.path)) ?? {
          path,
          kind: "file" as const,
        }
      );
    }),
  );
  if (files.some((file) => roots.filter((group) => belongsTo(file.path, group)).length !== 1))
    throw new Error("Requested credentials contain overlapping credential directories");
  const prefix = "/tmp/qm-credentials.";
  const created = await sandbox.run(
    handle,
    `find /tmp/ -maxdepth 1 -name ${shq(`${prefix.slice(5)}*`)} -mmin +120 -exec rm -rf -- {} + 2>/dev/null; umask 077; d=$(mktemp -d ${shq(`${prefix}XXXXXXXXXX`)}) && printf '%s\\n' "\${d##*.}"`,
  );
  const suffix = created.stdout.trim();
  const directory = `${prefix}${suffix}`;
  if (created.code !== 0 || !/^[a-zA-Z0-9]+$/.test(suffix))
    throw new Error("Could not create command credential directory");
  const home = `${directory}/home`;
  const rooted = { ...handle, rootDir: home };
  try {
    const setup = await sandbox.run(
      handle,
      `umask 077; mkdir -p ${files.map((file) => shq(`${home}/${file.path.split("/").slice(0, -1).join("/")}`)).join(" ")}`,
    );
    if (setup.code !== 0) throw new Error("Could not prepare command credential files");
    for (const file of files) {
      await sandbox.writeFileBytes(rooted, file.path, Buffer.from(file.contentBase64, "base64"));
      const mode = await sandbox.run(
        handle,
        `chmod ${restoredFileMode(file.mode).toString(8)} ${shq(`${home}/${file.path}`)}`,
      );
      if (mode.code !== 0) throw new Error("Could not protect command credential file");
    }
  } catch (error) {
    await removeDirectory(sandbox, handle, directory);
    throw error;
  }
  const plan = {
    directory,
    credentials: credentials.map((credential, index) => ({
      paths: credential.files.map((file) => homeRelativePath(file.path)),
      roots: roots[index]!,
    })),
  };
  return {
    env: fileCredentialEnvironment(files, home),
    plan,
    finish: () =>
      finishExecutionFiles(
        sandbox,
        handle,
        plan,
        credentials.map((credential) => credential.save),
      ),
  };
}

async function removeDirectory(sandbox: Sandbox, handle: SandboxHandle, directory: string): Promise<void> {
  const result = await sandbox.run(handle, `rm -rf -- ${shq(directory)}`);
  if (result.code !== 0) throw new Error("Could not remove command credential directory");
}

async function finishExecutionFiles(
  sandbox: Sandbox,
  handle: SandboxHandle,
  plan: ExecutionFilePlan,
  saves: ReadonlyArray<(files: CredentialFile[]) => Promise<void>>,
): Promise<void> {
  const { directory } = plan;
  const home = `${directory}/home`;
  try {
    const captured = await sandbox.run(
      handle,
      `cd ${shq(home)} && [ ! -L ${shq(home)} ] && find . -type f -print0 > ${shq(`${directory}/paths`)} && ` +
        `COPYFILE_DISABLE=1 tar --null -T ${shq(`${directory}/paths`)} -cf ${shq(`${directory}/files.tar`)} && ` +
        `[ "$(wc -c < ${shq(`${directory}/files.tar`)})" -le 8388608 ]`,
    );
    if (captured.code !== 0) throw new Error("Could not capture refreshed credential files");
    const archive = await sandbox.readFileBytes({ ...handle, rootDir: directory }, "files.tar");
    if (!archive || archive.length > 8 * 1024 * 1024) throw new Error("Credential capture exceeds size limit");
    const entries = await parseTar(archive);
    if (entries.length > 500) throw new Error("Credential capture exceeds file limit");
    const refreshed = entries.map((entry) => ({
      path: homeRelativePath(entry.path),
      contentBase64: entry.data.toString("base64"),
      mode: restoredFileMode(entry.mode),
    }));
    if (plan.credentials.some(({ paths }) => paths.some((path) => !refreshed.some((entry) => entry.path === path))))
      throw new Error("Credential files were removed or replaced with symlinks during execution");
    const results = await Promise.allSettled(
      plan.credentials.map(({ roots }, index) =>
        saves[index]!(refreshed.filter((file) => belongsTo(file.path, roots))),
      ),
    );
    const failures = results.filter((result) => result.status === "rejected").map((result) => result.reason);
    if (failures.length) throw new AggregateError(failures, "Could not persist refreshed credentials");
  } finally {
    await removeDirectory(sandbox, handle, directory);
  }
}
