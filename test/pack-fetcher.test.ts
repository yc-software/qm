import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createGitFetcher, resolvePackAuth } from "../src/skills/pack-fetcher.ts";
import type { SkillPack } from "../src/skills/skill-pack-store.ts";

function makeSourceRepo(): { dir: string; sha: string } {
  const dir = mkdtempSync(join(tmpdir(), "qm-src-fixture-"));
  const env = {
    ...process.env,
    GIT_AUTHOR_NAME: "t",
    GIT_AUTHOR_EMAIL: "t@t",
    GIT_COMMITTER_NAME: "t",
    GIT_COMMITTER_EMAIL: "t@t",
  };
  const g = (...args: string[]): void => {
    execFileSync("git", args, { cwd: dir, env, stdio: "ignore" });
  };
  g("init", "-q");
  mkdirSync(join(dir, "skills", "demo", "scripts"), { recursive: true });
  writeFileSync(
    join(dir, "skills", "demo", "SKILL.md"),
    "---\nname: demo\ndescription: d\nscope: company\n---\n# Body",
  );
  writeFileSync(join(dir, "skills", "demo", "scripts", "foo.py"), "print('hi')");
  writeFileSync(join(dir, "bin.dat"), Buffer.from([0, 1, 2, 3, 0]));
  g("add", "-A");
  g("commit", "-q", "-m", "init");
  const sha = execFileSync("git", ["rev-parse", "HEAD"], { cwd: dir, env }).toString().trim();
  return { dir, sha };
}

const src = (over: Partial<SkillPack>): SkillPack => ({
  id: "s1",
  kind: "git",
  url: "",
  ref: "",
  syncMode: "pinned",
  trustTier: "internal",
  targetScopeId: "org:acme",
  subset: "all",
  createdBy: "u",
  createdAt: 0,
  ...over,
});

