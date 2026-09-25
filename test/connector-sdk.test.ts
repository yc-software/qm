import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, readFile, rm, writeFile, mkdir, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import { installConnectorSdk, loadConnectorSdk, withConnectorSdk } from "../src/sandbox/connector-sdk.ts";
import type { LayerToolInstallIo } from "../src/sandbox/layer-tool-install.ts";

const exec = promisify(execFile);

async function localIo(t: TestContext) {
  const home = await mkdtemp(join(tmpdir(), "qm-sdk-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  const bin = join(home, "bin");
  await mkdir(bin);
  if (process.platform === "darwin") {
    await symlink((await exec("which", ["gsha256sum"])).stdout.trim(), join(bin, "sha256sum"));
  }
  let writes = 0;
  const io: LayerToolInstallIo = {
    async exec(script, timeoutSec) {
      try {
        const result = await exec("sh", ["-c", script], {
          env: { ...process.env, PATH: `${bin}:${process.env.PATH}` },
          timeout: timeoutSec * 1_000,
        });
        return { code: 0, ...result };
      } catch (error) {
        const result = error as Error & { code: number; stdout: string; stderr: string };
        return { code: result.code, stdout: result.stdout, stderr: result.stderr };
      }
    },
    async writeAbs(path, data) {
      writes++;
      await writeFile(path, data);
    },
  };
  return { home, io, writes: () => writes };
}

const fixture = () => {
  const sdk = Buffer.from("exports.Composio = class Composio {};");
  return { sdk, sha: createHash("sha256").update(sdk).digest("hex"), licenses: Buffer.from("license") };
};

test("concurrent installation activates complete bytes and subsequent provision does not upload", async (t) => {
  const { home, io, writes } = await localIo(t);
  const bundle = fixture();
  await Promise.all([installConnectorSdk(io, home, bundle), installConnectorSdk(io, home, bundle)]);
  assert.deepEqual(await readFile(`${home}/.qm/composio/current/sdk.cjs`), bundle.sdk);
  const before = writes();
  await installConnectorSdk(io, home, bundle);
  assert.equal(writes(), before);
  await writeFile(`${home}/.qm/composio/current/sdk.cjs`, "broken");
  await installConnectorSdk(io, home, bundle);
  assert.equal(writes(), before + 2);
  assert.deepEqual(await readFile(`${home}/.qm/composio/current/sdk.cjs`), bundle.sdk);
});

test("corrupt transfers never replace the previously active bundle", async (t) => {
  const { home, io } = await localIo(t);
  const first = fixture();
  await installConnectorSdk(io, home, first);
  const sdk = Buffer.from("exports.Composio = class Next {};");
  const next = { ...first, sdk, sha: createHash("sha256").update(sdk).digest("hex") };
  await assert.rejects(
    installConnectorSdk({ ...io, writeAbs: (path) => writeFile(path, "corrupt") }, home, next),
    /installation failed/,
  );
  assert.deepEqual(await readFile(`${home}/.qm/composio/current/sdk.cjs`), first.sdk);
  await installConnectorSdk(io, home, next);
  assert.deepEqual(await readFile(`${home}/.qm/composio/current/sdk.cjs`), sdk);
});

test("SDK setup follows layer preparation and rejects invalid local bytes before remote commands", async () => {
  const steps: string[] = [];
  const install = withConnectorSdk(
    "/home/test",
    async () => {
      steps.push("layer");
    },
    async () => {
      steps.push("bundle");
      return { ...fixture(), sha: "bad" };
    },
  );
  await assert.rejects(
    install({
      exec: async () => {
        throw new Error("unexpected remote exec");
      },
      writeAbs: async () => {},
    }),
    /checksum mismatch/,
  );
  assert.deepEqual(steps, ["layer", "bundle"]);
});

test("built bundle performs an SDK request without node_modules or external network", async (t) => {
  const bundle = await loadConnectorSdk();
  const { home, io } = await localIo(t);
  await installConnectorSdk(io, home, bundle);
  const requests: string[] = [];
  const server = createServer((req, res) => {
    requests.push(req.url ?? "");
    assert.equal(req.headers["x-api-key"], "test-only");
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ items: [], total_pages: 1, current_page: 1, total_items: 0 }));
  });
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const script = `const { Composio } = await import(${JSON.stringify(`${home}/.qm/composio/current/sdk.cjs`)});
const c = new Composio({apiKey:'test-only',allowTracking:false,disableVersionCheck:true,dangerouslyAllowAutoUploadDownloadFiles:false});
const client = c.getClient(); client.baseURL = 'http://127.0.0.1:${address.port}'; client.maxRetries = 0;
const result = await client.toolkits.list({limit:1}); if(result.items.length !== 0) process.exit(1);`;
  await exec(process.execPath, ["--input-type=module", "-e", script], { cwd: home });
  assert.equal(requests.length, 1);
  assert.match(requests[0]!, /toolkits\?limit=1/);
});
