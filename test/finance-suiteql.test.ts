import { test } from "node:test";
import assert from "node:assert/strict";
import { executeSuiteQL } from "../src/api/routes/finance.ts";
import { TOOL_BROKER_AUD } from "../src/auth/capability-token.ts";
import type { ApiCtx } from "../src/api/routes/route.ts";
import type { DecryptedServiceCredential, ServiceCredentialReader } from "../src/credentials/keychain.ts";
import type { BrokerFetch } from "../src/api/credential-broker.ts";
import { createMemoryDurableByteStore } from "../src/files/durable-byte-store.ts";
import { createMemoryFileArtifactStore, fileArtifactId } from "../src/files/file-artifact-store.ts";
import { createMemorySessionStore } from "../src/sessions/memory-session-store.ts";
import { createWorkflowControl } from "../src/sessions/workflow-control.ts";
import { scopeId } from "../src/types.ts";
import { createHash } from "node:crypto";
import { createSkillStore } from "../src/skills/skill-store.ts";
import type { Sandbox, SandboxHandle } from "../src/sandbox/sandbox.ts";

function fakeRes() {
  const out = { status: 0, body: undefined as unknown };
  return {
    res: {
      req: { headers: {} },
      getHeader() {},
      writeHead(status: number) {
        out.status = status;
        return this;
      },
      end(data?: string) {
        out.body = data ? JSON.parse(data) : undefined;
      },
    } as unknown as ApiCtx["res"],
    out,
  };
}

const sourceScope = {
  entity: "100",
  subsidiaryScope: "consolidated",
  currencyBasis: "INR booked amounts with original currencies shown separately",
  accountingBook: "primary",
  comparisonBasis: "none",
  reportingTimezone: "Asia/Kolkata (IST)",
  historicalCutoffBasis: "dated movement reconstruction through the as_of cutoff",
};

async function approvedSourcePlanWorld(
  script: string,
  pinnedDigest = createHash("sha256").update(script).digest("hex"),
  dates = { receiptStart: "2026-10-12", receiptEnd: "2026-10-18", asOf: "2026-10-19" },
  sourcePlanValue?: unknown,
) {
  const sessions = createMemorySessionStore();
  const files = createMemoryFileArtifactStore(createMemoryDurableByteStore());
  const skills = createSkillStore();
  const scope = scopeId("personal", "approved-source-plan");
  const session = await sessions.getOrCreateByThread("approved-source-plan", "dm", scope);
  const sourcePlanArtifactId = "11111111111111111111111111111111";
  const sourcePlan = await files.put({
    id: sourcePlanArtifactId,
    ownerScopeId: scope,
    createdBy: "finance-producer",
    name: "sharechat-ar-source-plan.json",
    path: `artifacts/${sourcePlanArtifactId}/sharechat-ar-source-plan.json`,
    mimetype: "application/json",
    data: Buffer.from(
      JSON.stringify(
        sourcePlanValue ?? {
          schemaVersion: 1,
          workflowId: "finance-golden-harness",
          scope: sourceScope,
          parameters: {
            receiptStart: dates.receiptStart,
            receiptEnd: dates.receiptEnd,
            asOf: dates.asOf,
          },
        },
      ),
    ),
    direction: "out",
  });
  const skill = await skills.create({
    scopeId: scope,
    createdBy: "deployment-layer",
    manifest: {
      name: "sharechat-ar-collection",
      description: "Canonical ShareChat accounts receivable extraction",
      requiredCapabilities: [],
      body: "Use the materialized generator.",
      files: [{ path: "scripts/generate_ar_report.py", content: script, executable: true }],
    },
  });
  await skills.review(skill.id, "finance-reviewer", []);
  await skills.publish(skill.id);
  const attempt = await sessions.acquireLease(session.id, "turn");
  assert.ok(attempt.lease);
  const workflow = createWorkflowControl({
    sessions,
    lease: attempt.lease,
    scopeLabel: scope,
    session,
    definitions: [
      {
        id: "finance-golden-harness",
        version: 1,
        sourceExecution: {
          approvalStep: "PLAN_APPROVED",
          compiler: {
            skillName: "sharechat-ar-collection",
            path: "scripts/generate_ar_report.py",
            contentDigest: pinnedDigest,
          },
          expectedPopulations: ["receipts", "nativeopen", "sapopen", "sapopen_custinvc", "glcontrol", "gltypesplit"],
        },
        steps: [
          { id: "SOURCE_PLAN_READY", role: "producer", requiredSkills: [] },
          {
            id: "PLAN_APPROVED",
            role: "producer",
            humanApproval: true,
            after: "SOURCE_PLAN_READY",
            evidenceFrom: "SOURCE_PLAN_READY",
            requiredSkills: [],
          },
          {
            id: "RAW_EVIDENCE_READY",
            role: "producer",
            after: "PLAN_APPROVED",
            evidenceFrom: "PLAN_APPROVED",
            requiredSkills: [{ skillName: "sharechat-ar-collection" }],
          },
        ],
      },
    ],
    runtime: () => ({ harnessId: "pi", modelId: "gpt-5.6-luna" }),
    resolveEvidence: async (ids) =>
      ids.map((id) => {
        assert.equal(id, sourcePlanArtifactId);
        return { id, digest: sourcePlan.artifact.sha256! };
      }),
  });
  assert.equal(
    (
      (await workflow({
        action: "advance",
        workflowId: "finance-golden-harness",
        step: "SOURCE_PLAN_READY",
        decision: "pass",
        outputEvidence: [{ id: sourcePlanArtifactId }],
      })) as { accepted: boolean }
    ).accepted,
    true,
  );
  assert.equal(
    (
      (await workflow({
        action: "approve",
        workflowId: "finance-golden-harness",
        step: "PLAN_APPROVED",
        decision: "pass",
        inputEvidence: [{ id: sourcePlanArtifactId }],
      })) as { accepted: boolean }
    ).accepted,
    true,
  );
  return { sessions, files, skills, scope, session, sourcePlanArtifactId };
}

