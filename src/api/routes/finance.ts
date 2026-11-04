import { createHash, randomBytes } from "node:crypto";
import { TOOL_BROKER_AUD, CREDENTIAL_BROKER_AUD } from "../../auth/capability-token.ts";
import { parseNetSuiteTbaSecret, netSuiteTbaAuthorization } from "../../credentials/netsuite-tba.ts";
import { realBrokerFetch, type BrokerFetch } from "../credential-broker.ts";
import { sendJson } from "../http.ts";
import type { ApiCtx, Route } from "./route.ts";
import { scopeId as makeScopeId } from "../../types.ts";
import { orgId as configOrgId } from "../../config.ts";
import { collectBytes } from "../../util/bytes.ts";
import { workflowDefinitionsForSession } from "../../sessions/workflow-control.ts";
import { acceptedWorkflowGate } from "../../sessions/workflow-gate.ts";
import type { WorkflowDefinition, WorkflowEvidence } from "../../sessions/workflow-gate.ts";
import { materializeSkillTree, skillDir } from "../../skills/materialize.ts";
import { fileArtifactId } from "../../files/file-artifact-store.ts";
import { shq } from "../../util/shell.ts";
import { mintSignedPayload, verifySignedPayload } from "../../auth/signed-token.ts";

export interface SuiteQLRow {
  [column: string]: unknown;
}

export interface SuiteQLResponse {
  rows: SuiteQLRow[];
  totalResults?: number;
  hasMore?: boolean;
  metadata?: Record<string, unknown>;
}

interface QueryBundleEntry {
  id: string;
  limit: number;
  sql: string;
}

interface QueryBundle {
  schemaVersion: number;
  workflowId: string;
  parameters: SourcePlanDates;
  scope: SourcePlanScope;
  sourcePlanArtifactId?: string;
  skill?: { id: string; version: number; scriptSha256: string };
  queries: QueryBundleEntry[];
}

function isQueryBundle(value: unknown, workflowId: string): value is QueryBundle {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const bundle = value as Record<string, unknown>;
  if (bundle.schemaVersion !== 1 || bundle.workflowId !== workflowId) return false;
  if (!sourcePlanDates(bundle, workflowId)) return false;
  if (!Array.isArray(bundle.queries)) return false;
  const ids = new Set<string>();
  for (const candidate of bundle.queries) {
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) return false;
    const query = candidate as Record<string, unknown>;
    if (typeof query.id !== "string" || !query.id || ids.has(query.id)) return false;
    if (typeof query.sql !== "string" || !query.sql.trim()) return false;
    if (!Number.isSafeInteger(query.limit) || Number(query.limit) < 1 || Number(query.limit) > 1000) return false;
    ids.add(query.id);
  }
  return true;
}

async function hasGovernedSourceWorkflow(ctx: ApiCtx): Promise<boolean> {
  const sessionId = ctx.capability?.sessionId;
  if (!sessionId || !ctx.deps.sessions) return false;
  const definitions = await workflowDefinitionsForSession({
    sessions: ctx.deps.sessions,
    sessionId,
    configured: [],
  });
  return definitions.some((definition) => definition.sourceExecution !== undefined);
}

interface SourcePlanDates {
  receiptStart: string;
  receiptEnd: string;
  asOf: string;
}

function canonicalDate(value: unknown): string | undefined {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return undefined;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(parsed.valueOf()) && parsed.toISOString().slice(0, 10) === value ? value : undefined;
}

