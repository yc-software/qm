import { ModalClient, AlreadyExistsError } from "modal";

const log = (step, ok, detail = "") => console.log(`${ok ? "PASS" : "FAIL"}  ${step}${detail ? " — " + detail : ""}`);
const info = (step, detail) => console.log(`INFO  ${step} — ${detail}`);
const t0 = Date.now();
const el = () => `${((Date.now() - t0) / 1000).toFixed(1)}s`;
const errShape = (e) => `${e?.constructor?.name ?? "?"}/${e?.name ?? "?"}: ${String(e?.message ?? e).slice(0, 120)}`;
const sleep = (ms) => new Promise((res) => setTimeout(res, ms));

const APP = process.env.MODAL_APP_NAME ?? "qm-smoke";
const IMAGE = process.env.MODAL_IMAGE ?? "ubuntu:24.04";
const NAME = `qm-smoke-${Date.now().toString(36)}`;

info(
  "proxy posture",
  `HTTPS_PROXY=${process.env.HTTPS_PROXY ?? "(unset)"} grpc_proxy=${process.env.grpc_proxy ?? "(unset)"}`,
);

const modal = new ModalClient();
let sb;
let racer;
let idler;
try {
  const app = await modal.apps.fromName(APP, { createIfMissing: true });
  log("auth + app lookup (through any configured proxy)", true, `app=${APP} (${el()})`);
  const image = modal.images.fromRegistry(IMAGE);

  const ct = Date.now();
  sb = await modal.sandboxes.create(app, image, { name: NAME, timeoutMs: 30 * 60_000 });
  const first = await sb.exec(["sh", "-c", "echo ready"], { mode: "text" });
  const firstOut = await first.stdout.readText();
  await first.wait();
  log(
    "named create + time-to-first-exec",
    firstOut.trim() === "ready",
    `${((Date.now() - ct) / 1000).toFixed(1)}s sandboxId=${sb.sandboxId}`,
  );

  const p = await sb.exec(["sh", "-c", "echo out; echo err >&2; exit 3"], { mode: "text" });
  const [out, errStream, code] = await Promise.all([p.stdout.readText(), p.stderr.readText(), p.wait()]);
  log(
    "exec streams/exit",
    code === 3 && out.trim() === "out" && errStream.trim() === "err",
    `code=${code} out=${JSON.stringify(out)} err=${JSON.stringify(errStream)}`,
  );

  const gt = await sb.exec(["sh", "-c", "timeout 2 sh -c 'sleep 10'; echo rc=$?"], { mode: "text" });
  const gtOut = await gt.stdout.readText();
  await gt.wait();
  log("guest timeout pins exit 124", /rc=124/.test(gtOut), gtOut.trim());

  try {
    const dl = await sb.exec(["sh", "-c", "sleep 15"], { mode: "text", timeoutMs: 2000 });
    const dlCode = await dl.wait();
    info("SDK timeoutMs mid-command", `wait() returned ${dlCode}`);
  } catch (e) {
    info("SDK timeoutMs mid-command", `throws ${errShape(e)}`);
  }

  const id = await sb.exec(["sh", "-c", "whoami; echo HOME=$HOME; pwd; uname -a"], { mode: "text" });
  const idOut = await id.stdout.readText();
  await id.wait();
  log(
    "identity/home (driver assumes root:/root)",
    /HOME=\/root/.test(idOut),
    idOut.replace(/\n/g, " | ").slice(0, 160),
  );

  await sb.filesystem.writeText("hello file\n", "/root/keep.txt");
  const txt = await sb.filesystem.readText("/root/keep.txt");
  log("file roundtrip", txt === "hello file\n");
  const big = Buffer.alloc(300 * 1024);
  for (let i = 0; i < big.length; i++) big[i] = (i * 7) % 256;
  await sb.filesystem.writeBytes(big, "/root/big.bin");
  const back = Buffer.from(await sb.filesystem.readBytes("/root/big.bin"));
  log("binary roundtrip 300KB", back.equals(big), `${back.length} bytes`);

  try {
    await sb.filesystem.readBytes("/root/never-existed.txt");
    log("missing-file error shape", false, "read unexpectedly succeeded");
  } catch (e) {
    log("missing-file error shape (client maps to null)", true, errShape(e));
  }

  const det = await sb.exec(
    ["sh", "-c", "nohup sh -c 'sleep 2; echo detached-done > /root/bg.txt' >/dev/null 2>&1 & echo launched"],
    { mode: "text" },
  );
  const detOut = await det.stdout.readText();
  await det.wait();
  let bgOk = false;
  for (let i = 0; i < 10 && !bgOk; i++) {
    await sleep(500);
    bgOk = (await sb.filesystem.readText("/root/bg.txt").catch(() => null)) === "detached-done\n";
  }
  log("detached process survives across execs (QM's session model)", detOut.trim() === "launched" && bgOk);

  try {
    racer = await modal.sandboxes.create(app, image, { name: NAME, timeoutMs: 5 * 60_000 });
    log("create race raises AlreadyExistsError", false, `unexpectedly created ${racer.sandboxId}`);
  } catch (e) {
    log(
      "create race raises AlreadyExistsError",
      e instanceof AlreadyExistsError || /already/i.test(String(e?.message)),
      errShape(e),
    );
  }
  const adopted = await modal.sandboxes.fromName(APP, NAME);
  log("race recovery adopts via fromName", adopted.sandboxId === sb.sandboxId, `adopted=${adopted.sandboxId}`);

  try {
    await modal.sandboxes
      .create(app, image, { name: `qm-smoke-clamp-${Date.now().toString(36)}`, timeoutMs: 48 * 3600_000 })
      .then(async (x) => {
        info("timeoutMs > 24h", "accepted (silently clamped? check dashboard)");
        await x.terminate();
      });
  } catch (e) {
    info("timeoutMs > 24h", `rejected: ${errShape(e)}`);
  }

  try {
    idler = await modal.sandboxes.create(app, image, { idleTimeoutMs: 15_000, timeoutMs: 10 * 60_000 });
    const ij = await idler.exec(
      ["sh", "-c", "nohup sh -c 'sleep 120; echo done > /root/job.txt' >/dev/null 2>&1 & echo go"],
      { mode: "text" },
    );
    await ij.stdout.readText();
    await ij.wait();
    await sleep(45_000);
    const pollAfter = await idler.poll();
    log(
      "idle-kill SIGKILLs a box mid-detached-job (why the driver never sets idleTimeoutMs)",
      pollAfter !== null,
      `poll()=${pollAfter}`,
    );
  } catch (e) {
    info("idle-kill probe", errShape(e));
  }

  const st = Date.now();
  try {
    await sb.snapshotFilesystem();
    info("snapshotFilesystem (future fast-resume cache, not v1)", `${((Date.now() - st) / 1000).toFixed(1)}s`);
  } catch (e) {
    info("snapshotFilesystem (future fast-resume cache, not v1)", errShape(e));
  }

  await sb.terminate();
  try {
    const dead = await sb.exec(["sh", "-c", "echo zombie"], { mode: "text" });
    await dead.wait();
    log("exec after terminate rejects", false, "unexpectedly ran");
  } catch (e) {
    log("exec after terminate rejects (client maps to gone)", true, errShape(e));
  }
  try {
    const ghost = await modal.sandboxes.fromName(APP, NAME);
    const ghostExit = await ghost.poll();
    try {
      const gp = await ghost.exec(["sh", "-c", "echo hi"], { mode: "text" });
      await gp.wait();
      log(
        "fromName after terminate hands back a dead box that fails on first use",
        false,
        `poll()=${ghostExit}, exec unexpectedly ran`,
      );
    } catch (e) {
      log(
        "fromName after terminate hands back a dead box that fails on first use (client revives via the gone matcher)",
        true,
        `poll()=${ghostExit} exec: ${errShape(e)}`,
      );
    }
  } catch (e) {
    log("fromName after terminate rejects (client maps to null)", true, errShape(e));
  }
  try {
    const bogus = await modal.sandboxes.fromId("sb-does-not-exist-000000");
    const exit = await bogus.poll();
    log("fromId on a bogus id fails on lookup/poll", false, `poll unexpectedly returned ${exit}`);
  } catch (e) {
    const mapped =
      e?.code === 3 || e?.name === "InvalidError" || /INVALID_ARGUMENT|not found/i.test(String(e?.message));
    log(
      "fromId on a bogus id fails in a shape the client maps to gone (code=3 / InvalidError / INVALID_ARGUMENT)",
      mapped,
      `code=${e?.code} ${errShape(e)}`,
    );
  }
  try {
    await sb.terminate();
    log("terminate is idempotent", true);
  } catch (e) {
    const swallowed =
      ["ClientClosedError", "NotFoundError"].includes(String(e?.name)) ||
      /terminated|detached/i.test(String(e?.message));
    log("terminate is idempotent (dead-handle error is a shape the client swallows)", swallowed, errShape(e));
  }

  console.log(`\ndone in ${el()}`);
} catch (e) {
  console.error("SMOKE ERROR:", errShape(e));
  process.exitCode = 1;
} finally {
  for (const x of [sb, racer, idler]) {
    if (x) await x.terminate().catch(() => {});
  }
  modal.close();
}