for (const scenario of [
  { name: "incomplete count", rows: [{ id: "1" }], totalResults: 2 },
  { name: "invalid row shape", rows: [null], totalResults: 1 },
  { name: "unbound query receipt", rows: [{ id: "1" }], totalResults: 1 },
])
  test(`executeSuiteQL refuses persisted ${scenario.name} without fetching again`, async () => {
    const world = await approvedSourcePlanWorld("print('canonical')");
    const rawId = fileArtifactId(`finance-source-execution:${world.sourcePlanArtifactId}`, "out", 0);
    const rows = scenario.rows;
    const evidence = {
      schemaVersion: 1,
      workflowId: "finance-golden-harness",
      parameters: { receiptStart: "2026-10-12", receiptEnd: "2026-10-18", asOf: "2026-10-19" },
      scope: sourceScope,
      sourcePlanArtifactId: world.sourcePlanArtifactId,
      queryBundleArtifactId: "22222222222222222222222222222222",
      queryBundleSha256: "a".repeat(64),
      results: ["receipts", "nativeopen", "sapopen", "sapopen_custinvc", "glcontrol", "gltypesplit"].map((id) => ({
        id,
        rows,
        totalResults: scenario.totalResults,
        hasMore: false,
        querySha256: "b".repeat(64),
        rowsSha256: createHash("sha256").update(JSON.stringify(rows)).digest("hex"),
      })),
    };
    await world.files.put({
      id: rawId,
      ownerScopeId: world.scope,
      createdBy: "finance-producer",
      name: "finance-raw-evidence.json",
      path: `artifacts/${rawId}/finance-raw-evidence.json`,
      mimetype: "application/json",
      data: Buffer.from(JSON.stringify(evidence)),
      direction: "out",
    });
    let touchedSource = false;
    const { res, out } = fakeRes();
    await executeSuiteQL({
      res,
      deps: {
        sessions: world.sessions,
        files: world.files,
        serviceCreds: {
          getServiceCredentialSecret: async () => {
            touchedSource = true;
            throw new Error("unexpected source access");
          },
        },
      } as any,
      body: {},
      capability: {
        actorId: "finance-producer",
        scopeId: world.scope,
        sessionId: world.session.id,
        aud: TOOL_BROKER_AUD,
        exp: Date.now() + 60_000,
      },
    } as ApiCtx);
    assert.equal(out.status, 409);
    assert.equal((out.body as any).error, "invalid_persisted_source_evidence");
    assert.equal(touchedSource, false);
  });

