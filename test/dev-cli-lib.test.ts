import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { envSha, formatAge, readEnvFile } from "../scripts/dev/lib/util.ts";
import {
  clearSlotFlag,
  ensureStore,
  listSlots,
  readSlotFlag,
  slotFlagged,
  slotPorts,
  slotTokens,
  slotValid,
  writeSlotFlag,
} from "../scripts/dev/lib/pool.ts";
import {
  claimSlotLock,
  heartbeatFresh,
  leaseOrgId,
  leaseReclaimReason,
  leaseStale,
  LEGACY_TEARDOWN_PID_FILES,
  listLeases,
  lockDir,
  readMeta,
  releaseSlotLock,
  writeHeartbeat,
  writeMeta,
} from "../scripts/dev/lib/lease.ts";
import {
  assembleEnv,
  completeDevSecuritySecrets,
  configuredDatabaseUrl,
  devEnvironmentSha,
} from "../scripts/dev/lib/envctx.ts";
import { buildChildSpecs, type SpecInputs } from "../scripts/dev/supervisor/specs.ts";
import { DEFAULT_DEV_ADMIN_PRINCIPAL, emailAdminsFromSeed, selectEmailAdmin } from "../scripts/dev/lib/admin.ts";
import { restrictSupervisorSocket, supervisorSocketLocation } from "../scripts/dev/lib/socket.ts";
import { waitForSupervisor } from "../scripts/dev/lib/client.ts";
import { localPostgresUrl } from "../scripts/dev/lib/postgres.ts";
import { loadConfig, OPENCODE_RUNTIME_VERSION } from "../src/config.ts";
import type { LeaseInfo } from "../scripts/dev/lib/types.ts";

function tmpStore(): string {
  const store = mkdtempSync(join(tmpdir(), "qm-dev-test-"));
  ensureStore(store);
  return store;
}

function addSlot(store: string, n: number, extra = ""): void {
  writeFileSync(
    join(store, `pool${n}.env`),
    `SLACK_BOT_TOKEN=xoxb-test-${n}\nSLACK_APP_TOKEN=xapp-test-${n}\nHANDLE=bot${n}\n${extra}`,
  );
}

test("slotPorts derive the full port block from the slot number", () => {
  const ports = slotPorts("pool3", 8080);
  assert.deepEqual(ports, {
    core: 8083,
    web: 8099,
    admin: 8115,
    portal: 8131,
    prodProxy: 8147,
    slackHealth: 8163,
    supervisor: 8179,
    auth: 8195,
  });
});

test("legacy teardown covers every supervised service, including Auth", () => {
  assert.deepEqual(
    ["core", "auth", "web", "admin", "portal"].filter((name) => !LEGACY_TEARDOWN_PID_FILES.includes(`${name}.pid`)),
    [],
  );
});

test("real email dev setup selects only email-shaped administrator seeds", () => {
  assert.equal(DEFAULT_DEV_ADMIN_PRINCIPAL, "dev-admin@example.test");
  assert.deepEqual(emailAdminsFromSeed("root:org_admin,Admin@Example.com:org_admin"), ["admin@example.com"]);
  assert.deepEqual(emailAdminsFromSeed("a@example.com:org_admin,b@example.com:org_admin"), [
    "a@example.com",
    "b@example.com",
  ]);
  assert.deepEqual(emailAdminsFromSeed("slack:U123:org_admin,viewer@example.com:viewer"), []);
  assert.equal(selectEmailAdmin(["a@example.com"], undefined), "a@example.com");
  assert.equal(selectEmailAdmin(["a@example.com", "b@example.com"], undefined), "");
  assert.equal(selectEmailAdmin(["a@example.com", "b@example.com"], "B@Example.com"), "b@example.com");
  assert.equal(selectEmailAdmin(["a@example.com"], "missing@example.com"), "");
});

