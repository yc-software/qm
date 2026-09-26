import { workloadCheck } from "./workload-provider.ts";

export interface MaterializeShape {
  model: string;
  runId: string;
  credentialHandle: string;
  credentialSha256: string;
  tool: "sandbox" | "execute";
  sandboxId?: string;
}

export const MATERIALIZE_ENV_KEY = "QM_PERF_MATERIALIZATION_TOKEN";

export function validateMaterializeShape(shape: MaterializeShape): void {
  workloadCheck(typeof shape.model === "string" && shape.model.length > 0, "Materialization model required");
  workloadCheck(
    /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(shape.runId),
    "Materialization run UUID required",
  );
  workloadCheck(/^kc_[a-f0-9]{12}$/.test(shape.credentialHandle), "Exact native credential handle required");
  workloadCheck(/^[a-f0-9]{64}$/.test(shape.credentialSha256), "Synthetic credential SHA-256 required");
  workloadCheck(shape.tool === "sandbox" || shape.tool === "execute", "Native execute tool required");
  workloadCheck(
    shape.sandboxId === undefined || /^[a-zA-Z0-9_.:-]{1,128}$/.test(shape.sandboxId),
    "Invalid sandbox ID",
  );
}

export function materializeMarker(fixtureId: string, runId: string): string {
  return `[qm-perf-materialize:${fixtureId}:${runId}]`;
}

export function materializeSentinel(runId: string): string {
  return `QM_PERF_MATERIALIZED_${runId}`;
}

export function materializeInput(shape: MaterializeShape): Record<string, unknown> {
  validateMaterializeShape(shape);
  const program = `import hashlib,os; assert hashlib.sha256(os.environ["${MATERIALIZE_ENV_KEY}"].encode()).hexdigest()=="${shape.credentialSha256}"; print("${materializeSentinel(shape.runId)}")`;
  return {
    ...(shape.tool === "sandbox" ? { action: "exec" } : {}),
    command: `python3 -c '${program}'`,
    purpose: "Verify synthetic credential",
    timeout_seconds: 10,
    credentials: [shape.credentialHandle],
    ...(shape.sandboxId ? { sandbox_id: shape.sandboxId } : {}),
  };
}

function text(content: unknown): string {
  if (typeof content === "string") return content;
  workloadCheck(Array.isArray(content), "Materialization text content required");
  return content
    .filter((block) => block?.type === "text" && typeof block.text === "string")
    .map((block) => block.text)
    .join("\n");
}

export function materializeReply(body: Record<string, unknown>, fixtureId: string, shape?: MaterializeShape) {
  workloadCheck(Array.isArray(body.messages), "Materialization messages required");
  const messages = body.messages as Array<{ role?: string; content?: unknown }>;
  const marked = messages.flatMap((message, index) => {
    if (message.role !== "user") return [];
    const source = text(message.content);
    return source.includes("[qm-perf-materialize:") ? [{ index, source }] : [];
  });
  if (marked.length === 0) return null;
  workloadCheck(shape && marked.length === 1, "One configured materialization marker required");
  validateMaterializeShape(shape);
  const marker = materializeMarker(fixtureId, shape.runId);
  const source = marked[0]!.source.trim();
  const environment = source.slice(marker.length);
  const environmentBody = environment.slice("\n\n<environment>\n".length, -"\n</environment>".length);
  const nativeEnvironment =
    environment.startsWith("\n\n<environment>\n") &&
    environment.endsWith("\n</environment>") &&
    environmentBody.trim().length > 0 &&
    !/<\/?environment>|\[qm-perf-materialize:/.test(environmentBody);
  workloadCheck(
    body.model === shape.model && source.startsWith(marker) && (environment === "" || nativeEnvironment),
    "Materialization marker/model mismatch",
  );
  const tool = Array.isArray(body.tools) ? body.tools.find((candidate) => candidate?.name === shape.tool) : undefined;
  const properties = tool?.input_schema?.properties;
  workloadCheck(
    properties?.command?.type === "string" &&
      properties?.purpose?.type === "string" &&
      properties?.credentials?.type === "array" &&
      properties?.credentials?.items?.type === "string" &&
      (shape.tool !== "sandbox" || properties?.action?.enum?.includes("exec")),
    "Installed native credential execution schema required",
  );
  const toolId = `toolu_qm_materialize_${shape.runId.replaceAll("-", "")}`;
  const input = materializeInput(shape);
  const suffix = messages.slice(marked[0]!.index + 1);
  if (suffix.length === 0)
    return {
      rule: "materialize-command",
      text: JSON.stringify(input),
      tool: { id: toolId, name: shape.tool, input },
    };
  workloadCheck(
    suffix.length === 2 && suffix[0]?.role === "assistant" && suffix[1]?.role === "user",
    "One materialization tool continuation required",
  );
  const calls = suffix[0].content;
  const results = suffix[1].content;
  workloadCheck(
    Array.isArray(calls) && calls.length === 1 && Array.isArray(results) && results.length === 1,
    "One exact tool call/result required",
  );
  const call = calls[0],
    result = results[0];
  workloadCheck(
    call?.type === "tool_use" &&
      call.id === toolId &&
      call.name === shape.tool &&
      JSON.stringify(call.input) === JSON.stringify(input),
    "Materialization tool call mismatch",
  );
  workloadCheck(
    result?.type === "tool_result" && result.tool_use_id === toolId && result.is_error !== true,
    "Successful materialization tool result required",
  );
  workloadCheck(
    text(result.content).trim() === `${materializeSentinel(shape.runId)}\n\n[exit 0]`,
    "Materialization command did not return exact success proof",
  );
  return { rule: "materialize-complete", text: `QM_PERF_MATERIALIZATION_COMPLETE_${shape.runId}` };
}
