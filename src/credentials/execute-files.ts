import type { Sandbox, SandboxHandle } from "../sandbox/sandbox.ts";
import type { ProcessRegistry } from "../processes/process-registry.ts";
import { parseTar } from "../sandbox/tar.ts";
import { shq } from "../util/shell.ts";
import { errMessage, withCleanup } from "../util/errors.ts";
import { pathUnder } from "../util/paths.ts";
import { homeRelativePath } from "./paths.ts";
import { builtInCredentialPaths, type CredentialPathSpec } from "./resident-paths.ts";
import {
  credentialFilesFingerprint,
  fileCredentialEnvironment,
  KeychainError,
  MAX_CREDENTIAL_BYTES,
  MAX_CREDENTIAL_FILES,
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
    processes: Pick<ProcessRegistry, "credentialFiles" | "setCredentialFiles">;
    keychain?: Pick<Keychain, "writebackBaseline" | "updateFiles">;
  },
  handle: SandboxHandle,
  processId: string,
): Promise<void> {
  const stored = await deps.processes.credentialFiles(processId);
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
    (retry) =>
      deps.processes.setCredentialFiles(
        processId,
        retry.length
          ? {
              plan: { ...stored.plan, credentials: retry.map((index) => stored.plan.credentials[index]!) },
              sources: retry.map((index) => stored.sources[index]!),
            }
          : null,
      ),
  );
}

async function runOrThrow(sandbox: Sandbox, handle: SandboxHandle, command: string, failure: string) {
  const result = await sandbox.run(handle, command);
  if (result.code !== 0) throw new Error(`${failure} (exit ${result.code}): ${result.stderr.trim()}`);
  return result;
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
  const created = await runOrThrow(
    sandbox,
    handle,
    `find /tmp/ -maxdepth 1 -name ${shq(`${prefix.slice(5)}*`)} -mmin +120 -exec rm -rf -- {} + 2>/dev/null; umask 077; d=$(mktemp -d ${shq(`${prefix}XXXXXXXXXX`)}) && printf '%s\\n' "\${d##*.}"`,
    "Could not create command credential directory",
  );
  const suffix = created.stdout.trim();
  if (!/^[a-zA-Z0-9]+$/.test(suffix))
    throw new Error(`Unexpected credential directory suffix: ${JSON.stringify(suffix)}`);
  const directory = `${prefix}${suffix}`;
  const home = `${directory}/home`;
  const rooted = { ...handle, rootDir: home };
  try {
    await runOrThrow(
      sandbox,
      handle,
      `umask 077; mkdir -p ${files.map((file) => shq(`${home}/${file.path.split("/").slice(0, -1).join("/")}`)).join(" ")}`,
      "Could not prepare command credential files",
    );
    for (const file of files) {
      await sandbox.writeFileBytes(rooted, file.path, Buffer.from(file.contentBase64, "base64"));
      await runOrThrow(
        sandbox,
        handle,
        `chmod ${restoredFileMode(file.mode).toString(8)} ${shq(`${home}/${file.path}`)}`,
        "Could not protect command credential file",
      );
    }
  } catch (error) {
    return withCleanup(
      () => Promise.reject(error),
      () => removeDirectory(sandbox, handle, directory),
    );
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
  await runOrThrow(sandbox, handle, `rm -rf -- ${shq(directory)}`, "Could not remove command credential directory");
}

async function finishExecutionFiles(
  sandbox: Sandbox,
  handle: SandboxHandle,
  plan: ExecutionFilePlan,
  saves: ReadonlyArray<(files: CredentialFile[]) => Promise<void>>,
  settle?: (retry: number[]) => Promise<void>,
): Promise<void> {
  const { directory } = plan;
  const home = `${directory}/home`;
  let retry = settle ? plan.credentials.map((_, index) => index) : [];
  const permanent = (message: string) => {
    retry = [];
    return new Error(message);
  };
  const work = async () => {
    const captured = await sandbox.run(
      handle,
      `cd ${shq(home)} && [ ! -L ${shq(home)} ] && find . -type f -print0 > ${shq(`${directory}/paths`)} && ` +
        `COPYFILE_DISABLE=1 tar --null -T ${shq(`${directory}/paths`)} -cf ${shq(`${directory}/files.tar`)} && ` +
        `[ "$(wc -c < ${shq(`${directory}/files.tar`)})" -le ${MAX_CREDENTIAL_BYTES + MAX_CREDENTIAL_FILES * 1024} ]`,
    );
    if (captured.code !== 0)
      throw permanent(
        `Could not capture refreshed credential files (exit ${captured.code}): ${captured.stderr.trim()}`,
      );
    const archive = await sandbox.readFileBytes({ ...handle, rootDir: directory }, "files.tar");
    if (!archive) throw permanent("Captured credential archive is missing");
    const entries = await parseTar(archive);
    const refreshed = entries.map((entry) => ({
      path: homeRelativePath(entry.path),
      contentBase64: entry.data.toString("base64"),
      mode: restoredFileMode(entry.mode),
    }));
    if (plan.credentials.some(({ paths }) => paths.some((path) => !refreshed.some((entry) => entry.path === path))))
      throw permanent("Credential files were removed or replaced with symlinks during execution");
    const results = await Promise.allSettled(
      plan.credentials.map(({ roots }, index) =>
        saves[index]!(refreshed.filter((file) => belongsTo(file.path, roots))),
      ),
    );
    const failures = results.flatMap((result, index) =>
      result.status === "rejected" ? [{ index, reason: result.reason as unknown }] : [],
    );
    retry = retry.filter((index) =>
      failures.some(
        (failure) =>
          failure.index === index && !(failure.reason instanceof KeychainError && failure.reason.status < 500),
      ),
    );
    if (failures.length)
      throw new AggregateError(
        failures.map(({ reason }) => reason),
        `${retry.length ? "Could not persist refreshed credentials; will retry" : "Could not persist refreshed credentials"}: ${failures.map(({ reason }) => errMessage(reason)).join("; ")}`,
      );
  };
  await withCleanup(work, async () => {
    await settle?.(retry);
    if (!retry.length) await removeDirectory(sandbox, handle, directory);
  });
}
