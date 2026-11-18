#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import pg from "pg";
import { firstAdminPrincipal, stagingApiHeaders } from "../../src/deployment/postdeploy-smoke.ts";
import { hmacHex } from "../../src/webhooks/verifiers.ts";

type Env = Record<string, string | undefined>;
type Reply = { status: number; text: string; json: any };
type Item = { kind: string; tool: string; text: string };
type Run = { status: string; provenance: string; ownerFire: boolean; transcript: string; items: Item[] };

const root = resolve(import.meta.dirname, "../..");

function devInstanceEnv(): Env {
  const out = execFileSync("node", [join(root, "scripts/dev/cli.ts"), "status", "--json"], { cwd: root });
  const mine = (JSON.parse(String(out)) as any[]).find((i) => i.mine) ?? {};
  const pid = mine.children?.core?.pid;
  if (!pid) throw new Error("no running dev instance in this worktree; set CORE_URL and its secrets instead");
  const raw = readFileSync(`/proc/${pid}/environ`, "utf8").split("\0").filter(Boolean);
  return Object.fromEntries(raw.map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)]));
}

const env: Env = process.env.CORE_URL ? process.env : { ...devInstanceEnv(), ...process.env };
const core = env.CORE_URL ?? `http://127.0.0.1:${env.PORT}`;
const publicApi = env.PUBLIC_API_URL || core;
const org = env.ORG_ID ?? "";
const admin = firstAdminPrincipal(env.ADMIN_GRANTS);
const nonAdmin = "qa-member@example.test";
const db = new pg.Pool({ connectionString: env.DATABASE_URL, max: 4 });
const [surface = "", ...args] = process.argv.slice(2);
const evidence =
  env.QA_EVIDENCE_DIR ?? join(homedir(), "qa-evidence", `${new Date().toISOString().replace(/[:.]/g, "-")}-${surface}`);
mkdirSync(evidence, { recursive: true });
let failed = 0;