function sourcePlanDates(sourcePlan: unknown, workflowId: string): SourcePlanDates | undefined {
  if (!sourcePlan || typeof sourcePlan !== "object" || Array.isArray(sourcePlan)) return undefined;
  const artifact = sourcePlan as Record<string, unknown>;
  if (artifact.schemaVersion !== 1 || artifact.workflowId !== workflowId) return undefined;
  if (!artifact.parameters || typeof artifact.parameters !== "object" || Array.isArray(artifact.parameters))
    return undefined;
  const parameters = artifact.parameters as Record<string, unknown>;
  const dates = {
    receiptStart: canonicalDate(parameters.receiptStart),
    receiptEnd: canonicalDate(parameters.receiptEnd),
    asOf: canonicalDate(parameters.asOf),
  };
  if (!dates.receiptStart || !dates.receiptEnd || !dates.asOf) return undefined;
  if (dates.receiptStart > dates.receiptEnd || dates.receiptEnd > dates.asOf) return undefined;
  return { receiptStart: dates.receiptStart, receiptEnd: dates.receiptEnd, asOf: dates.asOf };
}

async function readArtifactJson(ctx: ApiCtx, evidence: WorkflowEvidence): Promise<unknown> {
  const opened = await ctx.deps.files?.open(evidence.id);
  if (!opened || opened.artifact.ownerScopeId !== ctx.capability?.scopeId || opened.artifact.sha256 !== evidence.digest)
    return undefined;
  const collected = await collectBytes(opened.stream, { maxBytes: 1024 * 1024 });
  if (collected.sha256 !== evidence.digest) return undefined;
  try {
    return JSON.parse(collected.data.toString("utf8"));
  } catch {
    return undefined;
  }
}

interface SourcePlanScope {
  entity: string;
  subsidiaryScope: string;
  currencyBasis: string;
  accountingBook: string;
  comparisonBasis: string;
  reportingTimezone: string;
  historicalCutoffBasis: string;
}

function sourcePlanScope(value: unknown): SourcePlanScope | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const candidate = (value as Record<string, unknown>).scope;
  if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) return undefined;
  const scope = candidate as Record<string, unknown>;
  const fields = [
    "entity",
    "subsidiaryScope",
    "currencyBasis",
    "accountingBook",
    "comparisonBasis",
    "reportingTimezone",
    "historicalCutoffBasis",
  ] as const;
  if (
    Object.keys(scope).length !== fields.length ||
    fields.some((key) => typeof scope[key] !== "string" || !String(scope[key]).trim())
  )
    return undefined;
  return Object.fromEntries(fields.map((key) => [key, scope[key]])) as unknown as SourcePlanScope;
}

interface ApprovedSourcePlan {
  artifactId: string;
  dates: SourcePlanDates;
  scope: SourcePlanScope;
  value: unknown;
  definition: WorkflowDefinition;
}

interface PopulationResult {
  id: string;
  rows: SuiteQLRow[];
  totalResults: number;
  hasMore: false;
  querySha256: string;
  rowsSha256: string;
}

interface RawSourceEvidence {
  schemaVersion: 1;
  attestation: string;
  workflowId: string;
  parameters: SourcePlanDates;
  scope: SourcePlanScope;
  sourcePlanArtifactId: string;
  queryBundleArtifactId: string;
  queryBundleSha256: string;
  retrievedAt: string;
  results: PopulationResult[];
}

function sourceExecutionArtifactId(sourcePlanArtifactId: string): string {
  return fileArtifactId(`finance-source-execution:${sourcePlanArtifactId}`, "out", 0);
}

function queryBundleArtifactId(sourcePlanArtifactId: string): string {
  return fileArtifactId(`finance-source-execution:${sourcePlanArtifactId}`, "out", 1);
}

function isSha256(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{64}$/.test(value);
}

function isPopulationResult(value: unknown): value is PopulationResult {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const result = value as Record<string, unknown>;
  return (
    typeof result.id === "string" &&
    result.id.length > 0 &&
    Array.isArray(result.rows) &&
    result.rows.every((row) => row !== null && typeof row === "object" && !Array.isArray(row)) &&
    Number.isSafeInteger(result.totalResults) &&
    result.totalResults === result.rows.length &&
    result.hasMore === false &&
    isSha256(result.querySha256) &&
    isSha256(result.rowsSha256) &&
    result.rowsSha256 === createHash("sha256").update(JSON.stringify(result.rows)).digest("hex")
  );
}

