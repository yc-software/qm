import { hashId } from "../util/crypto.ts";
import type { Sandbox, SandboxHandle } from "../sandbox/sandbox.ts";
import { parseTar } from "../sandbox/tar.ts";
import { shq } from "../util/shell.ts";
import { pathUnder } from "../util/paths.ts";
import { homeRelativePath } from "./paths.ts";
import { builtInCredentialPaths } from "./resident-paths.ts";
import { fileCredentialEnvironment, restoredFileMode, type CredentialFile } from "./keychain.ts";

export interface ExecutionFileCredential {
  files: CredentialFile[];
  save(files: CredentialFile[]): Promise<void>;
}

const executionDirectoryPrefix = (handle: SandboxHandle) =>
  `/tmp/qm-credentials-${hashId([handle.resourceId ?? handle.id]).slice(0, 12)}.`;

export async function clearExecutionFiles(sandbox: Sandbox, handle: SandboxHandle): Promise<void> {
  const prefix = executionDirectoryPrefix(handle);
  const result = await sandbox.run(
    handle,
    `find /tmp/ -maxdepth 1 -name ${shq(`${prefix.slice(5)}*`)} -exec rm -rf -- {} +`,
  );
  if (result.code !== 0) throw new Error("Could not remove credentials from an interrupted execution");
}

export async function prepareExecutionFiles(
  sandbox: Sandbox,
  handle: SandboxHandle,
  credentials: ExecutionFileCredential[],
): Promise<{ env: Record<string, string>; finish(): Promise<void> }> {
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
  const belongsTo = (path: string, index: number) =>
    roots[index]!.some((root) => (root.kind === "directory" ? pathUnder(path, root.path) : path === root.path));
  if (files.some((file) => roots.filter((_, index) => belongsTo(file.path, index)).length !== 1))
    throw new Error("Requested credentials contain overlapping credential directories");
  const prefix = executionDirectoryPrefix(handle);
  const created = await sandbox.run(
    handle,
    `umask 077; d=$(mktemp -d ${shq(`${prefix}XXXXXXXXXX`)}) && printf '%s\\n' "\${d##*.}"`,
  );
  const suffix = created.stdout.trim();
  const directory = `${prefix}${suffix}`;
  if (created.code !== 0 || !/^[a-zA-Z0-9]+$/.test(suffix))
    throw new Error("Could not create command credential directory");
  const home = `${directory}/home`;
  const rooted = { ...handle, rootDir: home };
  const cleanup = async () => {
    const result = await sandbox.run(handle, `rm -rf -- ${shq(directory)}`);
    if (result.code !== 0) throw new Error("Could not remove command credential directory");
  };
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
    await cleanup();
    throw error;
  }
  return {
    env: fileCredentialEnvironment(files, home),
    async finish() {
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
        if (files.some((file) => !refreshed.some((entry) => entry.path === file.path)))
          throw new Error("Credential files were removed or replaced with symlinks during execution");
        const results = await Promise.allSettled(
          credentials.map((credential, index) =>
            credential.save(refreshed.filter((file) => belongsTo(file.path, index))),
          ),
        );
        const failures = results.filter((result) => result.status === "rejected").map((result) => result.reason);
        if (failures.length) throw new AggregateError(failures, "Could not persist refreshed credentials");
      } finally {
        await cleanup();
      }
    },
  };
}