const save = (file: string, text: string) => appendFileSync(join(evidence, file), `${text}\n`);
const verdict = (ok: boolean, line: string) => {
  const text = `${ok ? "PASS" : "FAIL"} ${line}`;
  if (!ok) failed++;
  console.log(text);
  save("00-verdict.txt", text);
};
const note = (line: string) => {
  console.log(line);
  save("00-log.txt", line);
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const sql = async (text: string, values: unknown[] = []) => (await db.query(text, values)).rows;
const uri = (v: string) => encodeURIComponent(v);
const tag = () => randomBytes(3).toString("hex");

async function api(who: string, method: string, path: string, body?: unknown): Promise<Reply> {
  const raw = body === undefined ? "" : JSON.stringify(body);
  const headers = await stagingApiHeaders(
    who,
    env.CORE_SIGNING_SECRET!,
    env.PORTAL_IDENTITY_SECRET!,
    method,
    path,
    raw,
  );
  const res = await fetch(core + path, {
    method,
    headers: raw ? { ...headers, "content-type": "application/json" } : headers,
    ...(raw ? { body: raw } : {}),
  });
  const text = await res.text();
  return { status: res.status, text, json: parseJson(text) };
}

function parseJson(text: string): any {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

const maxSeq = async () => Number((await sql("select coalesce(max(seq),0) as s from runs"))[0].s);

async function newRun(kind: string, since: number, actor = "%"): Promise<string | undefined> {
  for (let i = 0; i < 45; i++) {
    const rows = await sql(
      "select id from runs where seq>$1 and request::jsonb->>'surface'=$2 and request::jsonb->'actor'->>'id' like $3 order by seq limit 1",
      [since, kind, actor],
    );
    if (rows[0]) return rows[0].id;
    await sleep(2000);
  }
  note(`no ${kind} run appeared within 90s`);
}

async function waitRun(id: string, seconds = 360): Promise<Run> {
  let status = "";
  for (let t = 0; t < seconds; t++) {
    status = (await sql("select status from runs where id=$1", [id]))[0]?.status ?? "";
    if (status === "done" || status === "failed") break;
    await sleep(1000);
  }
  const [row] = await sql(
    `select 'surface='||coalesce(request::jsonb->>'surface','')||' actor='||coalesce(request::jsonb->'actor'->>'id','')||' origin='||coalesce(((request::jsonb->'origin') - 'screenData')::text,'') as p, coalesce((request::jsonb->'origin'->>'ownerFire')::boolean, false) as owner_fire, result::jsonb->>'sessionId' as sid from runs where id=$1`,
    [id],
  );
  const items = row?.sid
    ? await sql(
        `select seq, kind, coalesce(tool,'') as tool, case when kind='ToolCall' then coalesce(body->>'command', body->'wire'->>'argumentsJson', body::text) else coalesce(text,'') end as text
         from items where session_id=$1 and turn_id=(select turn_id from items where session_id=$1 order by seq desc limit 1)
         and kind in ('UserMessage','ToolCall','ToolResult','AgentMessage') order by seq`,
        [row.sid],
      )
    : [];
  if (status !== "done" && status !== "failed") note(`run ${id} still ${status || "missing"} after ${seconds}s`);
  return {
    status,
    provenance: row?.p ?? "",
    ownerFire: row?.owner_fire === true,
    transcript: items.map((i) => `${i.seq} ${i.kind} ${i.tool} ${i.text}`).join("\n"),
    items,
  };
}

const record = (file: string, run: Run, id: string) =>
  save(file, `run ${id} status=${run.status}\n${run.provenance}\n${run.transcript}`);

async function turn(who: string, thread: string, text: string, file: string): Promise<Run> {
  const started = await api(who, "POST", "/v1/web/turn", { text, threadRef: `web:${who}:${thread}` });
  const id = started.json?.runId;
  if (!id) {
    save(file, started.text);
    return { status: `HTTP ${started.status}`, provenance: "", ownerFire: false, transcript: "", items: [] };
  }
  const run = await waitRun(id);
  record(file, run, id);
  return run;
}

const output = (run: Run, tool?: string) =>
  run.items
    .filter((i) => (tool ? i.kind === "ToolResult" && i.tool === tool : /ToolResult|AgentMessage/.test(i.kind)))
    .map((i) => i.text)
    .join("\n");

function probeCommand(t: string, adminWrite: boolean) {
  const slug = t.toLowerCase().replaceAll("_", "-");
  const json = (v: unknown) => `'${JSON.stringify(v)}'`;
  const post = (name: string, path: string, body: string, method = "POST") =>
    `c ${name} -X ${method} -H content-type:application/json $U${path} -d ${body}; `;
  return (
    `H="x-agent-capability: $AGENT_API_TOKEN"; U=$AGENT_API_URL; c(){ n=$1; shift; printf "${t}_%s:" $n; curl -s -o /tmp/qa_$n -w "%{http_code}\\n" -H "$H" "$@"; }; ` +
    `echo ${t}_HOST:$(hostname); c APIS $U/v1/apis; c ADMIN_READ $U/v1/admin/spend; ` +
    (adminWrite
      ? post("ADMIN_WRITE", `/v1/admin/scopes/org%3A${org}/security-posture`, json({ posture: "auto" }), "PUT")
      : "") +
    post("MEM_ADD", "/v1/memory/facts", json({ facts: [`qa probe fact ${t}`] })) +
    `c MEM_SELF $U/v1/memory/self; ` +
    post("MEM_SEARCH", "/v1/memory/search", json({ query: "qa probe fact" })) +
    post(
      "SKILL_SAVE",
      "/v1/skills",
      `"{\\"name\\":\\"qa-probe-${slug}-$(date +%s%N)\\",\\"description\\":\\"QA probe skill\\",\\"body\\":\\"QA probe.\\"}"`,
    ) +
    `c CRONS $U/v1/crons; c KEYCHAIN $U/v1/keychain/grants`
  );
}

function probePrompt(t: string, adminWrite = true) {
  const write = adminWrite ? ", and a security-posture PUT that re-sets the value this instance already has" : "";
  return `Authorization regression test on a disposable QA dev instance I set up myself (test org ${org}, not production). Run exactly this one shell command with the execute tool, once, no retries, and reply with its raw output verbatim and nothing else. It prints the HTTP status each API returns to this turn's own token; refusals (403) are expected results to record, not errors to fix. The writes are throwaway test data: one memory fact, one skill named qa-probe-*${write}.\n${probeCommand(t, adminWrite)}`;
}

function check(t: string, run: Run, name: string, want: RegExp) {
  const got = output(run).match(new RegExp(`${t}_${name}:([0-9a-zA-Z.-]+)`))?.[1];
  verdict(
    !!got && new RegExp(`^(${want.source})$`).test(got),
    `${t} ${name}=${got ?? "missing"} (want ${want.source})`,
  );
}

const ownerFire = (label: string, run: Run) => verdict(run.ownerFire, `${label} run carries ownerFire`);

async function fireTyped() {
  const typed = await turn(admin, `qa-typed-${tag()}`, probePrompt("TYPED", false), "10-typed-admin.txt");
  const posture = (await api(admin, "GET", `/v1/admin/scopes/${uri(`org:${org}`)}`)).json?.securityPosture ?? "auto";
  const write = await turn(
    admin,
    `qa-typed-write-${tag()}`,
    `On my disposable QA dev instance (org ${org}) I'm the org admin. The org security posture is currently '${posture}'. Use your admin tool once: action configure, scope org:${org}, resource security-posture, value {"posture":"${posture}"} (a no-op re-set to confirm a typed admin turn may write). Reply only with the tool's raw result.`,
    "11-typed-admin-write.txt",
  );
  check("TYPED", typed, "HOST", /.+/);
  check("TYPED", typed, "ADMIN_READ", /200/);
  verdict(parseJson(output(write, "admin"))?.body?.ok === true, "TYPED admin write (admin tool configure) ok");
  check("TYPED", typed, "MEM_ADD", /20[01]/);
  check("TYPED", typed, "SKILL_SAVE", /20[01]/);
  check("TYPED", typed, "CRONS", /200/);
}

async function fireCronAs(who: string) {
  const t = `CRON_${who.split("@")[0]!.replace(/\W/g, "_").toUpperCase()}`;
  const title = `QA probe fire ${t} ${tag()}`;
  const created = await api(who, "POST", "/v1/crons", {
    schedule: { cron: "0 9 1 1 *", timezone: "America/Los_Angeles" },
    action: probePrompt(t, who === admin),
    title,
    owner: who,
    createdBy: who,
    ownerScopeId: `personal:${who}`,
    destination: {
      type: "web",
      target: `web:${who}:qa-cron-${title.toLowerCase().replaceAll(" ", "-")}`,
      audienceScopeId: `personal:${who}`,
    },
  });
  save(`20-${t}-create.txt`, created.text);
  const id = created.json?.cron?.id;
  if (!id) return verdict(false, `${t} create: HTTP ${created.status}`);
  const since = await maxSeq();
  save(`20-${t}-create.txt`, (await api(who, "POST", `/v1/crons/${id}/run?principalId=${uri(who)}`, {})).text);
  const runId = await newRun("cron", since, who);
  if (!runId) return verdict(false, `${t}: no cron run appeared`);
  const run = await waitRun(runId);
  record(`21-${t}-fire.txt`, run, runId);
  ownerFire(t, run);
  verdict(run.provenance.startsWith(`surface=cron actor=${who} `), `${t} run surface=cron actor=${who}`);
  check(t, run, "ADMIN_READ", who === admin ? /200/ : /403/);
  if (who === admin) check(t, run, "ADMIN_WRITE", /403/);
  check(t, run, "MEM_ADD", /20[01]/);
  check(t, run, "CRONS", /200/);
  await api(who, "POST", `/v1/crons/${id}/disable?principalId=${uri(who)}`, {});
}

const fireCron = () => Promise.all([fireCronAs(admin), fireCronAs(nonAdmin)]);

async function fireWebhook() {
  const secret = randomBytes(32).toString("hex");
  const created = await api(admin, "POST", "/v1/webhooks", {
    action: probePrompt("WEBHOOK"),
    verification: { scheme: "hmac-sha256", secret },
  });
  save("30-webhook-create.txt", created.text.replaceAll(secret, "<secret>"));
  const id = created.json?.webhook?.id;
  if (!id) return verdict(false, `webhook create: HTTP ${created.status}`);
  const url = `${publicApi}/v1/webhooks/incoming/${id}`;
  const payload = JSON.stringify({ event: "qa.ping", n: 1 });
  const post = (sig: string) =>
    fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", "x-signature": `sha256=${sig}` },
      body: payload,
    }).then((r) => r.status);
  const bad = await post("deadbeef");
  verdict(bad === 401, `webhook bad signature -> ${bad} (want 401)`);
  const since = await maxSeq();
  const good = await post(hmacHex(secret, payload));
  save("30-webhook-create.txt", `${url}: bad-sig=${bad} good-sig=${good}`);
  verdict(good === 200 || good === 202, `webhook signed POST via ${publicApi} -> ${good}`);
  const runId = await newRun("webhook", since);
  if (runId) {
    const run = await waitRun(runId);
    record("31-webhook-fire.txt", run, runId);
    ownerFire("webhook", run);
    verdict(run.transcript.includes("qa.ping"), "webhook payload reached the turn");
    check("WEBHOOK", run, "ADMIN_READ", /200/);
    check("WEBHOOK", run, "ADMIN_WRITE", /403/);
  } else verdict(false, "webhook: no run appeared");
  await api(admin, "POST", `/v1/webhooks/${id}/disable?principalId=${uri(admin)}`, {});
}