async function persistedSourceExecution(
  ctx: ApiCtx,
  plan: ApprovedSourcePlan,
): Promise<Record<string, unknown> | undefined> {
  const id = sourceExecutionArtifactId(plan.artifactId);
  const opened = await ctx.deps.files?.open(id);
  if (!opened) return undefined;
  const invalid = {
    error: "invalid_persisted_source_evidence",
    message: "Stored source evidence is incomplete or invalid; create a fresh approved source plan",
  };
  if (opened.artifact.ownerScopeId !== ctx.capability?.scopeId || !opened.artifact.sha256) return invalid;
  const collected = await collectBytes(opened.stream, { maxBytes: 64 * 1024 * 1024 });
  if (collected.sha256 !== opened.artifact.sha256) return invalid;
  let evidence: RawSourceEvidence;
  try {
    evidence = JSON.parse(collected.data.toString("utf8")) as RawSourceEvidence;
  } catch {
    return invalid;
  }
  const attestationSecret = ctx.deps.capabilitySecret ?? ctx.secret;
  if (!attestationSecret) return invalid;
  const { attestation: _attestation, ...unsignedEvidence } = evidence ?? ({} as RawSourceEvidence);
  const unsignedSha256 = createHash("sha256").update(JSON.stringify(unsignedEvidence)).digest("hex");
  const attestation = await verifySignedPayload(evidence?.attestation ?? "", attestationSecret);
  if (
    !attestation ||
    typeof attestation !== "object" ||
    Array.isArray(attestation) ||
    (attestation as Record<string, unknown>).rawEvidenceSha256 !== unsignedSha256 ||
    (attestation as Record<string, unknown>).sourcePlanArtifactId !== plan.artifactId ||
    (attestation as Record<string, unknown>).sessionId !== ctx.capability?.sessionId ||
    !evidence ||
    typeof evidence !== "object" ||
    Array.isArray(evidence) ||
    evidence.schemaVersion !== 1 ||
    evidence.workflowId !== plan.definition.id ||
    JSON.stringify(evidence.parameters) !== JSON.stringify(plan.dates) ||
    JSON.stringify(sourcePlanScope(evidence)) !== JSON.stringify(plan.scope) ||
    evidence.sourcePlanArtifactId !== plan.artifactId ||
    typeof evidence.queryBundleArtifactId !== "string" ||
    !evidence.queryBundleArtifactId ||
    !isSha256(evidence.queryBundleSha256) ||
    !Array.isArray(evidence.results) ||
    !evidence.results.every(isPopulationResult) ||
    evidence.results.length !== plan.definition.sourceExecution!.expectedPopulations.length ||
    new Set(evidence.results.map((result) => result.id)).size !== evidence.results.length ||
    evidence.results.some((result) => !plan.definition.sourceExecution!.expectedPopulations.includes(result.id))
  )
    return invalid;
  const bundle = await readArtifactJson(ctx, {
    id: evidence.queryBundleArtifactId,
    digest: evidence.queryBundleSha256,
  });
  if (
    !isQueryBundle(bundle, plan.definition.id) ||
    bundle.sourcePlanArtifactId !== plan.artifactId ||
    JSON.stringify(bundle.parameters) !== JSON.stringify(plan.dates) ||
    JSON.stringify(sourcePlanScope(bundle)) !== JSON.stringify(plan.scope) ||
    bundle.queries.length !== evidence.results.length ||
    evidence.results.some((result) => {
      const query = bundle.queries.find((item) => item.id === result.id);
      return !query || result.querySha256 !== createHash("sha256").update(query.sql).digest("hex");
    })
  )
    return invalid;
  return {
    results: evidence.results,
    complete: true,
    metadata: {
      source: "ERP_GL",
      queryBundleArtifactId: evidence.queryBundleArtifactId,
      queryBundleEvidence: { id: evidence.queryBundleArtifactId, digest: evidence.queryBundleSha256 },
      queryBundleSha256: evidence.queryBundleSha256,
      sourcePlanArtifactId: evidence.sourcePlanArtifactId,
      rawEvidenceArtifactId: id,
      rawEvidenceSha256: collected.sha256,
    },
  };
}

