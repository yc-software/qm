import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, writeFile, symlink, stat, readlink, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import {
  EPHEMERAL_CRED_DIR,
  credentialServiceForPath,
  ephemeralCredLinkPaths,
  residentAuthPaths,
} from "../src/credentials/resident-paths.ts";
import { EPHEMERAL_CRED_PATHS, ephemeralCredLinkScript } from "../src/credentials/resident-paths.ts";

const execFileAsync = promisify(execFile);

async function tempPair(t: { after: (fn: () => Promise<void>) => void }): Promise<{ home: string; credDir: string }> {
  const home = await mkdtemp(join(tmpdir(), "cred-home-"));
  const credDir = await mkdtemp(join(tmpdir(), "cred-eph-"));
  t.after(async () => {
    await rm(home, { recursive: true, force: true });
    await rm(credDir, { recursive: true, force: true });
  });
  return { home, credDir };
}

async function runLinkScript(home: string, credDir: string): Promise<number> {
  const script = ephemeralCredLinkScript(home).replaceAll(EPHEMERAL_CRED_DIR, credDir);
  try {
    await execFileAsync("sh", ["-c", script]);
    return 0;
  } catch (e) {
    return typeof (e as { code?: number }).code === "number" ? (e as { code: number }).code : 1;
  }
}

test("custom credential files use distinct ephemeral parent directories", () => {
  const links = ephemeralCredLinkPaths([
    { path: ".config/foo/token.json", kind: "file" },
    { path: ".config/bar/token.json", kind: "file" },
    { path: ".acme", kind: "directory" },
  ]);
  assert.ok(links.some((link) => link.rel === ".config/foo/token.json" && link.kind === "file"));
  assert.ok(links.some((link) => link.rel === ".config/bar/token.json" && link.kind === "file"));
  assert.ok(links.some((link) => link.rel === ".acme" && link.kind === "dir"));
  const script = ephemeralCredLinkScript("/root", [
    { path: ".config/foo/token.json", kind: "file" },
    { path: ".config/bar/token.json", kind: "file" },
    { path: ".acme", kind: "directory" },
  ]);
  assert.match(script, /\/tmp\/agent-creds\/\.config\/foo\/token\.json/);
  assert.match(script, /\/tmp\/agent-creds\/\.config\/bar\/token\.json/);
  assert.match(script, /\/tmp\/agent-creds\/\.acme/);
});

test("credential service names use the same path convention as automatic capture", () => {
  assert.equal(credentialServiceForPath(".config/acme/token.json"), "acme");
  assert.equal(credentialServiceForPath(".acme/token"), "acme");
  assert.equal(credentialServiceForPath(".netrc"), "netrc");
});

test("known single-file credential paths remain file links", () => {
  const netrc = ephemeralCredLinkPaths().find((link) => link.rel === ".netrc");
  assert.deepEqual(netrc, { rel: ".netrc", kind: "file" });
});

test("custom single-segment credential files remain file links", () => {
  const path = { path: ".acmerc", kind: "file" } as const;
  assert.deepEqual(
    ephemeralCredLinkPaths([path]).find((link) => link.rel === path.path),
    { rel: ".acmerc", kind: "file" },
  );
  const script = ephemeralCredLinkScript("/root", [path]);
  assert.match(script, /ln -s '\/tmp\/agent-creds\/\.acmerc' '\/root\/\.acmerc'/);
  assert.doesNotMatch(script, /mkdir -p '\/tmp\/agent-creds\/\.acmerc'/);
});

test(".ssh and .git-credentials stay volume-durable: resident-captured but NEVER ephemeral-linked", () => {
  const durable = [".ssh", ".git-credentials"];
  for (const rel of durable) {
    assert.ok(residentAuthPaths().includes(rel), `${rel} stays in the publish-capture allowlist`);
    assert.ok(!EPHEMERAL_CRED_PATHS.some((link) => link.rel === rel), `${rel} must not be ephemeral-linked`);
  }
  const links = ephemeralCredLinkPaths([
    { path: ".ssh", kind: "directory" },
    { path: ".ssh/id_rsa", kind: "file" },
    { path: ".git-credentials", kind: "file" },
  ]);
  for (const rel of durable) {
    assert.ok(
      !links.some((link) => link.rel === rel || link.rel.startsWith(`${rel}/`)),
      `${rel} never enters the link set via extras`,
    );
  }
  const script = ephemeralCredLinkScript("/root", [
    { path: ".ssh", kind: "directory" },
    { path: ".git-credentials", kind: "file" },
  ]);
  assert.doesNotMatch(script, /\.ssh/);
  assert.doesNotMatch(script, /\.git-credentials/);
});

