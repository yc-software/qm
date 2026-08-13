import { randomBytes } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const sourceConfig = resolve(root, "e2e", "qm.config.jsonc");
let activeConfig = sourceConfig;
const sandbox = resolve(root, "e2e", "sandbox");
const qmRepo = process.env.QM_REPO ? resolve(process.env.QM_REPO) : undefined;
if (!qmRepo) throw new Error("Set QM_REPO to a current yc-software/qm checkout");
const qm = resolve(qmRepo, "cli", "bin", "qm.ts");
const wslNode = process.env.QM_WSL_NODE;
const wslDistro = process.env.QM_WSL_DISTRO ?? "Ubuntu-24.04";
const relayEntry = resolve(root, "dist", "relay", "index.js");
const edgeEntry = resolve(root, "dist", "edge", "index.js");
const image = "inwise-qm-e2e:local";
const relayForSandbox = "http://host.docker.internal:18787";
const relayForHost = "http://127.0.0.1:18787";
const credentialVolume = `inwise-qm-e2e-${process.pid}-${randomBytes(4).toString("hex")}`;
const relayDatabaseContainer = `${credentialVolume}-postgres`;
const temporary = await mkdtemp(join(tmpdir(), "inwise-qm-deployed-e2e-"));
const envFile = join(temporary, ".env");
const runtimeConfig = join(temporary, "qm.config.jsonc");
const edgeConfig = join(temporary, "edge.json");
const children = [];
let deploymentStarted = false;
let dockerReady = false;
let relayDatabaseStarted = false;

function secret() {
  return randomBytes(32).toString("hex");
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd ?? root,
    env: { ...process.env, ...options.env },
    encoding: "utf8",
    stdio: options.capture ? "pipe" : "inherit",
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    const detail = options.capture ? `\n${result.stdout ?? ""}\n${result.stderr ?? ""}` : "";
    throw new Error(`${command} ${args.join(" ")} failed with exit code ${result.status}${detail}`);
  }
  return result.stdout ?? "";
}

function runQm(args, options = {}) {
  if (process.platform === "win32" && wslNode) {
    const linuxPath = (path) => {
      const match = path.match(/^([A-Za-z]):[\\/](.*)$/);
      if (!match) return path.replaceAll("\\", "/");
      return `/mnt/${match[1].toLowerCase()}/${match[2].replaceAll("\\", "/")}`;
    };
    const translated = args.map((value) => (value === qmRepo ? linuxPath(value) : value));
    return run(
      "wsl.exe",
      [
        "-d",
        wslDistro,
        "--",
        wslNode,
        linuxPath(qm),
        ...translated,
        "--config",
        linuxPath(activeConfig),
        "--env-file",
        linuxPath(envFile),
        "--sandbox-dir",
        linuxPath(sandbox),
      ],
      options,
    );
  }
  return run(
    process.execPath,
    [qm, ...args, "--config", activeConfig, "--env-file", envFile, "--sandbox-dir", sandbox],
    options,
  );
}

function runInSandbox(args, capture = false) {
  return run(
    "docker",
    [
      "run",
      "--rm",
      "--add-host",
      "host.docker.internal:host-gateway",
      "-e",
      `INWISE_QM_RELAY_URL=${relayForSandbox}`,
      "-v",
      `${credentialVolume}:/root/.config/inwise-qm`,
      image,
      "inwise",
      ...args,
    ],
    { capture },
  );
}

async function waitFor(url, label, timeoutMs = 30_000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(1_000) });
      if (response.ok) return;
    } catch {
      // The service may not be listening yet.
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 250));
  }
  throw new Error(`${label} did not become ready at ${url}`);
}

function startNode(entry, args, env) {
  const child = spawn(process.execPath, [entry, ...args], {
    cwd: root,
    env: { ...process.env, ...env },
    stdio: ["ignore", "inherit", "inherit"],
  });
  children.push(child);
  return child;
}

await writeFile(
  envFile,
  [
    `CAPABILITY_SECRET=${secret()}`,
    `CONNECTOR_SECRET_KEY=${secret()}`,
    `CORE_SIGNING_SECRET=${secret()}`,
    `PORTAL_IDENTITY_SECRET=${secret()}`,
    `SKILL_SIGNING_SECRET=${secret()}`,
    "",
  ].join("\n"),
  { mode: 0o600 },
);