test("executeSuiteQL requires capability claims with tool-broker or credential-broker aud", async () => {
  const { res, out } = fakeRes();
  await executeSuiteQL({
    res,
    deps: {} as any,
    body: { query: "SELECT id FROM transaction" },
    capability: null,
  } as ApiCtx);

  assert.equal(out.status, 401);
  assert.equal((out.body as any).error, "unauthorized");
});

test("executeSuiteQL rejects source access without a governed session before credentials or network", async () => {
  for (const body of [
    {},
    { query: "SELECT id FROM transaction", state: "S4_SOURCE" },
    { simulatedRows: [{ account: "Cash", debit: 100, credit: 0 }] },
    { queryBundleArtifactId: "0123456789abcdef0123456789abcdef" },
  ]) {
    const { res, out } = fakeRes();
    let sourceAccess = false;
    await executeSuiteQL({
      res,
      deps: {
        serviceCreds: {
          getServiceCredentialSecret: async () => {
            sourceAccess = true;
            throw new Error("unexpected credential access");
          },
        },
        brokerFetch: async () => {
          sourceAccess = true;
          throw new Error("unexpected network access");
        },
      } as any,
      body,
      capability: { actorId: "actor", scopeId: "org:default-org", aud: TOOL_BROKER_AUD, exp: Date.now() + 60_000 },
    } as ApiCtx);
    assert.equal(out.status, 403);
    assert.equal((out.body as any).error, "governed_source_workflow_required");
    assert.equal(sourceAccess, false);
  }
});

test("executeSuiteQL refuses freeform SuiteQL inside a governed finance session", async () => {
  const world = await approvedSourcePlanWorld("print('canonical')");
  const { res, out } = fakeRes();

  await executeSuiteQL({
    res,
    deps: { sessions: world.sessions, files: world.files } as any,
    body: { query: "SELECT id FROM transaction", state: "S4_SOURCE" },
    capability: {
      actorId: "finance-producer",
      scopeId: world.scope,
      sessionId: world.session.id,
      aud: TOOL_BROKER_AUD,
      exp: Date.now() + 60_000,
    },
  } as ApiCtx);

  assert.equal(out.status, 403);
  assert.deepEqual(out.body, {
    error: "governed_source_rejects_caller_plan",
    message: "QM compiles the durable human-approved source plan; callers cannot select SQL, rows, or bundle artifacts",
  });
});

test("executeSuiteQL does not treat an unrelated durable workflow as governed finance", async () => {
  const sessions = createMemorySessionStore();
  const scope = scopeId("personal", "unrelated-workflow");
  const session = await sessions.getOrCreateByThread("unrelated-workflow", "dm", scope);
  const attempt = await sessions.acquireLease(session.id, "turn");
  assert.ok(attempt.lease);
  const workflow = createWorkflowControl({
    sessions,
    lease: attempt.lease,
    scopeLabel: scope,
    session,
    definitions: [{ id: "content-review", version: 1, steps: [{ id: "READY", role: "author", requiredSkills: [] }] }],
    runtime: () => ({ harnessId: "pi", modelId: "gpt-5.6-luna" }),
    resolveEvidence: async () => [],
  });
  await workflow({ action: "advance", workflowId: "content-review", step: "READY", decision: "pass" });
  const { res, out } = fakeRes();

  await executeSuiteQL({
    res,
    deps: { sessions } as any,
    body: { query: "SELECT id FROM transaction", state: "S4_SOURCE" },
    capability: {
      actorId: "author",
      scopeId: scope,
      sessionId: session.id,
      aud: TOOL_BROKER_AUD,
      exp: Date.now() + 60_000,
    },
  } as ApiCtx);

  assert.equal(out.status, 403);
  assert.equal((out.body as any).error, "governed_source_workflow_required");
});

