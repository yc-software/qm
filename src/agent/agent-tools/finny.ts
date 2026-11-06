import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type, type TSchema } from "typebox";
import {
  FINNY_CHECK_IDS,
  type FinnyAuditFinding,
  type FinnyCheckId,
  type FinnyMaterialClarification,
  type FinnyPlanPresentation,
} from "../../finny/types.ts";
import { text, type ToolKit } from "./kit.ts";

export interface FinnyToolService {
  createPlan(plan: FinnyPlanPresentation, materialClarification?: FinnyMaterialClarification): Promise<string>;
  status(jobId: string): Promise<string>;
  artifactReady(input: {
    artifactDigest: string;
    provisionalRevision: string;
    idempotencyKey: string;
  }): Promise<string>;
  pass(input: {
    checkId: FinnyCheckId;
    generation: number;
    evidenceFileId: string;
    idempotencyKey: string;
  }): Promise<string>;
  deterministicAudit(input: { idempotencyKey: string }): Promise<string>;
  block(input: {
    checkId: FinnyCheckId;
    generation: number;
    evidenceFileId: string;
    findings: FinnyAuditFinding[];
    idempotencyKey: string;
  }): Promise<string>;
  finalize(input: { jobId: string; idempotencyKey: string }): Promise<string>;
}

const string = () => Type.String({ minLength: 1 });
const checkId = Type.Union(FINNY_CHECK_IDS.map((value) => Type.Literal(value)));
const finding = Type.Object({ code: string(), message: string() }, { additionalProperties: false });
const clarificationOption = Type.Object(
  { id: string(), label: string(), description: Type.Optional(string()) },
  { additionalProperties: false },
);
const materialClarification = Type.Object(
  {
    question: string(),
    options: Type.Array(clarificationOption, { minItems: 2, maxItems: 5 }),
    recommendedOptionId: string(),
  },
  { additionalProperties: false },
);

const plan = Type.Object(
  {
    title: string(),
    summary: Type.Optional(string()),
    phases: Type.Array(
      Type.Object(
        { name: string(), owner: string(), dependencies: Type.Array(string()) },
        { additionalProperties: false },
      ),
      { minItems: 1 },
    ),
    certification: string(),
    deliverable: string(),
    destination: string(),
    clarifications: Type.Array(Type.Object({ question: string(), answer: string() }, { additionalProperties: false })),
  },
  { additionalProperties: false },
);