async function approvedSourcePlan(ctx: ApiCtx): Promise<ApprovedSourcePlan | undefined> {
  const sessionId = ctx.capability?.sessionId;
  if (!sessionId || !ctx.deps.sessions || !ctx.deps.files) return undefined;
  const entries = await ctx.deps.sessions.getEntries(sessionId, { tools: ["workflow_definition", "workflow_gate"] });
  const definitions = await workflowDefinitionsForSession({
    sessions: ctx.deps.sessions,
    sessionId,
    configured: [],
    entries,
  });
  const gates = entries
    .map(acceptedWorkflowGate)
    .filter((gate) => gate !== null)
    .reverse();
  for (const gate of gates) {
    const definition = definitions.find(
      (candidate) => candidate.id === gate.workflowId && candidate.version === gate.workflowVersion,
    );
    const step = definition?.steps.find((candidate) => candidate.id === gate.step);
    if (!definition?.sourceExecution || step?.id !== definition.sourceExecution.approvalStep || !step.humanApproval)
      continue;
    for (const evidence of gate.inputEvidence) {
      const sourcePlan = await readArtifactJson(ctx, evidence);
      const dates = sourcePlanDates(sourcePlan, definition.id);
      const scope = sourcePlanScope(sourcePlan);
      if (dates && scope) return { artifactId: evidence.id, dates, scope, value: sourcePlan, definition };
    }
  }
  return undefined;
}

async function compileApprovedQueryBundle(
  ctx: ApiCtx,
  plan: ApprovedSourcePlan,
): Promise<
  | { ok: true; bundle: QueryBundle; artifactId: string; artifactSha256: string; sourcePlanArtifactId: string }
  | { ok: false; status: number; error: string; message: string }