test("executeSuiteQL executes an approved source plan once and reuses its persisted population receipts", async () => {
  const batch = {
    queries: [
      { id: "receipts", limit: 1000, sql: "SELECT 'receipts' AS population FROM transaction" },
      { id: "nativeopen", limit: 1000, sql: "SELECT 'nativeopen' AS population FROM transaction" },
      { id: "sapopen", limit: 1000, sql: "SELECT 'sapopen' AS population FROM transaction" },
      { id: "sapopen_custinvc", limit: 1000, sql: "SELECT 'sapopen_custinvc' AS population FROM transaction" },
      { id: "glcontrol", limit: 100, sql: "SELECT 'glcontrol' AS population FROM transaction" },
      { id: "gltypesplit", limit: 100, sql: "SELECT 'gltypesplit' AS population FROM transaction" },
    ],
  };
  const script = "print('canonical')";
  const world = await approvedSourcePlanWorld(script);
  const imported: Array<{ path: string; data: Uint8Array }> = [];
  const commands: string[] = [];
  const handle = { id: "finance-compiler", rootDir: "/workspace" } as SandboxHandle;
  const sandbox = {
    profile: { backend: "test", writablePersistence: "provider_managed", processSessions: false },
    provision: async () => handle,
    importFiles: async (_handle: SandboxHandle, entries: ReadonlyArray<{ path: string; data: Uint8Array }>) => {
      imported.push(...entries);
    },
    writeFile: async (_handle: SandboxHandle, path: string, data: string) => {
      imported.push({ path, data: Buffer.from(data) });
    },
    run: async (_handle: SandboxHandle, command: string) => {
      commands.push(command);
      return { stdout: JSON.stringify(batch), stderr: "", code: 0, timedOut: false };
    },
    teardown: async () => {},
  } as unknown as Sandbox;
  const secret = JSON.stringify({
    accountId: "1234567_SB1",
    consumerKey: "consumer key",
    consumerSecret: "consumer secret",
    tokenId: "token id",
    tokenSecret: "token secret",
  });
  const serviceCreds: ServiceCredentialReader = {
    getServiceCredentialSecret: async () =>
      ({
        slug: "netsuite",
        name: "NetSuite",
        secret,
        delivery: "broker",
        host: "1234567-sb1.suitetalk.api.netsuite.com",
        deployments: true,
        enabled: true,
      }) as DecryptedServiceCredential,
  };
  let brokerCalls = 0;
  const brokerFetch: BrokerFetch = async (_url, init) => {
    brokerCalls += 1;
    const query = (JSON.parse(init.body ?? "{}") as { q: string }).q;
    const population = /SELECT '([^']+)'/.exec(query)?.[1] ?? "unknown";
    return {
      status: 200,
      contentType: "application/json",
      text: async () => JSON.stringify({ items: [{ population }], totalResults: 1, hasMore: false }),
    };
  };
  const { res, out } = fakeRes();

  await executeSuiteQL({
    res,
    deps: {
      sessions: world.sessions,
      files: world.files,
      skills: world.skills,
      sandbox,
      serviceCreds,
      brokerFetch,
      capabilitySecret: "finance-source-attestation-test-secret",
    } as any,
    body: {},
    capability: {
      actorId: "finance-producer",
      scopeId: world.scope,
      sessionId: world.session.id,
      aud: TOOL_BROKER_AUD,
      exp: Date.now() + 60_000,
    },
  } as ApiCtx);

  assert.equal(out.status, 200);
  assert.equal(commands.length, 1);
  assert.match(
    commands[0]!,
    /--receipt-start 2026-10-12 --receipt-end 2026-10-18 --as-of 2026-10-19 --source-plan '\/workspace\/approved-source-plan.json' --print-batch/,
  );
  assert.ok(imported.some((entry) => entry.path.endsWith("/scripts/generate_ar_report.py")));
  assert.equal(
    Buffer.from(imported.find((entry) => entry.path.endsWith("/scripts/generate_ar_report.py"))!.data).toString(),
    script,
  );
  assert.equal((out.body as any).complete, true);
  assert.deepEqual(
    JSON.parse(Buffer.from(imported.find((entry) => entry.path === "approved-source-plan.json")!.data).toString())
      .scope,
    sourceScope,
  );
  assert.equal(brokerCalls, 6);
  assert.deepEqual((out.body as any).results[0], {
    id: "receipts",
    rows: [{ population: "receipts" }],
    totalResults: 1,
    hasMore: false,
    querySha256: createHash("sha256").update(batch.queries[0]!.sql).digest("hex"),
    rowsSha256: createHash("sha256")
      .update(JSON.stringify([{ population: "receipts" }]))
      .digest("hex"),
  });
  assert.equal((out.body as any).metadata.sourcePlanArtifactId, world.sourcePlanArtifactId);
  assert.match((out.body as any).metadata.queryBundleArtifactId, /^[0-9a-f]{32}$/);
  assert.match((out.body as any).metadata.queryBundleSha256, /^[0-9a-f]{64}$/);
  assert.deepEqual((out.body as any).metadata.queryBundleEvidence, {
    id: (out.body as any).metadata.queryBundleArtifactId,
    digest: (out.body as any).metadata.queryBundleSha256,
  });
  assert.match((out.body as any).metadata.rawEvidenceSha256, /^[0-9a-f]{64}$/);
  const stored = await world.files.open((out.body as any).metadata.queryBundleArtifactId);
  assert.ok(stored);
  const chunks: Buffer[] = [];
  for await (const chunk of stored.stream) chunks.push(Buffer.from(chunk));
  const persisted = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  assert.deepEqual(
    persisted.queries.map((entry: { id: string }) => entry.id),
    ["receipts", "nativeopen", "sapopen", "sapopen_custinvc", "glcontrol", "gltypesplit"],
  );

  const rawEvidence = await world.files.open((out.body as any).metadata.rawEvidenceArtifactId);
  assert.ok(rawEvidence);
  const rawChunks: Buffer[] = [];
  for await (const chunk of rawEvidence.stream) rawChunks.push(Buffer.from(chunk));
  const persistedEvidence = JSON.parse(Buffer.concat(rawChunks).toString("utf8"));
  assert.deepEqual(persistedEvidence.parameters, {
    receiptStart: "2026-10-12",
    receiptEnd: "2026-10-18",
    asOf: "2026-10-19",
  });
  assert.deepEqual(persistedEvidence.results, (out.body as any).results);

  const retry = fakeRes();
  await executeSuiteQL({
    res: retry.res,
    deps: {
      sessions: world.sessions,
      files: world.files,
      skills: world.skills,
      sandbox,
      serviceCreds,
      brokerFetch,
      capabilitySecret: "finance-source-attestation-test-secret",
    } as any,
    body: {},
    capability: {
      actorId: "finance-producer",
      scopeId: world.scope,
      sessionId: world.session.id,
      aud: TOOL_BROKER_AUD,
      exp: Date.now() + 60_000,
    },
  } as ApiCtx);

  assert.equal(retry.out.status, 200);
  assert.deepEqual(retry.out.body, out.body);
  assert.equal(brokerCalls, 6);
  assert.equal(commands.length, 1);
});