test("long supervisor socket paths use a private directory and a restricted socket", () => {
  const root = mkdtempSync("/tmp/qm-dev-socket-");
  const prior = process.umask(0);
  try {
    const location = supervisorSocketLocation(`${root}/${"x".repeat(120)}`, "pool9", root);
    assert.ok(location.tempDir);
    assert.equal(statSync(location.tempDir).mode & 0o777, 0o700);
    writeFileSync(location.path, "");
    restrictSupervisorSocket(location.path);
    assert.equal(statSync(location.path).mode & 0o777, 0o600);
  } finally {
    process.umask(prior);
    rmSync(root, { recursive: true, force: true });
  }
});

test("supervisor readiness re-resolves a socket path while state is appearing", async () => {
  let resolutions = 0;
  const ready = await waitForSupervisor(() => {
    resolutions += 1;
    return `/tmp/qm-dev-missing-${process.pid}-${resolutions}.sock`;
  }, 650);
  assert.equal(ready, false);
  assert.ok(resolutions >= 2);
});

test("pool listing, token parsing, and validity", () => {
  const store = tmpStore();
  addSlot(store, 2, "CANARY_CHANNEL=C0TEST\n");
  addSlot(store, 10);
  writeFileSync(join(store, "pool0.env"), "junk");
  writeFileSync(join(store, "poolx.env"), "junk");
  assert.deepEqual(listSlots(store), ["pool2", "pool10"]);
  const tokens = slotTokens("pool2", store);
  assert.equal(tokens.handle, "bot2");
  assert.equal(tokens.canaryChannel, "C0TEST");
  assert.equal(slotValid("pool2", store), true);
  writeFileSync(join(store, "pool3.env"), "SLACK_BOT_TOKEN=nope\nSLACK_APP_TOKEN=xapp-x\n");
  assert.equal(slotValid("pool3", store), false);
  rmSync(store, { recursive: true, force: true });
});

test("pool token parsing accepts quoted dotenv values", () => {
  const store = tmpStore();
  writeFileSync(
    join(store, "pool1.env"),
    "SLACK_BOT_TOKEN=\"xoxb-quoted\"\nSLACK_APP_TOKEN='xapp-quoted'\nHANDLE=\"bot1\"\nCANARY_CHANNEL='C0TEST'\n",
  );
  assert.deepEqual(slotTokens("pool1", store), {
    botToken: "xoxb-quoted",
    appToken: "xapp-quoted",
    handle: "bot1",
    canaryChannel: "C0TEST",
    extra: {
      SLACK_BOT_TOKEN: "xoxb-quoted",
      SLACK_APP_TOKEN: "xapp-quoted",
      HANDLE: "bot1",
      CANARY_CHANNEL: "C0TEST",
    },
  });
  assert.equal(slotValid("pool1", store), true);
  rmSync(store, { recursive: true, force: true });
});

test("slot flags expire after their TTL", () => {
  const store = tmpStore();
  addSlot(store, 1);
  writeSlotFlag("pool1", { reason: "stolen", at: 1000 }, store);
  assert.equal(slotFlagged("pool1", store, 1000 + 60), true);
  assert.equal(slotFlagged("pool1", store, 1000 + 31 * 60), false);
  assert.equal(readSlotFlag("pool1", store), null);
  writeSlotFlag("pool1", { reason: "stolen", at: 2000 }, store);
  clearSlotFlag("pool1", store);
  assert.equal(readSlotFlag("pool1", store), null);
  rmSync(store, { recursive: true, force: true });
});

test("lease claim is exclusive until released", () => {
  const store = tmpStore();
  assert.equal(claimSlotLock("pool1", store), true);
  assert.equal(claimSlotLock("pool1", store), false);
  releaseSlotLock("pool1", store);
  assert.equal(claimSlotLock("pool1", store), true);
  rmSync(store, { recursive: true, force: true });
});

