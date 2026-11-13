import type { Sandbox, SandboxHandle } from "../sandbox/sandbox.ts";
import type { ProcessRegistry } from "../processes/process-registry.ts";
import { parseTar } from "../sandbox/tar.ts";
import { shq } from "../util/shell.ts";
import { errMessage, withCleanup } from "../util/errors.ts";
import { pathUnder } from "../util/paths.ts";
import { homeRelativePath } from "./paths.ts";
import { builtInCredentialPaths, type CredentialPathSpec } from "./resident-paths.ts";
import {
  credentialFileHashes,
  fileCredentialEnvironment,
  KeychainError,
  MAX_CREDENTIAL_BYTES,
  MAX_CREDENTIAL_FILES,
  restoredFileMode,
  type CredentialFile,
  type CredentialFileSave,
  type FileCredentialSource,
  type Keychain,
} from "./keychain.ts";

export interface ExecutionFileCredential {
  files: CredentialFile[];
  save(files: CredentialFile[]): Promise<CredentialFileSave>;
  source?: FileCredentialSource;
}

export interface ExecutionFilePlan {
  directory: string;
  credentials: Array<{ paths: string[]; roots: CredentialPathSpec[] }>;
}

export interface ProcessCredentialFiles {
  plan: ExecutionFilePlan;
  sources: Array<FileCredentialSource & { fileHashes: Record<string, string> }>;
}

export function processCredentialFiles(
  plan: ExecutionFilePlan,
  credentials: readonly ExecutionFileCredential[],
): ProcessCredentialFiles {
  return {
    plan,
    sources: credentials.map((credential) => {
      if (!credential.source) throw new Error("Background credentials need a keychain source");
      return { ...credential.source, fileHashes: credentialFileHashes(credential.files) };
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
  const note = await finishExecutionFiles(
    deps.sandbox,
    handle,
    stored.plan,
    stored.sources.map(({ fileHashes, ...source }) => async (files: CredentialFile[]) => {
      if (!keychain) throw new Error("Refreshed credentials cannot be saved without a keychain");
      return keychain.updateFiles(await keychain.writebackBaseline(source, fileHashes ?? {}), files);
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
  if (note) console.warn(`[credentials] background job ${processId}: ${note}`);
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
): Promise<{ env: Record<string, string>; plan: ExecutionFilePlan; finish(): Promise<string | undefined> }> {
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
  saves: ReadonlyArray<(files: CredentialFile[]) => Promise<CredentialFileSave>>,
  settle?: (retry: number[]) => Promise<void>,
): Promise<string | undefined> {
  const { directory } = plan;
  const home = `${directory}/home`;
  let retry = settle ? plan.credentials.map((_, index) => index) : [];
  const permanent = (message: string) => {
    retry = [];
    return new Error(message);
  };
  const roots = [...new Set(plan.credentials.flatMap((credential) => credential.roots.map((root) => root.path)))];
  const archiveLimit = MAX_CREDENTIAL_BYTES + MAX_CREDENTIAL_FILES * 1024;
  const work = async () => {
    const captured = await sandbox.run(
      handle,
      `cd ${shq(home)} && [ ! -L ${shq(home)} ] && set -- && ` +
        `for p in ${roots.map((root) => shq(`./${root}`)).join(" ")}; do if [ -e "$p" ] || [ -L "$p" ]; then set -- "$@" "$p"; fi; done && ` +
        `: > ${shq(`${directory}/paths`)} && { [ $# -eq 0 ] || find "$@" -type f -print0 > ${shq(`${directory}/paths`)}; } && ` +
        `printf '\\0' > ${shq(`${directory}/links`)} && for p in ${roots.map((root) => shq(`./${root}`)).join(" ")}; do ` +
        `q=$(dirname "$p"); while [ "$q" != . ]; do if [ -L "$q" ]; then printf '%s\\0' "$q" >> ${shq(`${directory}/links`)}; fi; q=$(dirname "$q"); done; done && ` +
        `{ [ $# -eq 0 ] || find "$@" -type l -print0 >> ${shq(`${directory}/links`)}; } && ` +
        `COPYFILE_DISABLE=1 tar --null -T ${shq(`${directory}/paths`)} -cf ${shq(`${directory}/files.tar`)} && ` +
        `size=$(wc -c < ${shq(`${directory}/files.tar`)}) && { [ "$size" -le ${archiveLimit} ] || ` +
        `{ echo "credential files archive is $size bytes, over the ${archiveLimit}-byte cap" >&2; exit 1; }; }`,
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
    const linkList = await sandbox.readFileBytes({ ...handle, rootDir: directory }, "links");
    if (!linkList) throw permanent("Captured credential link list is missing");
    const links = new Set(Buffer.from(linkList).toString("utf8").split("\0").filter(Boolean).map(homeRelativePath));
    const replaced = (path: string) =>
      path.split("/").some((_, index, parts) => links.has(parts.slice(0, index + 1).join("/")));
    if (plan.credentials.some(({ paths }) => paths.some(replaced)))
      throw permanent("Credential files were replaced with symlinks during execution");
    const notes: string[] = [];
    const results = await Promise.allSettled(
      plan.credentials.map(async ({ paths, roots }, index) => {
        const remaining = refreshed.filter((file) => belongsTo(file.path, roots));
        const deleted = paths.filter((path) => !refreshed.some((entry) => entry.path === path));
        if (deleted.length && !remaining.length) {
          notes.push(`deleted all of its credential files (${deleted.join(", ")}); the saved login was left unchanged`);
          return;
        }
        const { overruled, withheld } = await saves[index]!(remaining);
        const removed = deleted.filter((path) => !overruled.includes(path) && !withheld.includes(path));
        if (removed.length)
          notes.push(
            `deleted ${removed.join(", ")}; the saved login no longer includes ${removed.length === 1 ? "it" : "them"}`,
          );
        if (overruled.length)
          notes.push(
            `could not save its changes to ${overruled.join(", ")} because another command saved changes to ${overruled.length === 1 ? "it" : "them"} first; rerun it if they are needed`,
          );
        if (withheld.length)
          notes.push(
            `could not save its changes to ${withheld.join(", ")} because a run that isn't its owner's live turn may only refresh a token cache; the owner can make the change in their own turn`,
          );
      }),
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
    if (failures.length) {
      if (notes.length) console.warn(`[credentials] Before a save failed, this command ${notes.join("; and ")}.`);
      throw new AggregateError(
        failures.map(({ reason }) => reason),
        `${retry.length ? "Could not persist refreshed credentials; will retry" : "Could not persist refreshed credentials"}: ${failures.map(({ reason }) => errMessage(reason)).join("; ")}`,
      );
    }
    return notes.length ? `[credentials] This command ${notes.join("; and ")}.` : undefined;
  };
  return withCleanup(work, async () => {
    await settle?.(retry);
    if (!retry.length) await removeDirectory(sandbox, handle, directory);
  });
}
