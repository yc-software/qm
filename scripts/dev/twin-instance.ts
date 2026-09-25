import { fileURLToPath } from "node:url";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { provisionTwinEnvironment, teardownTwinEnvironment } from "../../test/live-slack/arga-provision.ts";
import { readEnvFile } from "./lib/util.ts";

const root = fileURLToPath(new URL("../..", import.meta.url)).replace(/\/$/, "");
const dir = join(root, ".twin-instance");
const envFile = join(dir, "env");
const pumpPid = join(dir, "pump.pid");

function loadEnvFile(): Record<string, string> {
  return readEnvFile(envFile);
}

async function up(): Promise<void> {
  if (existsSync(envFile)) throw new Error(`.twin-instance/ already exists — run "down" first`);
  mkdirSync(dir, { recursive: true });
  const bootEnv = await provisionTwinEnvironment(480);
  writeFileSync(
    envFile,
    Object.entries(bootEnv)
      .map(([k, v]) => `${k}=${v}`)
      .join("\n") + "\n",
  );

  const boot = spawnSync(process.execPath, [join(root, "cli/bin/qm.ts"), "dev", "--ci", "up"], {
    cwd: root,
    env: { ...process.env, ...bootEnv },
    stdio: "inherit",
  });
  if (boot.status !== 0) {
    await teardownTwinEnvironment(process.env.ARGA_API_KEY!, bootEnv.ARGA_TWIN_RUN_ID).catch(() => {});
    rmSync(dir, { recursive: true, force: true });
    throw new Error("instance boot failed — twin torn down");
  }

  const log = openSync(join(dir, "pump.log"), "a");
  const pump = spawn(process.execPath, [join(root, "scripts/dev/twin-pump.ts")], {
    cwd: root,
    env: { ...process.env, ...bootEnv },
    detached: true,
    stdio: ["ignore", log, log],
  });
  pump.unref();
  writeFileSync(pumpPid, String(pump.pid));

  console.log(`\ntwin dev instance up — workspace ${bootEnv.SLACK_API_URL}`);
  console.log(`  dashboard (post as any seeded user): ${bootEnv.SLACK_API_URL}`);
  console.log(`  qa token: ${bootEnv.SLACK_QA_USER_TOKEN}`);
  console.log(`  tear down: node scripts/dev/twin-instance.ts down`);
}

async function down(): Promise<void> {
  const saved = loadEnvFile();
  if (existsSync(pumpPid)) {
    const pid = Number(readFileSync(pumpPid, "utf8"));
    if (Number.isFinite(pid) && pid > 1) {
      try {
        process.kill(pid, "SIGTERM");
      } catch {
        void 0;
      }
    }
  }
  spawnSync(process.execPath, [join(root, "cli/bin/qm.ts"), "dev", "--ci", "down"], { cwd: root, stdio: "inherit" });
  if (saved.ARGA_TWIN_RUN_ID && process.env.ARGA_API_KEY) {
    await teardownTwinEnvironment(process.env.ARGA_API_KEY, saved.ARGA_TWIN_RUN_ID).catch((err: Error) =>
      console.error(`twin teardown failed (it expires at TTL anyway): ${err.message}`),
    );
  } else if (saved.ARGA_TWIN_RUN_ID) {
    console.log("ARGA_API_KEY not set — twin left to expire at its TTL");
  }
  rmSync(dir, { recursive: true, force: true });
  console.log("twin dev instance down");
}

const cmd = process.argv[2];
let run: (() => Promise<void>) | null = null;
if (cmd === "up") run = up;
else if (cmd === "down") run = down;
if (!run) {
  console.error("usage: node scripts/dev/twin-instance.ts up|down");
  process.exit(2);
}
run().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