test("meta round-trips and lease staleness follows pids + heartbeat", () => {
  const store = tmpStore();
  claimSlotLock("pool1", store);
  const lock = lockDir("pool1", store);
  const worktree = mkdtempSync(join(tmpdir(), "qm-wt-"));
  writeMeta(lock, { slot: "pool1", worktree, booting: "1", owner_pid: String(process.pid) });
  assert.equal(readMeta(lock).worktree, worktree);

  let lease = listLeases(store)[0] as LeaseInfo;
  assert.equal(leaseStale(lease), false);

  writeMeta(lock, { slot: "pool1", worktree, booting: "1", owner_pid: "999999999" });
  lease = listLeases(store)[0] as LeaseInfo;
  assert.equal(leaseStale(lease), true);

  writeHeartbeat(lock, "live");
  lease = listLeases(store)[0] as LeaseInfo;
  assert.equal(heartbeatFresh(lease), true);
  assert.equal(leaseStale(lease), false);

  writeMeta(lock, { slot: "pool1", worktree: join(worktree, "deleted-subdir") });
  lease = listLeases(store)[0] as LeaseInfo;
  assert.equal(leaseStale(lease), true);

  rmSync(worktree, { recursive: true, force: true });
  rmSync(store, { recursive: true, force: true });
});

test("reclaim never touches a lease with a fresh heartbeat and live supervisor", () => {
  const store = tmpStore();
  claimSlotLock("pool1", store);
  const lock = lockDir("pool1", store);
  const worktree = mkdtempSync(join(tmpdir(), "qm-wt-"));
  const oldEpoch = Math.floor(Date.now() / 1000) - 3 * 86_400;
  writeMeta(lock, { slot: "pool1", worktree, created_epoch: String(oldEpoch) });
  writeHeartbeat(lock, "live");
  const lease = listLeases(store)[0] as LeaseInfo;
  assert.equal(leaseReclaimReason(lease), null);
  rmSync(worktree, { recursive: true, force: true });
  rmSync(store, { recursive: true, force: true });
});

test("legacy lease (no heartbeat) keeps the not-today age reclaim rule", () => {
  const store = tmpStore();
  claimSlotLock("pool1", store);
  const lock = lockDir("pool1", store);
  const worktree = mkdtempSync(join(tmpdir(), "qm-wt-"));
  const oldEpoch = Math.floor(Date.now() / 1000) - 3 * 86_400;
  writeMeta(lock, { slot: "pool1", worktree, created_epoch: String(oldEpoch) });
  const lease = listLeases(store)[0] as LeaseInfo;
  assert.match(leaseReclaimReason(lease) ?? "", /not today/);
  rmSync(worktree, { recursive: true, force: true });
  rmSync(store, { recursive: true, force: true });
});

