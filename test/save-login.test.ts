import assert from "node:assert/strict";
import test from "node:test";
import { execFile } from "node:child_process";
import { createServer } from "node:http";
import { mkdir, mkdtemp, rm, writeFile, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { createKeychain } from "../src/credentials/keychain.ts";
import { createMemoryMap } from "../src/persistence/durable-map.ts";
import { deriveConnectorKey } from "../src/connectors/connector-client-store.ts";
import { scopeId } from "../src/types.ts";

const run = promisify(execFile);
const script = fileURLToPath(new URL("../skills-seed/interactive-login/scripts/save-login.mjs", import.meta.url));

test("save-login uploads a private login home and re-saving keeps the entry and its grants", async (t) => {
  const keychain = createKeychain({
    creds: createMemoryMap(),
    grants: createMemoryMap(),
    asks: createMemoryMap(),
    key: deriveConnectorKey("synthetic-test-key"),
  });
  const server = createServer(async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    if (req.headers["x-agent-capability"] !== "synthetic-token") return res.writeHead(401).end();
    const input = JSON.parse(body);
    const credential = await keychain.save({ ownerId: "U1", ...input, origin: "agent-session:test" });
    res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ credential }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  const { port } = server.address() as { port: number };
  const env = { ...process.env, AGENT_API_URL: `http://127.0.0.1:${port}`, AGENT_API_TOKEN: "synthetic-token" };

  const login = async (token: string) => {
    const home = await mkdtemp(join(tmpdir(), "login-home-"));
    t.after(() => rm(home, { recursive: true, force: true }));
    await mkdir(join(home, ".aws/sso/cache"), { recursive: true });
    await mkdir(join(home, ".aws/logs"), { recursive: true });
    await writeFile(join(home, ".aws/config"), "[profile work]\nsso_session = work\n");
    await writeFile(join(home, ".aws/sso/cache/token.json"), token, { mode: 0o600 });
    await writeFile(join(home, ".aws/logs/cli.log"), "noise");
    const { stdout } = await run("node", [script, "aws", home, "--label", "work"], { env });
    await assert.rejects(access(home));
    return stdout;
  };

  assert.match(await login("first"), /^saved aws \(2 files\) as kc_/);
  const [saved] = await keychain.listByOwner("U1");
  const grant = await keychain.createGrant({
    credentialId: saved!.id,
    ownerId: "U1",
    audienceScopeId: scopeId("channel", "C1"),
    mode: "standing",
    purpose: "test",
  });
  await login("second");
  const after = await keychain.listByOwner("U1");
  assert.equal(after.length, 1);
  assert.equal(after[0]!.id, saved!.id);
  assert.equal(after[0]!.accountLabel, "work");
  assert.equal((await keychain.getGrant(grant.id))?.status, "active");
  const loaded = await keychain.materializeOwnById("U1", saved!.id, scopeId("personal", "U1"));
  assert.equal(loaded.kind, "file");
  if (loaded.kind !== "file") return;
  const token = loaded.files.find((file) => file.path === ".aws/sso/cache/token.json")!;
  assert.equal(Buffer.from(token.contentBase64, "base64").toString(), "second");
  assert.equal(token.mode, 0o600);
});
