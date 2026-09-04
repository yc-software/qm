import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSpritesSandbox } from "../src/sandbox/sprites-sandbox.ts";
import { supportsProcessSessions } from "../src/sandbox/sandbox.ts";
import { createLocalWorkspaceStore } from "../src/workspace/workspace-store.ts";
import { scopeId, type TurnRequest, type TurnResult } from "../src/types.ts";
import { createMemoryProcessRegistry } from "../src/processes/process-registry.ts";
import { createBackgroundBroker } from "../src/connectors/background-exec-broker.ts";
import { createMonitorStore } from "../src/monitors/monitor-store.ts";
import { createMonitorBroker, readBackgroundOutputTail } from "../src/monitors/monitor-broker.ts";
import { createMonitorPoller } from "../src/monitors/monitor-poller.ts";
import { createDeliveryStore } from "../src/delivery/delivery-store.ts";
import { createIdempotencyStore } from "../src/idempotency/idempotency-store.ts";
import { createIdentityService } from "../src/identity/identity-service.ts";
import { loadConfig } from "../src/config.ts";

if (!process.env.SPRITES_TOKEN) {
  console.error("set SPRITES_TOKEN (mint one with `sprite login`)");
  process.exit(1);
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const ok = (cond: boolean, msg: string): void => {
  if (!cond) throw new Error("ASSERT FAILED: " + msg);
  console.log("  ✓", msg);
};
const ts = (): string => new Date().toISOString().slice(11, 19);

const JOB_SH = `set -e
export HF_HOME="$PWD/hf-cache"
echo "PHASE: creating venv + installing torch (cpu) + diffusers — the big download"
python3 -m venv "$PWD/dvenv"
"$PWD/dvenv/bin/pip" install --quiet --upgrade pip
"$PWD/dvenv/bin/pip" install --quiet --no-cache-dir "torch>=2.6" --index-url https://download.pytorch.org/whl/cpu
"$PWD/dvenv/bin/pip" install --quiet --no-cache-dir diffusers transformers accelerate safetensors pillow
echo "PHASE: deps installed; fetching segmind/tiny-sd weights"
"$PWD/dvenv/bin/python" diffusion.py
echo "PHASE: done"
`;

const DIFFUSION_PY = `import torch
from diffusers import StableDiffusionPipeline
print("PHASE: loading/downloading segmind/tiny-sd", flush=True)
pipe = StableDiffusionPipeline.from_pretrained(
    "segmind/tiny-sd", torch_dtype=torch.float32, safety_checker=None, requires_safety_checker=False
)
print("PHASE: model ready; generating a 256x256 image on CPU", flush=True)
img = pipe("a tiny pirate flag on a desert island, watercolor", num_inference_steps=8, height=256, width=256).images[0]
img.save("diffusion-out.png")
print("PHASE: image saved diffusion-out.png", flush=True)
`;

const ws = createLocalWorkspaceStore(mkdtempSync(join(tmpdir(), "monitor-smoke-")));
const sb = createSpritesSandbox(ws, loadConfig().spritesSandbox);
if (!supportsProcessSessions(sb)) throw new Error("Sprites sandbox does not advertise process sessions");

const scope = scopeId("personal", "qm-monitor-smoke");
const owner = "qm-monitor-smoke";
const threadRef = "monitor-smoke-thread";
const destination = { type: "smoke", target: "smoke-dm", audienceScopeId: scope };

const registry = createMemoryProcessRegistry();
const monitors = createMonitorStore();
const deliveries = createDeliveryStore();
const broker = createBackgroundBroker({ sandbox: sb, registry, scopeId: scope, pollMs: 4000, ttlMaxMs: 60 * 60_000 });
let h: Awaited<ReturnType<typeof sb.provision>> | undefined;
const monitorBroker = createMonitorBroker({
  store: monitors,
  registry,
  readOutputTail: async (processId, maxBytes) => {
    if (!h) return { outputTail: "" };
    const handle = h;
    return readBackgroundOutputTail(maxBytes, async (cursor, readMaxBytes) => {
      const read = await broker.poll(handle, processId, { sinceCursor: cursor, maxBytes: readMaxBytes, waitMs: 0 });
      return {
        chunks: read.chunks,
        cursor: read.cursor,
        ...(read.status.state === "exited" ? { exitCode: read.status.code } : {}),
      };
    });
  },
  scopeId: scope,
  owner,
  ownerScopeId: scope,
  threadRef,
  destination,
});

const wakes: TurnRequest[] = [];
const poller = createMonitorPoller({
  monitors,
  processes: registry,
  sandbox: sb,
  deliveries,
  idempotency: createIdempotencyStore(),
  identity: createIdentityService(),
  run: async (req: TurnRequest): Promise<TurnResult> => {
    wakes.push(req);
    console.log(
      `\n[${ts()}] ─── WAKE ${wakes.length} fired into thread=${req.conversation.threadRef} (surface=${req.surface}) ───`,
    );
    console.log(
      req.text
        .split("\n")
        .map((l) => "  │ " + l)
        .join("\n"),
    );
    return { status: "ok", reply: `update ${wakes.length}: noted` };
  },
});

try {
  console.log(`[${ts()}] provisioning sprite for`, scope, "…");
  h = await sb.provision([{ scopeId: scope, mountPath: "", mode: "rw" }]);

  console.log(`[${ts()}] staging job.sh + diffusion.py into the workspace …`);
  await sb.writeFile(h, "job.sh", JOB_SH);
  await sb.writeFile(h, "diffusion.py", DIFFUSION_PY);

  console.log(`[${ts()}] background-start the diffusion job (ttl 60min) …`);
  const s = await broker.start(h, "bash job.sh", 60 * 60_000);
  ok(!!s.processId && s.status.state === "running", `job ${s.processId} is running`);
  console.log("    early output:", JSON.stringify(s.output.trim().split("\n").slice(0, 2)));

  console.log(`[${ts()}] arm the watch (pattern-filtered to PHASE/error lines) …`);
  const w = await monitorBroker.watch(s.processId, {
    pattern: "^PHASE:|Traceback|ERROR|error:",
    instructions: "Briefly tell the user how the diffusion-model download/generation is going.",
    sinceCursor: s.cursor,
  });
  if ("completed" in w) throw new Error(`job already ${w.registryStatus} before watch could be armed`);
  ok(!w.reattached, `watch armed (monitor ${w.monitorId}, expires ${new Date(w.expiresAt).toISOString()})`);

  console.log(`[${ts()}] polling every 10s until the exit wake (cap 35min) …`);
  const deadline = Date.now() + 35 * 60_000;
  let exited = false;
  while (Date.now() < deadline && !exited) {
    await poller.tick();
    const m = await monitors.get(w.monitorId);
    if (m && !m.enabled) exited = true;
    else await sleep(10_000);
  }

  ok(exited, "watch disarmed itself after the job ended");
  ok(wakes.length >= 2, `≥2 wakes fired (got ${wakes.length}: progress + exit)`);
  ok(
    wakes.some((q) => /exited with code/.test(q.text)),
    "an exit wake reported the final status",
  );
  ok(
    wakes.every((q) => q.conversation.threadRef === threadRef),
    "every wake landed in the arming conversation",
  );
  ok(
    wakes.every((q) => !/Successfully installed|Collecting /.test(q.text)),
    "pattern filter kept pip noise out of wakes",
  );
  const pending = await deliveries.pending("smoke");
  ok(pending.length === wakes.length, `one delivery per wake (${pending.length})`);

  const exitWake = wakes.find((q) => /exited with code/.test(q.text));
  const cleanExit = /exited with code 0/.test(exitWake?.text ?? "");
  if (!cleanExit) {
    console.log(`\n[${ts()}] job FAILED — full job log (what \`background poll\` would show):`);
    let cursor = 0;
    let log = "";
    for (let i = 0; i < 50; i++) {
      const p = await broker.poll(h, s.processId, { sinceCursor: cursor });
      log += p.chunks;
      if (p.cursor === cursor) break;
      cursor = p.cursor;
    }
    console.log(
      log
        .split("\n")
        .slice(-80)
        .map((l) => "  ▸ " + l)
        .join("\n"),
    );
  }
  ok(cleanExit, "diffusion job exited 0");
  const img = await sb.readFileBytes(h, "diffusion-out.png");
  ok(!!img && img.length > 10_000, `generated image exists in the sandbox (${img?.length ?? 0} bytes)`);
  const out = join(tmpdir(), "monitor-smoke-diffusion.png");
  writeFileSync(out, img!);
  console.log("    saved locally:", out);

  console.log("\nALL MONITOR SMOKE CHECKS PASSED ✅");
} finally {
  console.log(`[${ts()}] tearing down: destroying the smoke sprite …`);
  if (h) await sb.teardown(h, { destroy: true });
}