test("executeSuiteQL refuses a published query generator whose digest is not pinned by the workflow", async () => {
  const world = await approvedSourcePlanWorld("print('unapproved generator')", "0".repeat(64));
  let provisioned = false;
  const sandbox = {
    profile: { backend: "test", writablePersistence: "provider_managed", processSessions: false },
    provision: async () => {
      provisioned = true;
      throw new Error("must not provision");
    },
  } as unknown as Sandbox;
  const { res, out } = fakeRes();

  await executeSuiteQL({
    res,
    deps: { sessions: world.sessions, files: world.files, skills: world.skills, sandbox } as any,
    body: {},
    capability: {
      actorId: "finance-producer",
      scopeId: world.scope,
      sessionId: world.session.id,
      aud: TOOL_BROKER_AUD,
      exp: Date.now() + 60_000,
    },
  } as ApiCtx);

  assert.equal(out.status, 409);
  assert.deepEqual(out.body, {
    error: "canonical_finance_skill_not_pinned",
    message: "The active workflow does not pin the configured finance compiler digest",
  });
  assert.equal(provisioned, false);
});

test("executeSuiteQL compiles a different valid approved date window without question-specific dates", async () => {
  const script = "print('canonical')";
  const world = await approvedSourcePlanWorld(script, undefined, {
    receiptStart: "2027-01-03",
    receiptEnd: "2027-01-09",
    asOf: "2027-01-10",
  });
  const commands: string[] = [];
  const ids = ["receipts", "nativeopen", "sapopen", "sapopen_custinvc", "glcontrol", "gltypesplit"];
  const sandbox = {
    profile: { backend: "test", writablePersistence: "provider_managed", processSessions: false },
    provision: async () => ({ id: "finance-compiler", rootDir: "/workspace" }),
    importFiles: async () => {},
    writeFile: async () => {},
    run: async (_handle: SandboxHandle, command: string) => {
      commands.push(command);
      return {
        stdout: JSON.stringify({
          queries: ids.map((id) => ({ id, limit: id.startsWith("gl") ? 100 : 1000, sql: `SELECT '${id}'` })),
        }),
        stderr: "",
        code: 0,
        timedOut: false,
      };
    },
    teardown: async () => {},
  } as unknown as Sandbox;
  const serviceCreds: ServiceCredentialReader = { getServiceCredentialSecret: async () => null };
  const { res, out } = fakeRes();

  await executeSuiteQL({
    res,
    deps: { sessions: world.sessions, files: world.files, skills: world.skills, sandbox, serviceCreds } as any,
    body: {},
    capability: {
      actorId: "finance-producer",
      scopeId: world.scope,
      sessionId: world.session.id,
      aud: TOOL_BROKER_AUD,
      exp: Date.now() + 60_000,
    },
  } as ApiCtx);

  assert.equal(out.status, 404);
  assert.match(commands[0]!, /--receipt-start 2027-01-03 --receipt-end 2027-01-09 --as-of 2027-01-10/);
});