test("fetches the tree at a pinned sha; flags binary; excludes .git", async () => {
  const { dir, sha } = makeSourceRepo();
  try {
    const repo = await createGitFetcher({ allowLocalRepos: true }).fetch(src({ url: dir, ref: sha }));
    assert.equal(repo.commit, sha);
    const paths = repo.files.map((f) => f.path);
    assert.ok(paths.includes("skills/demo/SKILL.md"));
    assert.ok(paths.includes("skills/demo/scripts/foo.py"));
    assert.ok(!paths.some((p) => p === ".git" || p.startsWith(".git/")));
    assert.equal(repo.files.find((f) => f.path === "bin.dat")!.binary, true);
    assert.equal(repo.files.find((f) => f.path === "skills/demo/SKILL.md")!.binary, false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("an empty ref fetches the repo's default branch HEAD", async () => {
  const { dir, sha } = makeSourceRepo();
  try {
    const repo = await createGitFetcher({ allowLocalRepos: true }).fetch(src({ url: dir, ref: "" }));
    assert.equal(repo.commit, sha);
    assert.ok(repo.files.some((f) => f.path === "skills/demo/SKILL.md"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("rejects an option/arg-smuggling ref before invoking git", async () => {
  await assert.rejects(
    () => createGitFetcher().fetch(src({ url: "https://example.com/repo", ref: "--upload-pack=evil" })),
    /invalid skill pack ref/,
  );
  await assert.rejects(
    () => createGitFetcher().fetch(src({ url: "https://example.com/repo", ref: "a b; rm -rf /" })),
    /invalid skill pack ref/,
  );
});

test("enforces the file-count cap", async () => {
  const { dir, sha } = makeSourceRepo();
  try {
    await assert.rejects(
      () => createGitFetcher({ maxFiles: 1, allowLocalRepos: true }).fetch(src({ url: dir, ref: sha })),
      /max files/,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

const gitEnv = {
  ...process.env,
  GIT_AUTHOR_NAME: "t",
  GIT_AUTHOR_EMAIL: "t@t",
  GIT_COMMITTER_NAME: "t",
  GIT_COMMITTER_EMAIL: "t@t",
};
const gitOut = (dir: string, ...a: string[]): string =>
  execFileSync("git", a, { cwd: dir, env: gitEnv }).toString().trim();

test("resolveRef returns the default-branch HEAD and sees a pinned pack's line advance", async () => {
  const { dir, sha } = makeSourceRepo();
  try {
    const f = createGitFetcher({ allowLocalRepos: true });
    assert.equal(await f.resolveRef(src({ url: dir, ref: sha })), sha);
    writeFileSync(join(dir, "skills", "demo", "extra.md"), "x");
    execFileSync("git", ["add", "-A"], { cwd: dir, env: gitEnv, stdio: "ignore" });
    execFileSync("git", ["commit", "-q", "-m", "more"], { cwd: dir, env: gitEnv, stdio: "ignore" });
    const head2 = gitOut(dir, "rev-parse", "HEAD");
    const resolved = await f.resolveRef(src({ url: dir, ref: sha }));
    assert.equal(resolved, head2, "now resolves the advanced HEAD");
    assert.notEqual(resolved, sha, "≠ the pinned sha ⇒ update available");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("resolveRef resolves a branch ref to that branch's HEAD", async () => {
  const { dir } = makeSourceRepo();
  try {
    const branch = gitOut(dir, "rev-parse", "--abbrev-ref", "HEAD");
    const head = gitOut(dir, "rev-parse", "HEAD");
    assert.equal(await createGitFetcher({ allowLocalRepos: true }).resolveRef(src({ url: dir, ref: branch })), head);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("resolveRef rejects an arg-smuggling ref before invoking git", async () => {
  await assert.rejects(
    () => createGitFetcher().resolveRef(src({ url: "https://example.com/repo", ref: "--upload-pack=evil" })),
    /invalid skill pack ref/,
  );
});

test("resolvePackAuth: an explicit host-bound slug honors the configured injection", async () => {
  const sources = {
    serviceCredential: async (s: string) => ({ secret: "svc:" + s, host: "github.com", enabled: true }),
    connectorToken: async () => "connector",
  };
  assert.deepEqual(
    await resolvePackAuth(sources, { url: "https://github.com/o/r", authCredentialSlug: "dep", createdBy: "u1" }),
    { header: "Authorization", value: "Bearer svc:dep", secret: "svc:dep" },
  );
});

test("resolvePackAuth: an explicit slug fails closed when disabled or outside host/path/method policy", async () => {
  const connectorToken = async () => "connector";
  assert.equal(
    await resolvePackAuth(
      { serviceCredential: async () => ({ secret: "x", host: "github.com", enabled: false }), connectorToken },
      { url: "https://github.com/o/r", authCredentialSlug: "dep", createdBy: "u1" },
    ),
    undefined,
  );
  await assert.rejects(
    () =>
      resolvePackAuth(
        { serviceCredential: async () => ({ secret: "x", host: "example.com", enabled: true }), connectorToken },
        { url: "https://github.com/o/r", authCredentialSlug: "dep", createdBy: "u1" },
      ),
    /not authorized/,
  );
  await assert.rejects(
    () =>
      resolvePackAuth(
        {
          serviceCredential: async () => ({
            secret: "x",
            host: "github.com",
            enabled: true,
            allowedPathPrefixes: ["/other/"],
          }),
          connectorToken,
        },
        { url: "https://github.com/o/r", authCredentialSlug: "dep", createdBy: "u1" },
      ),
    /not authorized/,
  );
  await assert.rejects(
    () =>
      resolvePackAuth(
        {
          serviceCredential: async () => ({ secret: "x", host: "github.com", enabled: true, allowedMethods: ["GET"] }),
          connectorToken,
        },
        { url: "https://github.com/o/r", authCredentialSlug: "dep", createdBy: "u1" },
      ),
    /GET and POST/,
  );
});

test("resolvePackAuth: a github repo with no slug reuses the registrant's connected GitHub token", async () => {
  const calls: Array<[string, string]> = [];
  const sources = {
    serviceCredential: async () => ({ secret: "svc", host: "github.com", enabled: true }),
    connectorToken: async (h: string, p: string) => {
      calls.push([h, p]);
      return "ghtok";
    },
  };
  assert.deepEqual(await resolvePackAuth(sources, { url: "https://github.com/o/r.git", createdBy: "alice" }), {
    header: "Authorization",
    value: "Bearer ghtok",
    secret: "ghtok",
  });
  assert.deepEqual(calls, [["api.github.com", "alice"]], "looks up the registrant's api.github.com connector token");
});

test("resolvePackAuth: a non-github / local repo with no slug uses no token (public)", async () => {
  const sources = {
    serviceCredential: async () => ({ secret: "svc", host: "example.com", enabled: true }),
    connectorToken: async () => "x",
  };
  assert.equal(await resolvePackAuth(sources, { url: "https://example.com/o/r", createdBy: "u" }), undefined);
  assert.equal(await resolvePackAuth(sources, { url: "/local/path", createdBy: "u" }), undefined);
});

test("rejects local and command-executing git transports", async () => {
  await assert.rejects(() => createGitFetcher().fetch(src({ url: "/tmp/repo" })), /must use https/);
  await assert.rejects(() => createGitFetcher().fetch(src({ url: "file:///tmp/repo" })), /credential-free https/);
  await assert.rejects(() => createGitFetcher().fetch(src({ url: "ext::sh -c id" })), /https/);
  await assert.rejects(
    () => createGitFetcher().fetch(src({ url: "https://token@example.com/o/r" })),
    /credential-free https/,
  );
});

test("rejects repositories resolving to a private network before invoking Git", async () => {
  await assert.rejects(
    () => createGitFetcher({ gitBin: process.execPath }).resolveRef(src({ url: "https://127.0.0.1/repo" })),
    /public network address/,
  );
  await assert.rejects(
    () =>
      createGitFetcher({ gitBin: process.execPath, lookup: async () => ["10.0.0.7"] }).resolveRef(
        src({ url: "https://git.example/repo" }),
      ),
    /public network address/,
  );
  for (const address of ["64:ff9b:1::1", "fec0::1"]) {
    await assert.rejects(
      () =>
        createGitFetcher({ gitBin: process.execPath, lookup: async () => [address] }).resolveRef(
          src({ url: "https://git.example/repo" }),
        ),
      /public network address/,
    );
  }
});

test("pins public repository traffic to the validated address without redirects or proxies", async () => {
  const dir = mkdtempSync(join(tmpdir(), "qm-git-pin-"));
  const capture = join(dir, "env");
  const git = join(dir, "git");
  writeFileSync(git, `#!/bin/sh\nenv > '${capture}'\nprintf '0123456789abcdef0123456789abcdef01234567\\tHEAD\\n'\n`);
  chmodSync(git, 0o700);
  try {
    const sha = await createGitFetcher({ gitBin: git, lookup: async () => ["93.184.216.34"] }).resolveRef(
      src({ url: "https://git.example:444/repo" }),
    );
    assert.equal(sha, "0123456789abcdef0123456789abcdef01234567");
    const env = Object.fromEntries(
      readFileSync(capture, "utf8")
        .trim()
        .split("\n")
        .map((line) => {
          const i = line.indexOf("=");
          return [line.slice(0, i), line.slice(i + 1)];
        }),
    );
    assert.equal(env.GIT_CONFIG_COUNT, "3");
    assert.equal(env.GIT_CONFIG_KEY_0, "http.followRedirects");
    assert.equal(env.GIT_CONFIG_VALUE_0, "false");
    assert.equal(env.GIT_CONFIG_KEY_1, "http.curloptResolve");
    assert.equal(env.GIT_CONFIG_VALUE_1, "git.example:444:93.184.216.34");
    assert.equal(env.GIT_CONFIG_KEY_2, "http.proxy");
    assert.equal(env.GIT_CONFIG_VALUE_2, "");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("accepts a public IPv6-literal repository without DNS resolution", async () => {
  const dir = mkdtempSync(join(tmpdir(), "qm-git-ipv6-"));
  const capture = join(dir, "env");
  const git = join(dir, "git");
  writeFileSync(git, `#!/bin/sh\nenv > '${capture}'\nprintf '0123456789abcdef0123456789abcdef01234567\\tHEAD\\n'\n`);
  chmodSync(git, 0o700);
  try {
    const sha = await createGitFetcher({
      gitBin: git,
      lookup: async () => {
        throw new Error("unexpected lookup");
      },
    }).resolveRef(src({ url: "https://[2606:4700::1111]/repo" }));
    assert.equal(sha, "0123456789abcdef0123456789abcdef01234567");
    const env = Object.fromEntries(
      readFileSync(capture, "utf8")
        .trim()
        .split("\n")
        .map((line) => {
          const i = line.indexOf("=");
          return [line.slice(0, i), line.slice(i + 1)];
        }),
    );
    assert.equal(env.GIT_CONFIG_COUNT, "2");
    assert.equal(env.GIT_CONFIG_KEY_0, "http.followRedirects");
    assert.equal(env.GIT_CONFIG_VALUE_0, "false");
    assert.equal(env.GIT_CONFIG_KEY_1, "http.proxy");
    assert.equal(env.GIT_CONFIG_VALUE_1, "");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