test("base ephemeral paths stay deduplicated when a layer declares them", () => {
  const links = ephemeralCredLinkPaths([
    { path: ".aws", kind: "directory" },
    { path: ".aws/credentials", kind: "file" },
    { path: ".netrc", kind: "file" },
    { path: ".config/gh/hosts.yml", kind: "file" },
    { path: ".config/glab/config.yml", kind: "file" },
  ]);
  assert.deepEqual(links, ephemeralCredLinkPaths(), "built-in coverage is a no-op");
});

test("a layer-declared credential path becomes ephemeral and resident-mounted", () => {
  const links = ephemeralCredLinkPaths([{ path: ".acmecli", kind: "directory" }]);
  assert.deepEqual(
    links.find((link) => link.rel === ".acmecli"),
    { rel: ".acmecli", kind: "dir" },
  );
  assert.ok(residentAuthPaths([{ path: ".acmecli", kind: "directory" }]).includes(".acmecli"));
  assert.ok(
    !residentAuthPaths().includes(".acmecli"),
    "generic core does not capture deployment credentials by default",
  );
  assert.match(
    ephemeralCredLinkScript("/root", [{ path: ".acmecli", kind: "directory" }]),
    /\/tmp\/agent-creds\/\.acmecli/,
  );
});

test("a stale file squatting on a directory credential target is healed instead of bricking the box", async (t) => {
  const { home, credDir } = await tempPair(t);
  await writeFile(join(credDir, ".aws"), "");
  await symlink(join(credDir, ".aws"), join(home, ".aws"));

  assert.equal(await runLinkScript(home, credDir), 0, "provision prep must not fail");
  assert.ok((await stat(join(credDir, ".aws"))).isDirectory(), ".aws target is a usable directory");
  assert.equal(await readlink(join(home, ".aws")), join(credDir, ".aws"), "the home link still points at it");
  assert.ok((await stat(join(credDir, ".config/gh"))).isDirectory(), "later credential paths still linked");
  assert.equal(await readlink(join(home, ".netrc")), join(credDir, ".netrc"));
});

for (const where of ["ephemeral", "home"] as const) {
  test(`a stale file on the ${where} parent directory is healed too`, async (t) => {
    const { home, credDir } = await tempPair(t);
    await writeFile(join(where === "ephemeral" ? credDir : home, ".config"), "stale");

    assert.equal(await runLinkScript(home, credDir), 0, "provision prep must not fail");
    assert.ok((await stat(join(credDir, ".config/gh"))).isDirectory(), "nested credential dir exists");
    assert.equal(await readlink(join(home, ".config/gh")), join(credDir, ".config/gh"), "and is linked from $HOME");
  });
}

test("the ephemeral credential root itself is healed when a file squats on it", async (t) => {
  const { home, credDir } = await tempPair(t);
  await rm(credDir, { recursive: true, force: true });
  await writeFile(credDir, "stale");

  assert.equal(await runLinkScript(home, credDir), 0, "provision prep must not fail");
  assert.ok((await stat(credDir)).isDirectory());
});

test("re-running the link script over healthy credential state changes nothing", async (t) => {
  const { home, credDir } = await tempPair(t);
  await mkdir(join(credDir, ".aws"), { recursive: true });
  await writeFile(join(credDir, ".aws", "credentials"), "[default]\n");
  await symlink(join(credDir, ".aws"), join(home, ".aws"));

  assert.equal(await runLinkScript(home, credDir), 0);
  assert.equal(await runLinkScript(home, credDir), 0, "idempotent across provisions");
  assert.ok((await stat(join(credDir, ".aws", "credentials"))).isFile(), "existing credentials survive");
});

test("the heal never fires on a target that is already usable as a directory", async (t) => {
  const { home, credDir } = await tempPair(t);
  const elsewhere = join(credDir, "real-aws");
  await mkdir(elsewhere, { recursive: true });
  await writeFile(join(elsewhere, "credentials"), "[default]\n");
  await symlink(elsewhere, join(credDir, ".aws"));

  assert.equal(await runLinkScript(home, credDir), 0);
  assert.ok((await stat(join(elsewhere, "credentials"))).isFile(), "contents behind the symlink survive");
});

test(".config/glab is ephemeral-linked but NOT publish-captured (prod never baked glab creds into apps)", () => {
  assert.ok(!residentAuthPaths().includes(".config/glab"));
  assert.ok(EPHEMERAL_CRED_PATHS.some((link) => link.rel === ".config/glab" && link.kind === "dir"));
});