test("executeSuiteQL rejects an approved source plan whose dates are out of order", async () => {
  const world = await approvedSourcePlanWorld("print('canonical')", undefined, {
    receiptStart: "2027-01-09",
    receiptEnd: "2027-01-03",
    asOf: "2027-01-10",
  });
  let provisioned = false;
  const sandbox = {
    profile: { backend: "test", writablePersistence: "provider_managed", processSessions: false },
    provision: async () => {
      provisioned = true;
      throw new Error("must not provision");
    },
  } as unknown as Sandbox;
  const { res, out } = fakeRes();

  await executeSuiteQL({
    res,
    deps: { sessions: world.sessions, files: world.files, skills: world.skills, sandbox } as any,
    body: {},
    capability: {
      actorId: "finance-producer",
      scopeId: world.scope,
      sessionId: world.session.id,
      aud: TOOL_BROKER_AUD,
      exp: Date.now() + 60_000,
    },
  } as ApiCtx);

  assert.equal(out.status, 403);
  assert.equal((out.body as any).error, "source_plan_not_approved");
  assert.equal(provisioned, false);
});

test("executeSuiteQL rejects noncanonical source-plan date aliases", async () => {
  const dates = { receiptStart: "2026-10-12", receiptEnd: "2026-10-18", asOf: "2026-10-19" };
  const world = await approvedSourcePlanWorld("print('canonical')", undefined, dates, {
    schemaVersion: 1,
    workflowId: "finance-golden-harness",
    scope: sourceScope,
    boundaries: {
      receipt_start_date: dates.receiptStart,
      receipt_end_date: dates.receiptEnd,
      outstanding_cutoff: dates.asOf,
    },
  });
  let provisioned = false;
  const sandbox = {
    profile: { backend: "test", writablePersistence: "provider_managed", processSessions: false },
    provision: async () => {
      provisioned = true;
      throw new Error("must not provision");
    },
  } as unknown as Sandbox;
  const { res, out } = fakeRes();

  await executeSuiteQL({
    res,
    deps: { sessions: world.sessions, files: world.files, skills: world.skills, sandbox } as any,
    body: {},
    capability: {
      actorId: "finance-producer",
      scopeId: world.scope,
      sessionId: world.session.id,
      aud: TOOL_BROKER_AUD,
      exp: Date.now() + 60_000,
    },
  } as ApiCtx);

  assert.equal(out.status, 403);
  assert.equal((out.body as any).error, "source_plan_not_approved");
  assert.equal(provisioned, false);
});