test("env assembly precedence: caller > login shell > dev.env > worktree .env; harness gates", async () => {
  const worktree = mkdtempSync(join(tmpdir(), "qm-wt-"));
  mkdirSync(join(worktree, ".git"));
  writeFileSync(
    join(worktree, ".env"),
    "ANTHROPIC_API_KEY=from-dotenv\nCORE_SIGNING_SECRET=sekrit\nCAPABILITY_SECRET=cap\nPORTAL_IDENTITY_SECRET=identity\nCONNECTOR_SECRET_KEY=connector\nPORTAL_SESSION_SECRET=session\nBOTH=dotenv\n",
  );
  const liveEnv = join(worktree, "dev.env");
  writeFileSync(liveEnv, "ANTHROPIC_API_KEY=from-liveenv\nLIVE_ONLY=live\n");
  const prevLive = process.env.QM_DEV_ENV;
  process.env.QM_DEV_ENV = liveEnv;
  const noise: string[] = [];
  const log = (m: string) => noise.push(m);

  const fromCaller = await assembleEnv({
    worktree,
    callerEnv: { ANTHROPIC_API_KEY: "from-caller", BOTH: "caller" },
    allowMock: false,
    log,
    probeLoginShell: async () => "",
  });
  assert.equal(fromCaller.env.ANTHROPIC_API_KEY, "from-caller");
  assert.equal(fromCaller.env.BOTH, "caller");
  assert.equal(fromCaller.harness, "pi");
  assert.equal(fromCaller.env.HARNESS, "pi");
  assert.equal(fromCaller.env.PI_CAPTURE_REQUESTS, "1");
  assert.equal(fromCaller.anthropicKeySource, "your shell export");

  const openCode = await assembleEnv({
    worktree,
    callerEnv: { ANTHROPIC_API_KEY: "from-caller", HARNESS: "opencode" },
    allowMock: false,
    log,
    probeLoginShell: async () => "",
  });
  assert.equal(openCode.harness, "opencode");
  assert.equal(openCode.env.HARNESS, "opencode");
  assert.equal(openCode.env.PI_CAPTURE_REQUESTS, undefined);

  await assert.rejects(
    assembleEnv({ worktree, callerEnv: { HARNESS: "codex" }, allowMock: false, log, probeLoginShell: async () => "" }),
    /HARNESS=codex needs OPENAI_API_KEY/,
  );
  const codex = await assembleEnv({
    worktree,
    callerEnv: { HARNESS: "codex", OPENAI_API_KEY: "sk-openai" },
    allowMock: false,
    log,
    probeLoginShell: async () => "",
  });
  assert.equal(codex.harness, "codex");
  assert.equal(codex.env.HARNESS, "codex");
  assert.equal(codex.openaiKeySource, "your shell export");

  const claude = await assembleEnv({
    worktree,
    callerEnv: { HARNESS: "claude" },
    allowMock: false,
    log,
    probeLoginShell: async () => "",
  });
  assert.equal(claude.harness, "claude");
  assert.equal(claude.env.HARNESS, "claude");

  const fromLiveEnv = await assembleEnv({
    worktree,
    callerEnv: {},
    allowMock: false,
    log,
    probeLoginShell: async () => "",
  });
  assert.equal(fromLiveEnv.env.ANTHROPIC_API_KEY, "from-liveenv");
  assert.equal(fromLiveEnv.env.LIVE_ONLY, "live");
  assert.equal(fromLiveEnv.env.CORE_SIGNING_SECRET, "sekrit");
  assert.equal(fromLiveEnv.env.CAPABILITY_SECRET, "cap");
  assert.equal(fromLiveEnv.env.PORTAL_IDENTITY_SECRET, "identity");
  assert.equal(fromLiveEnv.env.CONNECTOR_SECRET_KEY, "connector");
  assert.equal(fromLiveEnv.env.PORTAL_SESSION_SECRET, "session");
  assert.equal(fromLiveEnv.anthropicKeySource, liveEnv);

  const fromShell = await assembleEnv({
    worktree,
    callerEnv: {},
    allowMock: false,
    log,
    probeLoginShell: async () => "from-shell",
  });
  assert.equal(fromShell.env.ANTHROPIC_API_KEY, "from-shell", "login-shell key outranks a stale dev.env key");
  assert.equal(fromShell.anthropicKeySource, "your login-shell profile");

  writeFileSync(liveEnv, "");
  const fromDotenv = await assembleEnv({
    worktree,
    callerEnv: {},
    allowMock: false,
    log,
    probeLoginShell: async () => "",
  });
  assert.equal(fromDotenv.env.ANTHROPIC_API_KEY, "from-dotenv");
  assert.equal(fromDotenv.anthropicKeySource, "the worktree .env");

  writeFileSync(join(worktree, ".env"), "");
  await assert.rejects(
    assembleEnv({ worktree, callerEnv: {}, allowMock: false, log, probeLoginShell: async () => "" }),
    /ANTHROPIC_API_KEY is required/,
  );
  const mock = await assembleEnv({ worktree, callerEnv: {}, allowMock: true, log, probeLoginShell: async () => "" });
  assert.equal(mock.harness, "mock");
  if (prevLive === undefined) delete process.env.QM_DEV_ENV;
  else process.env.QM_DEV_ENV = prevLive;
  rmSync(worktree, { recursive: true, force: true });
});

test("dev security secrets are stable, complete, and distinct", () => {
  const first: Record<string, string> = {};
  const second: Record<string, string> = {};
  completeDevSecuritySecrets(first, "postgres://dev");
  completeDevSecuritySecrets(second, "postgres://dev");
  assert.deepEqual(first, second);
  assert.equal(new Set(Object.values(first)).size, 8);
  const jwk = JSON.parse(first.AUTH_SIGNING_JWK!) as Record<string, unknown>;
  assert.deepEqual({ kty: jwk.kty, crv: jwk.crv }, { kty: "EC", crv: "P-256" });
  for (const name of ["d", "x", "y"]) assert.equal(typeof jwk[name], "string");
  assert.throws(
    () => completeDevSecuritySecrets({ CORE_SIGNING_SECRET: "same", CAPABILITY_SECRET: "same" }, "postgres://dev"),
    /must be distinct/,
  );
});