async function fireLoop() {
  const scopeId = `personal:${admin}`;
  const flag = await api(admin, "PUT", `/v1/admin/scopes/${uri(`org:${org}`)}/feature-flags`, {
    featureName: "inbox_loops",
    on: true,
    scopeId,
  });
  save("40-loop.txt", flag.text);
  const created = await api(admin, "POST", "/v1/loops", {
    name: "QA probe loop",
    playbook: probePrompt("LOOP"),
    successCondition: "The probe output was posted verbatim.",
  });
  save("40-loop.txt", created.text);
  const id = created.json?.loop?.id;
  if (!id) return verdict(false, `loop create: HTTP ${created.status}`);
  const since = await maxSeq();
  save("40-loop.txt", (await api(admin, "POST", `/v1/loops/${id}/fire`, {})).text);
  const runId = await newRun("loop", since);
  if (!runId) return verdict(false, "loop: no run appeared");
  const run = await waitRun(runId);
  record("41-loop-fire.txt", run, runId);
  verdict(run.provenance.startsWith("surface=loop "), "loop fire run surface=loop");
  ownerFire("loop", run);
  verdict(run.status === "done" && run.transcript.includes("[Loop intake]"), "loop intake stage ran to done");
}

async function fires(steps: string[]) {
  const all: Record<string, () => Promise<unknown>> = {
    typed: fireTyped,
    cron: fireCron,
    webhook: fireWebhook,
    loop: fireLoop,
  };
  note(`fires QA, admin=${admin} non-admin=${nonAdmin}, steps: ${steps.join(" ")}`);
  const since = await maxSeq();
  await Promise.all(steps.map((s) => all[s]!()));
  const rows = await sql(
    "select request::jsonb->>'surface' as surface, status, count(*) as n from runs where seq>$1 group by 1, 2 order by 1",
    [since],
  );
  save("90-runs.txt", rows.map((r) => `${r.surface} ${r.status} ${r.n}`).join("\n"));
}