try {
  if (process.platform === "win32" && !wslNode) {
    throw new Error("QM's Docker target requires a POSIX runtime; set QM_WSL_NODE to a Node 24 binary in WSL");
  }
  run("docker", ["version", "--format", "{{.Server.Version}}"], {
    capture: true,
  });
  dockerReady = true;
  const existingContainers = run(
    "docker",
    ["ps", "-a", "--filter", "name=qm-inwise-qm-e2e-", "--format", "{{.Names}}"],
    { capture: true },
  ).trim();
  const existingVolumes = run(
    "docker",
    ["volume", "ls", "--filter", "name=qm-inwise-qm-e2e-", "--format", "{{.Name}}"],
    { capture: true },
  ).trim();
  if (existingContainers || existingVolumes) {
    throw new Error("Refusing to reuse existing qm-inwise-qm-e2e Docker resources");
  }
  run(
    "docker",
    [
      "run",
      "-d",
      "--name",
      relayDatabaseContainer,
      "-e",
      "POSTGRES_PASSWORD=postgres",
      "-e",
      "POSTGRES_DB=inwise_relay",
      "-p",
      "127.0.0.1::5432",
      "postgres:16-alpine",
    ],
    { capture: true },
  );
  relayDatabaseStarted = true;
  let relayDatabaseReady = false;
  for (let attempt = 0; attempt < 60; attempt += 1) {
    const ready = spawnSync("docker", ["exec", relayDatabaseContainer, "pg_isready", "-U", "postgres"], {
      encoding: "utf8",
      stdio: "pipe",
    });
    if (ready.status === 0) {
      relayDatabaseReady = true;
      break;
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 250));
  }
  if (!relayDatabaseReady) throw new Error("Relay PostgreSQL did not become ready");
  const relayDatabasePort = run("docker", ["port", relayDatabaseContainer, "5432/tcp"], { capture: true })
    .trim()
    .split(":")
    .at(-1);
  if (!relayDatabasePort) throw new Error("Relay PostgreSQL port was not mapped");
  runQm(["check"]);
  runQm(["sandbox", "build", "--from", "node:24-slim", "--tag", image]);
  const imageId = run("docker", ["image", "inspect", image, "--format", "{{.Id}}"], { capture: true })
    .trim()
    .replace(/^sha256:/, "");
  const runtime = JSON.parse((await readFile(sourceConfig, "utf8")).replace(/,\s*([}\]])/g, "$1"));
  runtime.orgId = `inwise-qm-e2e-${randomBytes(4).toString("hex")}`;
  runtime.sandbox.image = `registry.fly.io/inwise-qm-e2e-sandboxes@sha256:${imageId}`;
  await writeFile(runtimeConfig, `${JSON.stringify(runtime, null, 2)}\n`);
  activeConfig = runtimeConfig;
  deploymentStarted = true;
  runQm(["up", "--build-from", qmRepo]);
  await waitFor("http://127.0.0.1:8080/healthz", "QM core", 60_000);
  runQm(["conformance"]);

  startNode(relayEntry, [], {
    PORT: "18787",
    INWISE_QM_PUBLIC_URL: relayForSandbox,
    INWISE_QM_DATABASE_URL: `postgres://postgres:postgres@127.0.0.1:${relayDatabasePort}/inwise_relay`,
  });
  await waitFor(`${relayForHost}/healthz`, "Inwise QM relay");

  const login = runInSandbox(["auth", "login", "--relay", relayForSandbox], true);
  const code = login.match(/Pairing code:\s*([A-Z2-9]+)/)?.[1];
  if (!code) throw new Error("Sandbox CLI did not return a pairing code");

  const paired = run(
    process.execPath,
    [edgeEntry, "pair", "--relay", relayForHost, "--code", code, "--name", "deployed-e2e"],
    {
      env: { INWISE_QM_EDGE_CONFIG: edgeConfig },
      capture: true,
    },
  );
  const verificationCode = paired.match(/Verification code:\s*([A-F0-9-]+)/)?.[1];
  if (!verificationCode) throw new Error("Laptop edge did not return a verification code");
  runInSandbox(["auth", "confirm", verificationCode]);
  startNode(edgeEntry, ["serve"], { INWISE_QM_EDGE_CONFIG: edgeConfig });

  runInSandbox(["auth", "status"]);
  runInSandbox(["status"], true);
  runInSandbox(
    ["call", "search_meetings", "--json", '{"query":"__inwise_qm_deployed_e2e_no_match__","limit":1}'],
    true,
  );

  console.log(
    JSON.stringify(
      {
        ok: true,
        qmCore: "live",
        qmConformance: "passed",
        qmOrgId: runtime.orgId,
        sandboxImage: image,
        sandboxCliPairing: "passed",
        keyConfirmation: "passed",
        localInwiseMcp: "queried",
        transcriptContentRead: false,
      },
      null,
      2,
    ),
  );
} finally {
  for (const child of children.reverse()) child.kill();
  if (dockerReady) {
    if (relayDatabaseStarted) {
      try {
        run("docker", ["rm", "-f", relayDatabaseContainer], {
          capture: true,
        });
      } catch {
        // Best-effort cleanup continues below.
      }
    }
    try {
      run("docker", ["volume", "rm", "-f", credentialVolume], {
        capture: true,
      });
    } catch {
      // Best-effort cleanup continues below.
    }
  }
  if (deploymentStarted) {
    try {
      runQm(["down", "--purge"]);
    } catch {
      // Best-effort cleanup continues below.
    }
  }
  await rm(temporary, { recursive: true, force: true });
}