> {
  if (!ctx.deps.skills || !ctx.deps.sandbox || !ctx.deps.files || !ctx.capability)
    return {
      ok: false,
      status: 503,
      error: "source_plan_compiler_unavailable",
      message: "The registered skill compiler is not configured",
    };
  const orderedScopes = [...new Set([ctx.capability.scopeId, makeScopeId("org", configOrgId())])];
  const sourceExecution = plan.definition.sourceExecution!;
  const resolution = await ctx.deps.skills.resolve(sourceExecution.compiler.skillName, orderedScopes);
  const skill = resolution.skill;
  const script = skill?.manifest.files?.find((file) => file.path === sourceExecution.compiler.path)?.content;
  if (!skill || !script || !ctx.deps.skills.verify(skill))
    return {
      ok: false,
      status: 503,
      error: "canonical_finance_skill_unavailable",
      message: "The configured finance compiler skill or script is unavailable",
    };
  const scriptSha256 = createHash("sha256").update(script).digest("hex");
  if (scriptSha256 !== sourceExecution.compiler.contentDigest)
    return {
      ok: false,
      status: 409,
      error: "canonical_finance_skill_not_pinned",
      message: "The active workflow does not pin the configured finance compiler digest",
    };
  const handle = await ctx.deps.sandbox.provision([], {
    scratch: { key: `finance-source-plan:${ctx.capability.sessionId}` },
    routeScopeId: ctx.capability.scopeId,
  });
  try {
    const root = `.agent-skills/finance-source-plan/${skill.id}-${skill.version}`;
    await materializeSkillTree(ctx.deps.sandbox, handle, root, resolution);
    const scriptPath = `${handle.rootDir}/${skillDir(root, resolution)}/${sourceExecution.compiler.path}`;
    const planPath = `${handle.rootDir}/approved-source-plan.json`;
    await ctx.deps.sandbox.writeFile(handle, "approved-source-plan.json", JSON.stringify(plan.value));
    const result = await ctx.deps.sandbox.run(
      handle,
      `python3 ${shq(scriptPath)} --receipt-start ${plan.dates.receiptStart} --receipt-end ${plan.dates.receiptEnd} --as-of ${plan.dates.asOf} --source-plan ${shq(planPath)} --print-batch`,
      { timeoutMs: 30_000 },
    );
    if (result.code !== 0 || result.timedOut)
      return {
        ok: false,
        status: 502,
        error: "source_plan_compilation_failed",
        message: result.stderr.trim() || `Canonical source-plan compiler exited ${result.code}`,
      };
    let printed: unknown;
    try {
      printed = JSON.parse(result.stdout);
    } catch {
      return {
        ok: false,
        status: 502,
        error: "source_plan_compilation_failed",
        message: "Canonical source-plan compiler returned invalid JSON",
      };
    }
    const bundle: QueryBundle = {
      schemaVersion: 1,
      workflowId: plan.definition.id,
      parameters: plan.dates,
      scope: plan.scope,
      sourcePlanArtifactId: plan.artifactId,
      skill: { id: skill.id, version: skill.version, scriptSha256 },
      queries:
        printed && typeof printed === "object" && Array.isArray((printed as { queries?: unknown }).queries)
          ? ((printed as { queries: QueryBundleEntry[] }).queries ?? [])
          : [],
    };
    if (!isQueryBundle(bundle, plan.definition.id))
      return {
        ok: false,
        status: 502,
        error: "invalid_compiled_source_plan",
        message: "Canonical source-plan compiler returned an invalid query bundle",
      };
    const present = new Set(bundle.queries.map((entry) => entry.id));
    const missing = sourceExecution.expectedPopulations.filter((id) => !present.has(id));
    const expected = new Set<string>(sourceExecution.expectedPopulations);
    const unexpected = bundle.queries.map((entry) => entry.id).filter((id) => !expected.has(id));
    if (missing.length || unexpected.length || bundle.queries.length !== sourceExecution.expectedPopulations.length)
      return {
        ok: false,
        status: 502,
        error: "incomplete_compiled_source_plan",
        message: [
          missing.length ? `omitted ${missing.join(", ")}` : "",
          unexpected.length ? `added ${unexpected.join(", ")}` : "",
        ]
          .filter(Boolean)
          .join("; "),
      };
    const artifactId = queryBundleArtifactId(plan.artifactId);
    const bundleBytes = Buffer.from(JSON.stringify(bundle));
    const stored = await ctx.deps.files.put({
      id: artifactId,
      ownerScopeId: ctx.capability.scopeId,
      createdBy: ctx.capability.actorId,
      name: "finance-query-bundle.json",
      path: `artifacts/${artifactId}/finance-query-bundle.json`,
      mimetype: "application/json",
      data: bundleBytes,
      direction: "out",
      createdInScope: ctx.capability.scopeId,
    });
    if (stored.artifact.sha256 !== createHash("sha256").update(bundleBytes).digest("hex"))
      return {
        ok: false,
        status: 409,
        error: "source_plan_bundle_conflict",
        message: "Stored query bundle differs from the approved compiler output; create a fresh source plan",
      };
    return {
      ok: true,
      bundle,
      artifactId,
      artifactSha256: stored.artifact.sha256!,
      sourcePlanArtifactId: plan.artifactId,
    };
  } finally {
    await ctx.deps.sandbox.teardown(handle, { destroy: true });
  }
}