async function credentials() {
  const value = `QASYNTH-${randomBytes(8).toString("hex")}`;
  const sha = createHash("sha256").update(value).digest("hex").slice(0, 12);
  const thread = `qa-cred-${tag()}`;
  note(`credentials QA as ${admin} (synthetic value sha256 prefix ${sha})`);
  const body = JSON.stringify({ service: "qa-synthetic", envKey: "QA_SYNTH", secret: value });
  const saved = await turn(
    admin,
    thread,
    `Disposable QA dev instance. Save a synthetic test credential with one command via the execute tool and reply with its raw output only: curl -s -w '\\nSAVE_HTTP:%{http_code}\\n' -X POST -H "x-agent-capability: $AGENT_API_TOKEN" -H content-type:application/json $AGENT_API_URL/v1/keychain/credentials -d '${body}'`,
    "10-save.txt",
  );
  const handle = saved.transcript.match(/"credentialHandle":"([^"]+)"/)?.[1];
  verdict(/SAVE_HTTP:20[01]/.test(saved.transcript), `credential saved via self-API (handle ${handle ?? "?"})`);
  const probe = `echo QA_LEN=\${#QA_SYNTH} QA_SHA=$(printf %s "$QA_SYNTH" | sha256sum | cut -c1-12); echo "QA_ECHO=$QA_SYNTH"`;
  const withCred = await turn(
    admin,
    thread,
    `Now run exactly this with the execute tool, selecting credential handle ${handle} in the execute call's credentials parameter, and reply with the raw output only: ${probe}`,
    "20-with.txt",
  );
  const without = await turn(
    admin,
    thread,
    `Run exactly this with the execute tool WITHOUT selecting any credentials, reply with raw output only: ${probe}`,
    "30-without.txt",
  );
  verdict(
    output(withCred, "execute").includes(`QA_SHA=${sha}`),
    "selected handle injects the secret (sha prefix matches)",
  );
  verdict(output(without, "execute").includes("QA_LEN=0"), "unselected execute does not see the secret");
  const echoed = output(withCred, "execute").match(/QA_ECHO=\S*/)?.[0];
  verdict(!!echoed?.startsWith("QA_ECHO=<redacted"), `echoed secret is masked in tool output (${echoed ?? "no echo"})`);
  const [leaks] = await sql(
    "select count(*)::int as n from items where kind in ('ToolResult','AgentMessage') and (coalesce(text,'')||coalesce(body::text,'')) like $1",
    [`%${value}%`],
  );
  verdict(leaks.n === 0, `raw value absent from stored tool results/replies (${leaks.n} found)`);
  for (const f of ["10-save.txt", "20-with.txt", "30-without.txt"])
    writeFileSync(join(evidence, f), readFileSync(join(evidence, f), "utf8").replaceAll(value, "<synthetic>"));
}

