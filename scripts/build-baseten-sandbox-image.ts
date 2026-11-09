import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { SandboxApiError, SandboxClient } from "@basetenlabs/sandbox";

const SANDBOX_API = "ghcr.io/blaxel-ai/sandbox@sha256:228a77c043357cbb03297b5ed088a3875076973e19515d0bb28d755323010737";

const apiKey = process.env.BASETEN_API_KEY;
if (!apiKey) throw new Error("set BASETEN_API_KEY");
const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const git = (...args: string[]): Buffer => execFileSync("git", ["-C", root, ...args], { maxBuffer: 1 << 30 });
const tree = git("rev-parse", "--short=12", "HEAD^{tree}").toString().trim();
const name = `${process.argv[2] ?? "qm-sandbox"}-${tree}`;
const client = new SandboxClient({ apiKey });

const existing = await client.images.getInfo({ name }).catch((error: unknown) => {
  if (error instanceof SandboxApiError && error.status === 404) return null;
  throw error;
});
if (existing?.status === "BUILT") {
  console.error(`${name} is already built`);
} else {
  const dockerfile = [
    git("show", "HEAD:fly/Dockerfile").toString().trimEnd(),
    `COPY --from=${SANDBOX_API} /sandbox-api /usr/local/bin/sandbox-api`,
    'ENTRYPOINT ["/usr/local/bin/sandbox-api"]',
    "CMD []",
    "",
  ].join("\n");
  const zip = git("archive", "--format=zip", `--add-virtual-file=Dockerfile:${dockerfile}`, "HEAD");
  console.error(`building ${name} on Baseten…`);
  await client.images.push({ name, zip: new Uint8Array(zip) });
}
console.log(`BASETEN_SANDBOX_IMAGE=${name}:latest`);