for (const scenario of [
  { name: "missing envelope", pages: [{}], status: 502 },
  { name: "missing completion marker", pages: [{ items: [], totalResults: 0 }], status: 502 },
  { name: "short final count", pages: [{ items: [{ id: "1" }], totalResults: 2, hasMore: false }], status: 502 },
  {
    name: "changing population count",
    pages: [
      { items: [{ id: "1" }], totalResults: 2, hasMore: true },
      { items: [{ id: "2" }], totalResults: 3, hasMore: false },
    ],
    status: 502,
  },
  {
    name: "complete ordered pages",
    pages: [
      { items: [{ id: "1" }], totalResults: 2, hasMore: true },
      { items: [{ id: "2" }], totalResults: 2, hasMore: false },
    ],
    status: 200,
  },
]) {
  test(`executeSuiteQL validates ${scenario.name} before durable source custody`, async () => {
    const world = await approvedSourcePlanWorld("print('canonical')");
    const ids = ["receipts", "nativeopen", "sapopen", "sapopen_custinvc", "glcontrol", "gltypesplit"];
    const sandbox = {
      profile: { backend: "test", writablePersistence: "provider_managed", processSessions: false },
      provision: async () => ({ id: "compiler", rootDir: "/workspace" }),
      importFiles: async () => {},
      writeFile: async () => {},
      run: async () => ({
        stdout: JSON.stringify({
          queries: ids.map((id) => ({ id, limit: 1, sql: "SELECT id FROM transaction ORDER BY id" })),
        }),
        stderr: "",
        code: 0,
        timedOut: false,
      }),
      teardown: async () => {},
    } as unknown as Sandbox;
    const serviceCreds: ServiceCredentialReader = {
      getServiceCredentialSecret: async () =>
        ({
          slug: "netsuite",
          name: "NetSuite",
          enabled: true,
          delivery: "broker",
          secret: JSON.stringify({
            accountId: "TEST_SB1",
            consumerKey: "key",
            consumerSecret: "secret",
            tokenId: "token",
            tokenSecret: "secret",
          }),
        }) as DecryptedServiceCredential,
    };
    let sourceCalls = 0;
    const brokerFetch: BrokerFetch = async (url) => {
      sourceCalls += 1;
      const page = scenario.pages[Number(new URL(url).searchParams.get("offset"))];
      assert.ok(page);
      return { status: 200, contentType: "application/json", text: async () => JSON.stringify(page) };
    };
    const ctx = {
      deps: {
        sessions: world.sessions,
        files: world.files,
        skills: world.skills,
        sandbox,
        serviceCreds,
        brokerFetch,
        capabilitySecret: "finance-source-attestation-test-secret",
      },
      body: {},
      capability: {
        actorId: "finance-producer",
        scopeId: world.scope,
        sessionId: world.session.id,
        aud: TOOL_BROKER_AUD,
        exp: Date.now() + 60_000,
      },
    };
    const first = fakeRes();
    await executeSuiteQL({ ...ctx, res: first.res } as unknown as ApiCtx);
    assert.equal(first.out.status, scenario.status);
    const rawId = fileArtifactId(`finance-source-execution:${world.sourcePlanArtifactId}`, "out", 0);
    const stored = await world.files.open(rawId);
    if (scenario.status !== 200) {
      assert.equal(stored, null);
      assert.notEqual((first.out.body as any).complete, true);
      return;
    }
    assert.ok(stored);
    assert.equal(sourceCalls, 12);
    assert.deepEqual((first.out.body as any).results[0].rows, [{ id: "1" }, { id: "2" }]);
    const retry = fakeRes();
    await executeSuiteQL({ ...ctx, res: retry.res } as unknown as ApiCtx);
    assert.equal(retry.out.status, 200);
    assert.equal(sourceCalls, 12);
  });
}