export async function executeSuiteQL(ctx: ApiCtx): Promise<void> {
  const { res, deps, body, capability } = ctx;
  if (!capability) {
    return sendJson(res, 401, { error: "unauthorized", message: "tool-broker capability token required" });
  }

  const payload = (body && typeof body === "object" ? body : {}) as Record<string, unknown>;
  if (!(await hasGovernedSourceWorkflow(ctx)))
    return sendJson(res, 403, {
      error: "governed_source_workflow_required",
      message: "Source execution requires a session with a registered governed source workflow",
    });
  if (Object.keys(payload).length)
    return sendJson(res, 403, {
      error: "governed_source_rejects_caller_plan",
      message:
        "QM compiles the durable human-approved source plan; callers cannot select SQL, rows, or bundle artifacts",
    });
  const approvedPlan = await approvedSourcePlan(ctx);
  if (!approvedPlan)
    return sendJson(res, 403, {
      error: "source_plan_not_approved",
      message: "A valid baseline source plan has not passed the durable human-approval gate",
    });
  const persisted = await persistedSourceExecution(ctx, approvedPlan);
  if (persisted) return sendJson(res, persisted.error ? 409 : 200, persisted);
  const compiled = await compileApprovedQueryBundle(ctx, approvedPlan);
  if (!compiled.ok) return sendJson(res, compiled.status, { error: compiled.error, message: compiled.message });
  const queryBundle = compiled.bundle;
  const compiledBundleArtifactId = compiled.artifactId;
  const compiledBundleSha256 = compiled.artifactSha256;
  const sourcePlanArtifactId = compiled.sourcePlanArtifactId;

  if (!deps.serviceCreds) {
    return sendJson(res, 503, {
      error: "service_credentials_unavailable",
      message: "QM service credentials store is not configured",
    });
  }

  const orgScope = makeScopeId("org", configOrgId());
  const cred = await deps.serviceCreds.getServiceCredentialSecret(orgScope, "netsuite");
  if (!cred || !cred.secret) {
    return sendJson(res, 404, {
      error: "netsuite_credential_not_found",
      message: "NetSuite service credential ('netsuite') is not configured in QM",
    });
  }

  try {
    const tba = parseNetSuiteTbaSecret(cred.secret);
    const host = cred.host || `${tba.accountId.toLowerCase().replace(/_/g, "-")}.suitetalk.api.netsuite.com`;
    const fetchImpl: BrokerFetch = deps.brokerFetch ?? realBrokerFetch;
    const postQuery = async (sql: string, limit: number, offset: number) => {
      const url = `https://${host}/services/rest/query/v1/suiteql?limit=${limit}&offset=${offset}`;
      const authHeader = netSuiteTbaAuthorization(tba, url, "POST", randomBytes(16).toString("hex"), Date.now());
      const response = await fetchImpl(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Prefer: "transient",
          Authorization: authHeader,
        },
        body: JSON.stringify({ q: sql }),
      });
      const text = await response.text();
      let json: Record<string, unknown>;
      try {
        json = JSON.parse(text);
      } catch {
        return { response, json: undefined };
      }
      return { response, json };
    };

    const results: PopulationResult[] = [];
    for (const planned of queryBundle.queries) {
      const rows: SuiteQLRow[] = [];
      let offset = 0;
      let totalResults = 0;
      for (;;) {
        const page = await postQuery(planned.sql, planned.limit, offset);
        if (!page.json)
          return sendJson(res, 502, {
            error: "invalid_netsuite_response",
            population: planned.id,
            status: page.response.status,
          });
        if (page.response.status < 200 || page.response.status >= 300)
          return sendJson(res, page.response.status, {
            error: "netsuite_query_failed",
            population: planned.id,
            details: page.json,
          });
        if (
          !Array.isArray(page.json.items) ||
          !page.json.items.every((row) => row !== null && typeof row === "object" && !Array.isArray(row)) ||
          typeof page.json.hasMore !== "boolean" ||
          !Number.isSafeInteger(page.json.totalResults) ||
          Number(page.json.totalResults) < 0 ||
          (page.json.count !== undefined && page.json.count !== page.json.items.length)
        )
          return sendJson(res, 502, { error: "invalid_netsuite_response", population: planned.id });
        const items = page.json.items as SuiteQLRow[];
        if (offset && totalResults !== page.json.totalResults)
          return sendJson(res, 502, { error: "source_changed_during_pagination", population: planned.id });
        totalResults = Number(page.json.totalResults);
        rows.push(...items);
        if (!page.json.hasMore) {
          if (rows.length !== totalResults)
            return sendJson(res, 502, { error: "incomplete_netsuite_response", population: planned.id });
          break;
        }
        if (items.length !== planned.limit || rows.length >= totalResults)
          return sendJson(res, 502, { error: "incomplete_netsuite_response", population: planned.id });
        offset += planned.limit;
      }
      results.push({
        id: planned.id,
        rows,
        totalResults: Math.max(totalResults, rows.length),
        hasMore: false,
        querySha256: createHash("sha256").update(planned.sql).digest("hex"),
        rowsSha256: createHash("sha256").update(JSON.stringify(rows)).digest("hex"),
      });
    }
    const rawEvidenceArtifactId = sourceExecutionArtifactId(sourcePlanArtifactId!);
    const unsignedEvidence = {
      schemaVersion: 1 as const,
      workflowId: queryBundle.workflowId,
      parameters: queryBundle.parameters,
      scope: queryBundle.scope,
      sourcePlanArtifactId,
      queryBundleArtifactId: compiledBundleArtifactId,
      queryBundleSha256: compiledBundleSha256,
      retrievedAt: new Date().toISOString(),
      results,
    };
    const unsignedSha256 = createHash("sha256").update(JSON.stringify(unsignedEvidence)).digest("hex");
    const attestationSecret = deps.capabilitySecret ?? ctx.secret;
    if (!attestationSecret)
      return sendJson(res, 503, {
        error: "source_attestation_unavailable",
        message: "QM source custody signing is unavailable",
      });
    const attestation = await mintSignedPayload(
      {
        sessionId: capability.sessionId,
        sourcePlanArtifactId,
        queryBundleArtifactId: compiledBundleArtifactId,
        queryBundleSha256: compiledBundleSha256,
        rawEvidenceSha256: unsignedSha256,
      },
      attestationSecret,
    );
    const rawEvidence = Buffer.from(JSON.stringify({ ...unsignedEvidence, attestation }));
    const storedEvidence = await deps.files!.put({
      id: rawEvidenceArtifactId,
      ownerScopeId: capability.scopeId,
      createdBy: capability.actorId,
      name: "finance-raw-evidence.json",
      path: `artifacts/${rawEvidenceArtifactId}/finance-raw-evidence.json`,
      mimetype: "application/json",
      data: rawEvidence,
      direction: "out",
      createdInScope: capability.scopeId,
    });
    if (!storedEvidence.created) {
      const persisted = await persistedSourceExecution(ctx, approvedPlan!);
      if (persisted) return sendJson(res, persisted.error ? 409 : 200, persisted);
    }
    return sendJson(res, 200, {
      results,
      complete: true,
      metadata: {
        source: "ERP_GL",
        queryBundleArtifactId: compiledBundleArtifactId,
        queryBundleEvidence: { id: compiledBundleArtifactId, digest: compiledBundleSha256 },
        ...(compiledBundleSha256 ? { queryBundleSha256: compiledBundleSha256 } : {}),
        ...(sourcePlanArtifactId ? { sourcePlanArtifactId } : {}),
        rawEvidenceArtifactId,
        rawEvidenceSha256: storedEvidence.artifact.sha256,
      },
    });
  } catch (err) {
    return sendJson(res, 500, {
      error: "suiteql_execution_error",
      message: err instanceof Error ? err.message : String(err),
    });
  }
}

export const suiteqlRoutes: ReadonlyArray<Route<ApiCtx>> = [
  {
    method: "POST",
    path: "/v1/finance/suiteql",
    auth: { aud: [TOOL_BROKER_AUD, CREDENTIAL_BROKER_AUD] },
    handle: executeSuiteQL,
  },
  {
    method: "POST",
    path: "/v1/tools/suiteql",
    auth: { aud: [TOOL_BROKER_AUD, CREDENTIAL_BROKER_AUD] },
    handle: executeSuiteQL,
  },
];
