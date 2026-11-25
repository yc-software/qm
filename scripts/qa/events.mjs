import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { connectInstance } from "./instance.mjs";

const APPROVAL_PATTERN = "qa-approval-probe";
const tag = () => randomUUID().slice(0, 8);
const enc = encodeURIComponent;

export async function waitFor(what, fn, timeoutMs = 120_000) {
  const end = Date.now() + timeoutMs;
  for (;;) {
    const value = await fn();
    if (value) return value;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 500));
  }
}

const link = (qa, sessionId) => `${qa.portal}/s/${enc(sessionId)}`;

export async function newWebSession(qa) {
  const { session } = await qa.api("POST", "/v1/sessions", {
    principalId: qa.principal,
    scopeId: `personal:${qa.principal}`,
  });
  return { sessionId: session.id, threadRef: session.threadRef, url: link(qa, session.id) };
}

async function sessionFor(qa, threadRef) {
  return waitFor(`a session for ${threadRef}`, async () => {
    const { sessions } = await qa.api("GET", `/v1/sessions?principalId=${enc(qa.principal)}`);
    return sessions.find((s) => s.threadRef === threadRef)?.id;
  });
}

async function itemsOf(qa, sessionId) {
  const out = await qa.api("GET", `/v1/sessions/${enc(sessionId)}?viewer=${enc(qa.principal)}&tailTurns=4`);
  return out.items ?? [];
}

export async function waitForText(qa, sessionId, text, timeoutMs) {
  await waitFor(
    `"${text}" in session ${sessionId}`,
    async () => {
      const items = await itemsOf(qa, sessionId);
      return items.some((item) => item.kind === "AgentMessage" && item.text?.includes(text));
    },
    timeoutMs,
  );
}

async function sendTurn(qa, surface, threadRef, text, extra = {}) {
  const run = await qa.api("POST", "/v1/turns?async=1", {
    surface,
    actor: { externalId: qa.principal },
    conversation: { kind: "dm", threadRef },
    text,
    origin: { kind: "human" },
    addressed: true,
    idempotencyKey: `qa-${surface}-${tag()}`,
    ...extra,
  });
  return { runId: run.runId, sessionId: await sessionFor(qa, threadRef) };
}

export async function fireCron(qa, target) {
  const session = target ?? (await newWebSession(qa));
  const text = `QA cron fired ${tag()}`;
  const { cron } = await qa.api("POST", "/v1/crons", {
    schedule: { cron: "0 9 1 1 *", timezone: "America/Los_Angeles" },
    message: text,
    title: `QA cron ${tag()}`,
    owner: qa.principal,
    createdBy: qa.principal,
    ownerScopeId: `personal:${qa.principal}`,
    destination: { type: "web", target: session.threadRef, audienceScopeId: `personal:${qa.principal}` },
  });
  await qa.api("POST", `/v1/crons/${enc(cron.id)}/run?principalId=${enc(qa.principal)}`, {});
  await qa.api("POST", `/v1/crons/${enc(cron.id)}/disable?principalId=${enc(qa.principal)}`, {});
  return { event: "cron", cronId: cron.id, text, ...session };
}

async function requireApprovalFor(qa, pattern) {
  const scope = enc(`personal:${qa.principal}`);
  const { commandPolicy } = await qa.api("GET", `/v1/admin/scopes/${scope}`);
  const policy = commandPolicy ?? { mode: "denylist", rules: [] };
  if (policy.rules.some((rule) => rule.pattern === pattern)) return;
  const rule = { pattern, decision: "require_approval", reason: "QA approval probe" };
  await qa.api("PUT", `/v1/admin/scopes/${scope}/command-policy`, { ...policy, rules: [...policy.rules, rule] });
}

export async function requestApproval(qa) {
  await requireApprovalFor(qa, APPROVAL_PATTERN);
  const command = `echo ${APPROVAL_PATTERN}-${tag()}`;
  const threadRef = `web:${qa.principal}:qa-approval-${tag()}`;
  const text = `Use your execute tool to run exactly this shell command and nothing else: ${command}`;
  const { runId, sessionId } = await sendTurn(qa, "web", threadRef, text, { deliveryTarget: threadRef });
  const requestId = await waitFor("a pending approval", async () => {
    const { pending } = await qa.api("GET", `/v1/approvals/pending?threadRef=${enc(threadRef)}`);
    return pending?.pendingApprovals?.[0]?.requestId;
  });
  return { event: "approval", requestId, command, runId, sessionId, threadRef, url: link(qa, sessionId) };
}

export async function resolveApproval(qa, requestId, approved) {
  const out = await qa.api("POST", `/v1/web/approvals/${enc(requestId)}`, { approved });
  return { event: approved ? "approve" : "deny", requestId, runId: out.runId };
}

export async function backgroundRun(qa) {
  const text = `QA background done ${tag()}`;
  const threadRef = `web:${qa.principal}:qa-background-${tag()}`;
  const turn = await sendTurn(qa, "web", threadRef, `Reply with exactly: ${text}`, { deliveryTarget: threadRef });
  return { event: "background", text, threadRef, ...turn, url: link(qa, turn.sessionId) };
}

export async function slackMessage(qa) {
  const text = `QA slack reply ${tag()}`;
  const channel = `DQA${tag().toUpperCase()}`;
  const threadRef = `dm:${channel}:${(Date.now() / 1000).toFixed(6)}`;
  const turn = await sendTurn(qa, "slack", threadRef, `Reply with exactly: ${text}`, { deliveryTarget: channel });
  return { event: "slack", text, threadRef, ...turn, url: link(qa, turn.sessionId) };
}

const USAGE = "usage: npm run qa:event -- cron|approval|background|slack|approve <requestId>|deny <requestId>";

async function main(argv) {
  const [kind, id] = argv;
  const qa = connectInstance();
  const run = {
    cron: () => fireCron(qa),
    approval: () => requestApproval(qa),
    background: () => backgroundRun(qa),
    slack: () => slackMessage(qa),
    approve: () => resolveApproval(qa, id, true),
    deny: () => resolveApproval(qa, id, false),
  }[kind ?? ""];
  if (!run || (["approve", "deny"].includes(kind) && !id)) {
    console.error(USAGE);
    process.exit(2);
  }
  console.log(JSON.stringify(await run(), null, 2));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) await main(process.argv.slice(2));
