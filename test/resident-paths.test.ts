import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import {
  mkdtemp,
  mkdir,
  writeFile,
  symlink,
  stat,
  readlink,
  readFile,
  readdir,
  utimes,
  lstat,
  rm,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { createExecExport, defaultExcludeAgentComputerExport } from "../src/sandbox/exec-file-ops.ts";
import {
  DISPLACED_DIR_REL,
  EPHEMERAL_CRED_DIR,
  captureRootForTarget,
  configCredentialDirs,
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

test("prep never emits a command that could delete $HOME or a credential bundle", () => {
  const script = ephemeralCredLinkScript("/home/agent", [{ path: ".acmecli", kind: "directory" }]);
  for (const doomed of ["/home/agent", "/home/agent/.config", "/home/agent/.aws", "/home/agent/.acmecli"]) {
    assert.doesNotMatch(
      script,
      new RegExp(`rm -rf '${doomed}'(?!\\.)`),
      `${doomed} must only ever be renamed aside, never removed`,
    );
  }
});

test("prep never copies bytes across the $HOME/ephemeral device boundary", () => {
  const script = ephemeralCredLinkScript("/home/agent", [{ path: ".acmecli", kind: "directory" }]);
  const crossDevice = [...script.matchAll(/mv (?!'\/tmp\/agent-creds)(\S+) '\/tmp\/agent-creds[^']*'/g)];
  assert.deepEqual(
    crossDevice.map((m) => m[0]),
    [],
    "a cross-device mv is a recursive copy that can outrun the prep timeout and never converge",
  );
});

test("a stale file on $HOME itself is displaced, not deleted, and the box still comes up", async (t) => {
  const { home, credDir } = await tempPair(t);
  await writeFile(join(home, ".aws"), "squatter");

  assert.equal(await runLinkScript(home, credDir), 0, "provision prep must not fail");
  assert.equal(await readlink(join(home, ".aws")), join(credDir, ".aws"), "the ephemeral link is in place");
  const quarantined = await readdir(join(home, DISPLACED_DIR_REL));
  const aside = quarantined.find((name) => name.startsWith(".aws."));
  assert.ok(aside, `the squatter was displaced into ${DISPLACED_DIR_REL}, got ${quarantined.join(", ")}`);
  assert.equal(
    await readFile(join(home, DISPLACED_DIR_REL, aside), "utf8"),
    "squatter",
    "displaced state is preserved on its own device",
  );
});

test("displaced credentials are quarantined out of $HOME's backup surface", () => {
  const exclude = (path: string): boolean =>
    defaultExcludeAgentComputerExport(
      { area: "home", path },
      EPHEMERAL_CRED_PATHS.map((link) => link.rel),
    );
  assert.ok(exclude(`${DISPLACED_DIR_REL}/.config/gcloud/credentials.db`), "displaced bundles never reach a backup");
  assert.ok(exclude(`${DISPLACED_DIR_REL}/.netrc.1234`), "nor displaced single-file credentials");
  assert.ok(!exclude(".bashrc"), "ordinary home files still back up");
});

test("displaced credentials cannot be rescanned as a bogus credential service", () => {
  const script = ephemeralCredLinkScript("/home/agent");

  assert.doesNotMatch(script, /'\/home\/agent\/\.config\/[a-z]+\.[a-z-]+'/);
  for (const m of script.matchAll(/mv '\/home\/agent\/([^']+)' '([^']+)'/g)) {
    if (m[1] === DISPLACED_DIR_REL) continue;
    assert.match(m[2]!, new RegExp(`^/home/agent/${DISPLACED_DIR_REL}/`), `${m[1]} must be displaced into quarantine`);
  }
});

test("concurrent preps on one box both succeed and neither destroys the other's displaced state", async (t) => {
  const { home, credDir } = await tempPair(t);
  await writeFile(join(home, ".aws"), "squatter");

  const codes = await Promise.all([
    runLinkScript(home, credDir),
    runLinkScript(home, credDir),
    runLinkScript(home, credDir),
  ]);
  assert.deepEqual(codes, [0, 0, 0], "no prep may deny the agent its computer");
  assert.equal(await readlink(join(home, ".aws")), join(credDir, ".aws"));
  const asides = (await readdir(join(home, DISPLACED_DIR_REL))).filter((n) => n.startsWith(".aws."));
  assert.equal(asides.length, 1, "the one squatter is displaced exactly once");
  assert.equal(await readFile(join(home, DISPLACED_DIR_REL, asides[0]!), "utf8"), "squatter");
});

test("credential link prep stops when ln keeps failing", async (t) => {
  const { home, credDir } = await tempPair(t);
  const bin = join(home, "bin");
  await mkdir(bin);
  await writeFile(join(bin, "ln"), "#!/bin/sh\nexit 1\n", { mode: 0o755 });
  const script = ephemeralCredLinkScript(home).replaceAll(EPHEMERAL_CRED_DIR, credDir);

  await assert.rejects(
    execFileAsync("sh", ["-c", script], {
      env: { ...process.env, PATH: `${bin}:${process.env.PATH ?? ""}` },
      timeout: 5_000,
    }),
    (error: unknown) => (error as { code?: number }).code === 1,
  );
});

test("a prep accepts a peer that converges the link after its displacement loses the race", async (t) => {
  const { home, credDir } = await tempPair(t);
  const bin = join(home, "bin");
  const target = join(credDir, ".aws");
  await mkdir(bin);
  await mkdir(target);
  await writeFile(join(home, ".aws"), "squatter");
  await writeFile(
    join(bin, "mv"),
    `#!/bin/sh
if [ "$1" = "$TEST_HOME/.aws" ]; then
  rm -f "$1"
  ln -s "$TEST_TARGET" "$1"
  exit 1
fi
PATH=/usr/bin:/bin exec mv "$@"
`,
    { mode: 0o755 },
  );

  const script = ephemeralCredLinkScript(home).replaceAll(EPHEMERAL_CRED_DIR, credDir);
  await execFileAsync("sh", ["-c", script], {
    env: { ...process.env, PATH: `${bin}:${process.env.PATH ?? ""}`, TEST_HOME: home, TEST_TARGET: target },
  });
  assert.equal(await readlink(join(home, ".aws")), target);
});

test("a file squatting on the quarantine root does not brick the box", async (t) => {
  const { home, credDir } = await tempPair(t);
  await writeFile(join(home, DISPLACED_DIR_REL), "squatter");
  await writeFile(join(home, ".aws"), "creds");

  assert.equal(await runLinkScript(home, credDir), 0, "the quarantine root heals like everything else");
  assert.equal(await readlink(join(home, ".aws")), join(credDir, ".aws"));
  assert.ok((await stat(join(home, DISPLACED_DIR_REL))).isDirectory());
  const displacedSquatter = (await readdir(home)).find((n) => n.startsWith(`${DISPLACED_DIR_REL}.`));
  assert.ok(displacedSquatter, "and the squatter itself is displaced, not deleted");
});

test("a quarantine squatter is never deleted when preserving it fails", async (t) => {
  const { home, credDir } = await tempPair(t);
  const quarantine = join(home, DISPLACED_DIR_REL);
  const bin = join(home, "bin");
  await mkdir(bin);
  await writeFile(quarantine, "irreplaceable");
  await writeFile(join(home, ".aws"), "creds");
  await writeFile(
    join(bin, "ln"),
    `#!/bin/sh
if [ "$1" = "$TEST_QUARANTINE" ]; then exit 1; fi
PATH=/usr/bin:/bin exec ln "$@"
`,
    { mode: 0o755 },
  );

  const script = ephemeralCredLinkScript(home).replaceAll(EPHEMERAL_CRED_DIR, credDir);
  await assert.rejects(
    execFileAsync("sh", ["-c", script], {
      env: { ...process.env, PATH: `${bin}:${process.env.PATH ?? ""}`, TEST_QUARANTINE: quarantine },
    }),
  );
  assert.equal(await readFile(quarantine, "utf8"), "irreplaceable");
});

test("concurrent quarantine healing never moves the real quarantine onto the backup surface", async (t) => {
  const { home, credDir } = await tempPair(t);
  await writeFile(join(home, DISPLACED_DIR_REL), "squatter");
  await writeFile(join(home, ".aws"), "creds");

  assert.deepEqual(
    await Promise.all([runLinkScript(home, credDir), runLinkScript(home, credDir), runLinkScript(home, credDir)]),
    [0, 0, 0],
  );
  assert.ok((await stat(join(home, DISPLACED_DIR_REL))).isDirectory());
  for (const name of (await readdir(home)).filter((entry) => entry.startsWith(`${DISPLACED_DIR_REL}.`))) {
    assert.ok(defaultExcludeAgentComputerExport({ area: "home", path: name }, []));
    assert.ok(!(await stat(join(home, name))).isDirectory(), "a peer must never move the live quarantine directory");
  }
});

test("repeated displacement of the same path does not overwrite an earlier bundle", async (t) => {
  const { home, credDir } = await tempPair(t);
  for (const generation of ["first", "second"]) {
    await rm(join(home, ".netrc"), { force: true });
    await writeFile(join(home, ".netrc"), generation);
    assert.equal(await runLinkScript(home, credDir), 0);
  }
  const asides = (await readdir(join(home, DISPLACED_DIR_REL))).filter((n) => n.startsWith(".netrc."));
  const contents = await Promise.all(asides.map((n) => readFile(join(home, DISPLACED_DIR_REL, n), "utf8")));
  assert.deepEqual(contents.sort(), ["first", "second"], "a reused pid must not clobber the older aside");
});

test("quarantined credentials are pruned from the backup archive, not just filtered after it", async () => {
  const scripts: string[] = [];
  const backup = createExecExport({
    label: "test",
    exec: async (_id, script) => {
      scripts.push(script);
      return { stdout: "", stderr: "", code: 0, timedOut: false };
    },
    readAbsBytes: async () => Buffer.alloc(0),
    defaultHomeDir: "/home/agent",
    ephemeralCredentialPrefixes: EPHEMERAL_CRED_PATHS.map((link) => link.rel),
  });
  await backup.exportFiles(
    { id: "box", rootDir: "/home/agent/workspace", homeDir: "/home/agent" },
    { include: ["home"] },
  );

  assert.match(scripts.join("\n"), new RegExp(`-path '\\./${DISPLACED_DIR_REL}/\\*'`));
  assert.match(scripts.join("\n"), new RegExp(`-path '\\./${DISPLACED_DIR_REL}\\.\\*'`));
});

test("the quarantine sweep expires asides without deleting the quarantine itself", async (t) => {
  const { home, credDir } = await tempPair(t);
  const quarantine = join(home, DISPLACED_DIR_REL);
  await mkdir(quarantine, { recursive: true });
  await writeFile(join(quarantine, ".netrc.stale"), "expired");
  await writeFile(join(quarantine, ".netrc.fresh"), "recent");

  const longAgo = new Date(Date.now() - 30 * 24 * 3600 * 1000);
  await utimes(quarantine, longAgo, longAgo);
  await utimes(join(quarantine, ".netrc.stale"), longAgo, longAgo);
  await writeFile(join(home, ".netrc"), "squatter");

  assert.equal(await runLinkScript(home, credDir), 0);
  const remaining = await readdir(quarantine);
  assert.ok(!remaining.includes(".netrc.stale"), "expired asides are swept");
  assert.ok(remaining.includes(".netrc.fresh"), "recent asides survive");
  assert.ok(
    remaining.some((n) => n.startsWith(".netrc.") && n !== ".netrc.fresh"),
    "and the aside just displaced is still there",
  );
});

test("a symlinked quarantine root cannot walk displaced credentials out of quarantine", async (t) => {
  const { home, credDir } = await tempPair(t);

  const elsewhere = join(home, "workspace", "leak");
  await mkdir(elsewhere, { recursive: true });
  await symlink(elsewhere, join(home, DISPLACED_DIR_REL));
  await writeFile(join(home, ".netrc"), "machine example.com password hunter2");

  assert.equal(await runLinkScript(home, credDir), 0);
  assert.deepEqual(await readdir(elsewhere), [], "nothing was written through the symlink");
  assert.ok(!(await lstat(join(home, DISPLACED_DIR_REL))).isSymbolicLink(), "the symlink was displaced");
  const quarantined = await readdir(join(home, DISPLACED_DIR_REL));
  assert.ok(
    quarantined.some((n) => n.startsWith(".netrc.")),
    "and the credential landed in a real quarantine directory",
  );
});

test("prep contains no deletion that can reach $HOME outside the quarantine", () => {
  const home = "/home/agent";
  const script = ephemeralCredLinkScript(home, [{ path: ".acmecli", kind: "directory" }]);
  const quarantine = `${home}/${DISPLACED_DIR_REL}`;
  const deletable = (path: string): boolean =>
    path.startsWith(`${EPHEMERAL_CRED_DIR}/`) || path === EPHEMERAL_CRED_DIR || path.startsWith(`${quarantine}/`);

  for (const m of script.matchAll(/rm -rf ('[^']+'|\S+)/g)) {
    const arg = m[1]!.replace(/^'|'$/g, "");
    if (arg === "{}") continue;
    assert.ok(deletable(arg), `rm -rf ${arg} can reach $HOME outside the quarantine`);
  }

  for (const m of script.matchAll(/find ('[^']+'|\S+)([^;]*?)-exec rm[^;]*/g)) {
    const root = m[1]!.replace(/^'|'$/g, "");
    assert.ok(deletable(`${root}/`), `find -exec rm rooted at ${root} can reach $HOME`);
    assert.match(m[2]!, /-mindepth 1\b/, `find -exec rm at ${root} would also delete its own root`);
  }
});

test("captureRootForTarget: .config logins re-sweep the service dir; others their immediate parent", () => {
  assert.deepEqual(captureRootForTarget(".config/gh/hosts.yml"), { path: ".config/gh", kind: "directory" });
  assert.deepEqual(captureRootForTarget(".config/acmecorp/auth.json"), {
    path: ".config/acmecorp",
    kind: "directory",
  });
  assert.deepEqual(
    captureRootForTarget(".config/standalone"),
    { path: ".config/standalone", kind: "file" },
    "a bare file directly in .config is a file, not a bogus directory",
  );
  assert.deepEqual(captureRootForTarget(".aws/sso/cache/token.json"), {
    path: ".aws/sso/cache/token.json",
    kind: "file",
  });
  assert.deepEqual(captureRootForTarget(".netrc"), { path: ".netrc", kind: "file" });
  assert.deepEqual(
    captureRootForTarget(".local/share/foo/token"),
    { path: ".local/share/foo/token", kind: "file" },
    "a deep non-.config path never widens to a directory walk",
  );
  assert.deepEqual(
    captureRootForTarget("~/.fly/config.yml"),
    { path: ".fly/config.yml", kind: "file" },
    "legacy ~/-prefixed targets normalize instead of silently leaving the sweep",
  );
  assert.equal(captureRootForTarget("../escape"), undefined);
  assert.equal(captureRootForTarget("notdot/x"), undefined);
  assert.equal(captureRootForTarget(".config/"), undefined);
});

test("configCredentialDirs stays in lockstep with the .config links the prep layer projects", () => {
  const fromLinks = ephemeralCredLinkPaths()
    .filter((l) => l.rel.startsWith(".config/"))
    .map((l) => l.rel);
  for (const rel of fromLinks) {
    assert.ok(configCredentialDirs().includes(rel), `${rel} is linked by prep, so it must be swept`);
  }
  assert.ok(
    configCredentialDirs().includes(".config/glab-cli"),
    "real glab writes .config/glab-cli — a fresh login must be swept without registration",
  );
  assert.ok(configCredentialDirs().includes(".config/glab"), "glab is swept, not just validated");
});