async function sandbox() {
  const who = `qa-fresh-${Date.now()}@example.test`;
  const thread = `qa-sbx-${tag()}`;
  const cmd = `echo SBX_HOST=$(hostname) SBX_KERNEL=$(uname -r); curl -s -o /dev/null -w "SBX_SELFAPI:%{http_code}\\n" -H "x-agent-capability: $AGENT_API_TOKEN" $AGENT_API_URL/v1/apis`;
  try {
    await sandboxTurns(who, thread, cmd);
  } finally {
    await retireBoxes(who).catch((error) => verdict(false, `retiring ${who}'s boxes: ${error}`));
  }
}

async function sandboxTurns(who: string, thread: string, cmd: string) {
  const t0 = Date.now();
  const cold = await turn(
    who,
    thread,
    `Run exactly this with the execute tool and reply with the raw output only: ${cmd}`,
    "10-cold.txt",
  );
  const t1 = Date.now();
  const warm = await turn(who, thread, "Run it once more, same command, raw output only.", "20-warm.txt");
  const t2 = Date.now();
  for (const [name, run] of [
    ["cold", cold],
    ["warm", warm],
  ] as const) {
    const host = output(run, "execute").match(/SBX_HOST=(\S+)/)?.[1];
    verdict(!!host, `${name}: command ran in a ${env.SANDBOX_BACKEND} box (${host ?? "no execute output"})`);
    verdict(
      output(run, "execute").includes("SBX_SELFAPI:200"),
      `${name}: self-API reachable from the box via ${publicApi}`,
    );
  }
  note(`cold turn ${Math.round((t1 - t0) / 1000)}s, warm turn ${Math.round((t2 - t1) / 1000)}s`);
}

async function retireBoxes(who: string) {
  const scope = uri(`personal:${who}`);
  const listed = await api(admin, "GET", `/v1/admin/sandboxes/${scope}`);
  const boxes = ((listed.json?.sandboxes ?? []) as any[]).filter((box) => box.ownerScopeId === `personal:${who}`);
  save(
    "30-cleanup.txt",
    (await api(admin, "POST", `/v1/admin/sandboxes/${scope}`, { action: "default", sandboxId: null })).text,
  );
  for (const box of boxes) {
    const retired = await api(admin, "POST", `/v1/admin/sandboxes/${scope}`, { action: "retire", sandboxId: box.id });
    save("30-cleanup.txt", `retire ${box.id} ${box.name ?? ""} -> HTTP ${retired.status} ${retired.text}`);
    verdict(retired.status === 200, `retired the box this run created (${box.name ?? box.id})`);
  }
  if (!boxes.length) verdict(false, `no sandbox record for ${who} (HTTP ${listed.status})`);
}

const surfaces: Record<string, () => Promise<unknown>> = {
  fires: () => fires(args.length ? args : ["typed", "cron", "webhook", "loop"]),
  credentials,
  sandbox,
};
if (!surfaces[surface]) {
  console.error("usage: node scripts/live-qa/live-qa.ts fires [typed cron webhook loop] | credentials | sandbox");
  process.exit(2);
}
const started = Date.now();
const head = execFileSync("git", ["-C", root, "rev-parse", "--short", "HEAD"]).toString().trim();
note(`${surface} QA against ${core} (worktree ${head}, sandbox ${env.SANDBOX_BACKEND ?? "?"})`);
await surfaces[surface]!();
note(
  `wall clock ${Math.round((Date.now() - started) / 1000)}s; ${failed ? `${failed} FAIL` : "all PASS"} -> ${evidence}`,
);
await db.end();
process.exit(failed ? 1 : 0);