export function finnyTools(kit: ToolKit) {
  const { ref, recordCall, recordResult, resourceTool } = kit;
  const run = async (
    callId: string,
    action: string,
    summary: Record<string, unknown>,
    invoke: () => Promise<string>,
  ) => {
    await recordCall(callId, { tool: "finny", action, ...summary });
    const result = await invoke();
    return recordResult(callId, { tool: "finny", action, ...summary }, text(result), false, undefined, true);
  };
  const createPlan = defineTool({
    name: "finny_create_plan",
    label: "Create Finny plan",
    description: "Create a plan from presentation content. Core supplies its identity, policy, origin, and approval.",
    parameters: Type.Object(
      { plan, materialClarification: Type.Optional(materialClarification) },
      { additionalProperties: false },
    ),
    execute: (callId, params) =>
      run(callId, "create_plan", { title: params.plan.title }, () =>
        ref.current!.finny!.createPlan(params.plan, params.materialClarification),
      ),
  });
  const status = defineTool({
    name: "finny_status",
    label: "Finny status",
    description: "Read the current authoritative state of a Finny job.",
    parameters: Type.Object({ jobId: string() }, { additionalProperties: false }),
    execute: (callId, params) =>
      run(callId, "status", { jobId: params.jobId }, () => ref.current!.finny!.status(params.jobId)),
  });
  const artifactReady = defineTool({
    name: "finny_artifact_ready",
    label: "Finny artifact ready",
    description: "Record the digest and provisional revision of the actual produced artifact.",
    parameters: Type.Object(
      { artifactDigest: string(), provisionalRevision: string(), idempotencyKey: string() },
      { additionalProperties: false },
    ),
    execute: (callId, params) =>
      run(callId, "artifact_ready", { artifactDigest: params.artifactDigest }, () =>
        ref.current!.finny!.artifactReady({
          artifactDigest: params.artifactDigest,
          provisionalRevision: params.provisionalRevision,
          idempotencyKey: params.idempotencyKey,
        }),
      ),
  });
  const pass = defineTool({
    name: "finny_pass",
    label: "Finny audit pass",
    description: "Submit digest-bound PASS evidence for one current check generation.",
    parameters: Type.Object(
      { checkId, generation: Type.Integer({ minimum: 1 }), evidenceFileId: string(), idempotencyKey: string() },
      { additionalProperties: false },
    ),
    execute: (callId, params) =>
      run(callId, "pass", { checkId: params.checkId, generation: params.generation }, () =>
        ref.current!.finny!.pass({
          checkId: params.checkId,
          generation: params.generation,
          evidenceFileId: params.evidenceFileId,
          idempotencyKey: params.idempotencyKey,
        }),
      ),
  });
  const block = defineTool({
    name: "finny_block",
    label: "Finny audit block",
    description: "Submit bounded findings for one current check generation. Core selects rework or escalation.",
    parameters: Type.Object(
      {
        checkId,
        generation: Type.Integer({ minimum: 1 }),
        evidenceFileId: string(),
        findings: Type.Array(finding, { minItems: 1 }),
        idempotencyKey: string(),
      },
      { additionalProperties: false },
    ),
    execute: (callId, params) =>
      run(
        callId,
        "block",
        { checkId: params.checkId, generation: params.generation, findingCount: params.findings.length },
        () =>
          ref.current!.finny!.block({
            checkId: params.checkId,
            generation: params.generation,
            evidenceFileId: params.evidenceFileId,
            findings: params.findings,
            idempotencyKey: params.idempotencyKey,
          }),
      ),
  });
  const deterministicAudit = defineTool({
    name: "finny_deterministic_audit",
    label: "Finny deterministic audit",
    description: "Run Core-owned deterministic spreadsheet checks against the current bound artifact.",
    parameters: Type.Object({ idempotencyKey: string() }, { additionalProperties: false }),
    execute: (callId, params) =>
      run(callId, "deterministic_audit", {}, () =>
        ref.current!.finny!.deterministicAudit({ idempotencyKey: params.idempotencyKey }),
      ),
  });
  const finalize = defineTool({
    name: "finny_finalize",
    label: "Finalize Finny job",
    description: "Ask Core to finalize from authoritative job state using only the job and idempotency key.",
    parameters: Type.Object({ jobId: string(), idempotencyKey: string() }, { additionalProperties: false }),
    execute: (callId, params) =>
      run(callId, "finalize", { jobId: params.jobId }, () =>
        ref.current!.finny!.finalize({ jobId: params.jobId, idempotencyKey: params.idempotencyKey }),
      ),
  });
  const tool = resourceTool("finny", {
    create_plan: createPlan,
    status,
    artifact_ready: artifactReady,
    pass,
    block,
    deterministic_audit: deterministicAudit,
    finalize,
  });
  const properties = Object.fromEntries(
    Object.entries({
      plan,
      materialClarification,
      jobId: string(),
      artifactDigest: string(),
      provisionalRevision: string(),
      idempotencyKey: string(),
      checkId,
      generation: Type.Integer({ minimum: 1 }),
      evidenceFileId: string(),
      findings: Type.Array(finding, { minItems: 1 }),
    }).map(([key, schema]) => [key, Type.Optional(schema as TSchema)]),
  );
  const actionFields = {
    create_plan: ["plan"],
    status: ["jobId"],
    artifact_ready: ["artifactDigest", "provisionalRevision", "idempotencyKey"],
    pass: ["checkId", "generation", "evidenceFileId", "idempotencyKey"],
    block: ["checkId", "generation", "evidenceFileId", "findings", "idempotencyKey"],
    deterministic_audit: ["idempotencyKey"],
    finalize: ["jobId", "idempotencyKey"],
  } as const;
  const contentFields = Object.keys(properties);
  const parameters = Type.Object(
    {
      action: Type.Union(Object.keys(actionFields).map((action) => Type.Literal(action))),
      ...properties,
    },
    { additionalProperties: false },
  );
  Object.assign(parameters, {
    anyOf: Object.entries(actionFields).map(([action, required]) => ({
      properties: {
        action: { const: action },
        ...(action === "create_plan" ? { retrySafe: { const: false } } : {}),
      },
      required: ["action", ...required],
      not: {
        anyOf: contentFields
          .filter(
            (field) =>
              !required.includes(field as never) && !(action === "create_plan" && field === "materialClarification"),
          )
          .map((field) => ({ required: [field] })),
      },
    })),
  });
  return { ...tool, parameters };
}