test("dev environment fingerprints include the resolved database across source changes", () => {
  const root = mkdtempSync(join(tmpdir(), "qm-dev-database-"));
  const explicitSecrets = {
    CORE_SIGNING_SECRET: "core",
    CAPABILITY_SECRET: "capability",
    PORTAL_IDENTITY_SECRET: "identity",
    CONNECTOR_SECRET_KEY: "connector",
    PORTAL_SESSION_SECRET: "session",
    AUTH_TOKEN_SECRET: "token",
    AUTH_CLIENT_SECRET: "client",
    AUTH_SIGNING_JWK: "jwk",
  };
  try {
    writeFileSync(join(root, ".env"), "DATABASE_URL=postgres://external-a/qm\n");
    const firstUrl = configuredDatabaseUrl(root, explicitSecrets);
    const firstHash = devEnvironmentSha(explicitSecrets, firstUrl, "configured");

    writeFileSync(join(root, ".env"), "");
    const localUrl = localPostgresUrl(root, explicitSecrets);
    assert.notEqual(devEnvironmentSha(explicitSecrets, localUrl, "local"), firstHash);

    writeFileSync(join(root, ".env"), "DATABASE_URL=postgres://external-b/qm\n");
    const secondUrl = configuredDatabaseUrl(root, explicitSecrets);
    assert.notEqual(devEnvironmentSha(explicitSecrets, secondUrl, "configured"), firstHash);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("OpenCode config is strict, pinned, and inherits the Pi model", () => {
  assert.equal(OPENCODE_RUNTIME_VERSION, "1.17.18");
  assert.equal(loadConfig({ HARNESS: "opencode", PI_MODEL: "pi-model" }).opencodeModel, "pi-model");
  assert.equal(
    loadConfig({ HARNESS: "opencode", PI_MODEL: "pi-model", OPENCODE_MODEL: "open-model" }).opencodeModel,
    "open-model",
  );
  const codexEnv = { HARNESS: "codex", OPENAI_API_KEY: "sk-openai" };
  assert.equal(loadConfig({ ...codexEnv, CODEX_MODEL: "gpt-5.4", CODEX_BIN: "/bin/codex" }).codexModel, "gpt-5.4");
  assert.equal(loadConfig({ ...codexEnv, CODEX_BIN: "/bin/codex" }).codexBinPath, "/bin/codex");
  assert.equal(
    loadConfig({ HARNESS: "claude", CLAUDE_MODEL: "claude-opus-4-8", CLAUDE_BIN: "/bin/claude" }).claudeModel,
    "claude-opus-4-8",
  );
  assert.equal(loadConfig({ HARNESS: "claude", CLAUDE_BIN: "/bin/claude" }).claudeBinPath, "/bin/claude");
  assert.throws(() => loadConfig({ HARNESS: "bogus" }), /use mock, pi, opencode, codex, or claude/);
  assert.throws(() => loadConfig({ HARNESS: "PI" }), /use mock, pi, opencode, codex, or claude/);
});

test("envSha is order-independent and value-sensitive", () => {
  assert.equal(envSha({ A: "1", B: "2" }), envSha({ B: "2", A: "1" }));
  assert.notEqual(envSha({ A: "1" }), envSha({ A: "2" }));
});

test("readEnvFile keeps everything after the first '=' verbatim and skips bad keys", () => {
  const dir = mkdtempSync(join(tmpdir(), "qm-env-"));
  writeFileSync(join(dir, "x.env"), "GOOD=a=b=c\nHASH=abc#def\n1BAD=x\n# comment\nEMPTY=\n");
  const env = readEnvFile(join(dir, "x.env"));
  assert.deepEqual(env, { GOOD: "a=b=c", HASH: "abc#def", EMPTY: "" });
  rmSync(dir, { recursive: true, force: true });
});

test("leaseOrgId reads the stale lease's booted org", () => {
  const store = tmpStore();
  addSlot(store, 1);
  claimSlotLock("pool1", store);
  const lock = lockDir("pool1", store);
  writeFileSync(join(lock, "boot-spec.json"), JSON.stringify({ callerEnv: { DEV_INSTANCE_ORG_ID: "beta" } }));
  const lease = listLeases(store)[0]!;
  assert.equal(leaseOrgId(lease), "beta");
  rmSync(join(lock, "boot-spec.json"));
  assert.equal(leaseOrgId(lease), "acme");
  rmSync(store, { recursive: true, force: true });
});

test("supervised children share the selected dev org", () => {
  const inputs: SpecInputs = {
    worktree: "/tmp/worktree",
    ports: slotPorts("pool1"),
    baseEnv: { DEV_INSTANCE_ORG_ID: "beta" },
    watch: false,
    webUiBasePath: "/",
    slack: { botToken: "xoxb-test", appToken: "xapp-test" },
    sessionStore: "memory",
    runStore: "memory",
    databaseUrl: "",
    adminGrantsSeed: "",
    coreSigningSecret: "",
    portalSessionSecret: "secret",
    portalDevPrincipal: "U1",
    sandboxEnv: {},
  };
  const specs = buildChildSpecs(inputs);
  assert.deepEqual(
    specs.map((spec) => spec.name),
    ["core", "auth", "web", "admin", "portal"],
  );
  assert.equal(specs.find((spec) => spec.name === "core")!.env.ORG_ID, "beta");
  assert.equal(specs.find((spec) => spec.name === "core")!.env.AUTH_SERVICE_URL, "http://localhost:8193");
  assert.equal(specs.find((spec) => spec.name === "auth")!.env.AUTH_ISSUER, "http://localhost:8129/idp");
  assert.equal(specs.find((spec) => spec.name === "portal")!.env.AUTH_BROKER_UPSTREAM, "http://localhost:8193");
  assert.equal(specs.find((spec) => spec.name === "portal")!.env.PORTAL_LOCAL_AUTH_BYPASS, "1");
  for (const spec of specs) assert.equal(spec.env.CORE_ORG_ID, "beta");
  inputs.baseEnv = {};
  assert.equal(buildChildSpecs(inputs).find((spec) => spec.name === "core")!.env.ORG_ID, "acme");
  inputs.baseEnv = { DEV_INSTANCE_PORTAL_AUTH_BYPASS: "0" };
  assert.equal(buildChildSpecs(inputs).find((spec) => spec.name === "portal")!.env.PORTAL_LOCAL_AUTH_BYPASS, "0");
});

test("child specs omit Slack env when no Slack tokens are supplied", () => {
  const inputs: SpecInputs = {
    worktree: "/tmp/worktree",
    ports: slotPorts("pool1"),
    baseEnv: {},
    watch: false,
    webUiBasePath: "/",
    sessionStore: "memory",
    runStore: "memory",
    databaseUrl: "",
    adminGrantsSeed: "",
    coreSigningSecret: "",
    portalSessionSecret: "secret",
    portalDevPrincipal: "U1",
    sandboxEnv: {},
  };
  const core = buildChildSpecs(inputs).find((spec) => spec.name === "core")!;
  assert.equal(core.env.SLACK_BOT_TOKEN, undefined);
  assert.equal(core.env.SLACK_APP_TOKEN, undefined);
  assert.equal(core.env.DEV_INTROSPECTION, undefined);
  assert.equal(core.env.DEV_HEALTH_PORT, undefined);
  assert.equal(core.env.CORE_ORG_ID, "acme");
});

test("formatAge renders the bash-compatible shapes", () => {
  assert.equal(formatAge(42), "42s");
  assert.equal(formatAge(150), "2m");
  assert.equal(formatAge(3 * 3600 + 5 * 60), "3h05m");
  assert.equal(formatAge(2 * 86400 + 3 * 3600), "2d03h");
});
