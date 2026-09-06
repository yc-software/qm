import { Sandbox } from "e2b";

const PROXY = process.env.HTTPS_PROXY;

const log = (step, ok, detail = "") => console.log(`${ok ? "PASS" : "FAIL"}  ${step}${detail ? " — " + detail : ""}`);

const t0 = Date.now();
const el = () => `${((Date.now() - t0) / 1000).toFixed(1)}s`;

let sbx;
try {
  sbx = await Sandbox.create("base", {
    timeoutMs: 5 * 60_000,
    metadata: { name: "qm-smoke-tester", scratch: "false" },
    proxy: PROXY,
  });
  log("create", true, `sandboxId=${sbx.sandboxId} (${el()})`);

  const r = await sbx.commands.run("echo out; echo err >&2; exit 3", { timeoutMs: 30_000 }).catch((e) => e.result ?? e);
  const streamsOk = r && r.exitCode === 3 && r.stdout.trim() === "out" && r.stderr.trim() === "err";
  log(
    "exec streams/exit",
    !!streamsOk,
    `code=${r?.exitCode} out=${JSON.stringify(r?.stdout)} err=${JSON.stringify(r?.stderr)}`,
  );

  const env = await sbx.commands.run("whoami; echo HOME=$HOME; pwd; uname -a");
  log("identity/home", env.exitCode === 0, env.stdout.replace(/\n/g, " | ").slice(0, 160));

  await sbx.files.write("/home/user/workspace/keep.txt", "survives pause\n");
  const txt = await sbx.files.read("/home/user/workspace/keep.txt");
  log("file roundtrip", txt === "survives pause\n");
  const big = Buffer.alloc(300 * 1024);
  for (let i = 0; i < big.length; i++) big[i] = (i * 7) % 256;
  await sbx.files.write("/home/user/workspace/big.bin", big);
  const back = Buffer.from(await sbx.files.read("/home/user/workspace/big.bin", { format: "bytes" }));
  log("binary roundtrip 300KB", back.equals(big), `${back.length} bytes`);

  try {
    const bg = await sbx.commands.run("sleep 30 & cat > /home/user/workspace/from-stdin.txt", {
      background: true,
      stdin: true,
      timeoutMs: 60_000,
    });
    await sbx.commands.sendStdin(bg.pid, "hello stdin\n");
    await new Promise((res) => setTimeout(res, 1500));
    await sbx.commands.kill(bg.pid).catch(() => {});
    const stdinBack = await sbx.files.read("/home/user/workspace/from-stdin.txt").catch(() => null);
    log("background + native stdin", stdinBack === "hello stdin\n", JSON.stringify(stdinBack));
  } catch (e) {
    log(
      "background + native stdin",
      false,
      `${e.name}: ${String(e.message).slice(0, 100)} (informational — QM sessions are exec-based)`,
    );
  }

  const det = await sbx.commands.run(
    "nohup sh -c 'sleep 1; echo detached-done > /home/user/workspace/bg.txt' >/dev/null 2>&1 & echo launched",
  );
  let bgOk = false;
  for (let i = 0; i < 10 && !bgOk; i++) {
    await new Promise((res) => setTimeout(res, 500));
    bgOk = (await sbx.files.read("/home/user/workspace/bg.txt").catch(() => null)) === "detached-done\n";
  }
  log("detached background exec + poll (QM's session model)", det.stdout.trim() === "launched" && bgOk);

  const listed = await Sandbox.list({ query: { metadata: { name: "qm-smoke-tester" } }, proxy: PROXY });
  const items = listed.items ?? listed;
  const found = (Array.isArray(items) ? items : []).some((s) => s.sandboxId === sbx.sandboxId);
  log("list by metadata", found, `${Array.isArray(items) ? items.length : "?"} match(es)`);

  const pt = Date.now();
  await sbx.pause();
  log("pause", true, `${((Date.now() - pt) / 1000).toFixed(1)}s`);

  const rt = Date.now();
  const resumed = await Sandbox.connect(sbx.sandboxId, { timeoutMs: 5 * 60_000, proxy: PROXY });
  const after = await resumed.files.read("/home/user/workspace/keep.txt");
  const post = await resumed.commands.run("echo revived");
  log(
    "resume + disk intact",
    after === "survives pause\n" && post.stdout.trim() === "revived",
    `resume ${((Date.now() - rt) / 1000).toFixed(1)}s`,
  );

  try {
    await Sandbox.connect("i-does-not-exist-000000", { timeoutMs: 30_000, proxy: PROXY });
    log("missing-sandbox resume rejects", false, "unexpectedly succeeded");
  } catch (e) {
    log("missing-sandbox resume rejects", true, `${e.name ?? "Error"}: ${String(e.message).slice(0, 80)}`);
  }

  await resumed.kill();
  const listedAfter = await Sandbox.list({ query: { metadata: { name: "qm-smoke-tester" } }, proxy: PROXY });
  const itemsAfter = listedAfter.items ?? listedAfter;
  const stillRunning = (Array.isArray(itemsAfter) ? itemsAfter : []).some(
    (s) => s.sandboxId === sbx.sandboxId && String(s.state).toLowerCase() === "running",
  );
  log("kill", !stillRunning);

  console.log(`\ndone in ${el()}`);
} catch (e) {
  console.error("SMOKE ERROR:", e?.name, e?.message?.slice(0, 400));
  try {
    if (sbx) await sbx.kill();
  } catch {
    void 0;
  }
  process.exit(1);
}
