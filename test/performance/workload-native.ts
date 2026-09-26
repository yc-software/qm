import { createHash } from "node:crypto";
import { syntheticText, workloadCheck } from "./workload-provider.ts";

export type NativeOperation =
  | { kind: "read"; path: string; bytes: number; sha256: string }
  | { kind: "sandbox"; sandboxId: string; bytes: number; seed: string; sleepMs: number };

export interface NativeShape {
  name: string;
  model: string;
  modelCalls: number;
  toolCalls: number;
  batches: number[];
  operations: NativeOperation[];
  outputBytes: number;
  repeatedFraction: number;
  delayMs: number;
  chunkCharacters: number;
  chunkIntervalMs: number;
  terminal: "reply" | "loop-intake-empty";
}

type Message = { role?: string; content?: unknown };
type Call = { id: string; name: string; input: Record<string, unknown> };
const sha = (text: string) => createHash("sha256").update(text).digest("hex");

function text(content: unknown): string {
  if (typeof content === "string") return content;
  workloadCheck(
    Array.isArray(content) && content.every((block) => block?.type === "text" && typeof block.text === "string"),
    "Native text-only content required",
  );
  return content.map((block) => block.text).join("\n");
}

export function nativeMarker(fixtureId: string, shape: string, nonce: string): string {
  workloadCheck(
    [fixtureId, shape, nonce].every((value) => /^[A-Za-z0-9_.-]+$/.test(value)),
    "Unsafe native marker",
  );
  return `[qm-perf-native:${fixtureId}:${shape}:${nonce}]`;
}

export function nativeSandboxOutput(operation: Extract<NativeOperation, { kind: "sandbox" }>): string {
  let result = "";
  for (let index = 0; result.length < operation.bytes; index++) result += sha(`${operation.seed}:${index}`) + " ";
  return result.slice(0, operation.bytes);
}

export function nativeToolInput(operation: NativeOperation): { name: string; input: Record<string, unknown> } {
  if (operation.kind === "read") return { name: "files", input: { action: "read", path: operation.path } };
  const program = `import hashlib,sys,time; time.sleep(${operation.sleepMs}/1000); s="${operation.seed}"; n=${operation.bytes}; sys.stdout.write("".join(hashlib.sha256((s+":"+str(i)).encode()).hexdigest()+" " for i in range((n+64)//65))[:n]+"\\n")`;
  return {
    name: "sandbox",
    input: {
      action: "exec",
      command: `python3 -c '${program}'`,
      purpose: "Read synthetic fixture",
      sandbox_id: operation.sandboxId,
      timeout_seconds: Math.ceil(operation.sleepMs / 1000) + 10,
    },
  };
}

export function validateNativeShapes(shapes: NativeShape[]): void {
  workloadCheck(Array.isArray(shapes) && shapes.length > 0 && shapes.length <= 2000, "Bounded native shapes required");
  const names = new Set<string>();
  for (const shape of shapes) {
    workloadCheck(/^[A-Za-z0-9_.-]+$/.test(shape.name) && !names.has(shape.name), "Unique native shape name required");
    names.add(shape.name);
    workloadCheck(typeof shape.model === "string" && shape.model.length > 0, "Native model required");
    workloadCheck(
      Number.isSafeInteger(shape.modelCalls) &&
        shape.modelCalls > 0 &&
        shape.modelCalls <= 1000 &&
        Number.isSafeInteger(shape.toolCalls) &&
        shape.toolCalls >= 0 &&
        shape.toolCalls <= 10000,
      "Native call budget exceeds bound",
    );
    workloadCheck(
      shape.batches.length === shape.modelCalls - 1 &&
        shape.batches.every((count) => Number.isSafeInteger(count) && count > 0 && count <= 100) &&
        shape.batches.reduce((sum, count) => sum + count, 0) === shape.toolCalls,
      "Every nonterminal native model call requires its exact nonempty tool batch",
    );
    workloadCheck(shape.operations.length === shape.toolCalls, "Exact native operation budget required");
    for (const operation of shape.operations) {
      workloadCheck(
        Number.isSafeInteger(operation.bytes) && operation.bytes > 0 && operation.bytes <= 100000,
        "Bounded native result bytes required",
      );
      if (operation.kind === "read") {
        workloadCheck(/^shared\/[A-Za-z0-9_.-]+$/.test(operation.path), "Explicit durable shared read required");
        workloadCheck(/^[a-f0-9]{64}$/.test(operation.sha256), "Durable read hash required");
      } else {
        workloadCheck(operation.kind === "sandbox", "Unrecognized native operation");
        workloadCheck(operation.bytes <= 99_990, "Native execution result must fit the installed tool result cap");
        workloadCheck(/^[A-Za-z0-9_.:-]{1,128}$/.test(operation.sandboxId), "Owned sandbox ID required");
        workloadCheck(/^[a-f0-9]{64}$/.test(operation.seed), "Fixed synthetic output seed required");
        workloadCheck(
          Number.isSafeInteger(operation.sleepMs) && operation.sleepMs >= 0 && operation.sleepMs <= 60000,
          "Bounded native sleep required",
        );
      }
    }
    workloadCheck(
      Number.isSafeInteger(shape.outputBytes) && shape.outputBytes > 0 && shape.outputBytes <= 100000,
      "Bounded native text required",
    );
    workloadCheck(
      Number.isFinite(shape.repeatedFraction) && shape.repeatedFraction >= 0 && shape.repeatedFraction <= 1,
      "Native repeated fraction required",
    );
    for (const field of ["delayMs", "chunkIntervalMs"] as const)
      workloadCheck(
        Number.isSafeInteger(shape[field]) && shape[field] >= 0 && shape[field] <= 600000,
        `Invalid native ${field}`,
      );
    workloadCheck(
      Number.isSafeInteger(shape.chunkCharacters) && shape.chunkCharacters > 0 && shape.chunkCharacters <= 100000,
      "Native chunk bound required",
    );
    workloadCheck(["reply", "loop-intake-empty"].includes(shape.terminal), "Fixed native terminal required");
  }
}

function batch(shape: NativeShape, nonce: string, step: number): Call[] {
  const start = shape.batches.slice(0, step).reduce((sum, value) => sum + value, 0);
  return shape.operations.slice(start, start + (shape.batches[step] ?? 0)).map((operation, index) => ({
    id: `toolu_qmn_${sha(nonce).slice(0, 16)}_${step}_${index}`,
    ...nativeToolInput(operation),
  }));
}

function sameInput(actual: unknown, expected: Record<string, unknown>): boolean {
  if (!actual || typeof actual !== "object" || Array.isArray(actual)) return false;
  const input = actual as Record<string, unknown>;
  return (
    Object.keys(input).length === Object.keys(expected).length &&
    Object.entries(expected).every(([key, value]) => input[key] === value)
  );
}

export function nativeReply(body: Record<string, unknown>, fixtureId: string, shapes?: NativeShape[]) {
  workloadCheck(Array.isArray(body.messages) && body.messages.length > 0, "Native messages required");
  const messages = body.messages as Message[];
  let index = messages.length - 1;
  const pairs: Array<{ calls: unknown[]; results: unknown[] }> = [];
  while (index >= 0) {
    const message = messages[index]!;
    if (message.role !== "user") return null;
    if (!Array.isArray(message.content) || !message.content.some((block) => block?.type === "tool_result")) break;
    const previous = messages[index - 1];
    workloadCheck(
      index >= 2 && previous?.role === "assistant" && Array.isArray(previous.content),
      "Native result requires preceding batch",
    );
    pairs.unshift({ calls: previous.content, results: message.content });
    index -= 2;
  }
  if (index < 0) return null;
  const origin = text(messages[index]!.content);
  const matches = [...origin.matchAll(/\[qm-perf-native:([A-Za-z0-9_.-]+):([A-Za-z0-9_.-]+):([A-Za-z0-9_.-]+)\]/g)];
  if (!matches.length) return null;
  workloadCheck(matches.length === 1 && matches[0]![1] === fixtureId, "One matching native fixture marker required");
  const shape = shapes?.find((candidate) => candidate.name === matches[0]![2]);
  workloadCheck(shape && body.model === shape.model && body.stream === true, "Admitted native model/shape required");
  const nonce = matches[0]![3]!;
  workloadCheck(pairs.length < shape.modelCalls, "Native model budget exhausted");
  if (shape.terminal === "loop-intake-empty") {
    workloadCheck(
      (origin.match(/^\[Loop intake\]$/gm) ?? []).length === 1 && origin.includes("[End loop intake]"),
      "Native intake stage required",
    );
    workloadCheck(!/^\[Loop (work|judge)\]$/m.test(origin), "Only native intake admitted");
  }
  let operationIndex = 0;
  pairs.forEach((pair, step) => {
    const expected = batch(shape, nonce, step);
    const calls = pair.calls.filter((value) => (value as { type?: string })?.type === "tool_use") as Array<
      Call & { type: string }
    >;
    workloadCheck(
      calls.length === expected.length &&
        pair.calls.every((value) =>
          ["tool_use", "text", "thinking"].includes(String((value as { type?: string })?.type)),
        ),
      "Native tool batch count mismatch",
    );
    workloadCheck(pair.results.length === expected.length, "Complete native result batch required");
    const seen = new Set<string>();
    for (let position = 0; position < expected.length; position++) {
      const wanted = expected[position]!,
        actual = calls[position]!;
      workloadCheck(
        actual.id === wanted.id && actual.name === wanted.name && sameInput(actual.input, wanted.input),
        "Native tool input/identity mismatch",
      );
      const result = pair.results.find((value) => (value as { tool_use_id?: string })?.tool_use_id === wanted.id) as
        { type?: string; tool_use_id?: string; content?: unknown; is_error?: boolean } | undefined;
      workloadCheck(
        result?.type === "tool_result" && result.is_error !== true && !seen.has(wanted.id),
        "Successful unique native result required",
      );
      seen.add(wanted.id);
      const returned = text(result.content),
        operation = shape.operations[operationIndex++]!;
      if (operation.kind === "read")
        workloadCheck(
          Buffer.byteLength(returned) === operation.bytes && sha(returned) === operation.sha256,
          "Native durable read bytes changed",
        );
      else
        workloadCheck(
          returned === `${nativeSandboxOutput(operation)}\n\n[exit 0]`,
          "Native sandbox output/exit mismatch",
        );
    }
  });
  const step = pairs.length,
    tools = batch(shape, nonce, step);
  for (const call of tools) {
    const definition = Array.isArray(body.tools) ? body.tools.find((value) => value?.name === call.name) : undefined;
    const properties = definition?.input_schema?.properties;
    workloadCheck(
      properties &&
        (call.name === "files"
          ? properties.path?.type === "string"
          : properties.command?.type === "string" && properties.sandbox_id),
      "Installed native tool schema required",
    );
    const action = properties.action;
    workloadCheck(
      action &&
        (action.const === call.input.action ||
          action.enum?.includes(call.input.action) ||
          action.anyOf?.some((item: { const?: string }) => item.const === call.input.action)),
      "Installed native action required",
    );
  }
  const final =
    shape.terminal === "loop-intake-empty"
      ? '{"items":[]}'
      : syntheticText(`${nonce}:final`, shape.outputBytes, shape.repeatedFraction);
  return {
    rule: `native:${shape.name}:${step}`,
    text: tools.length ? syntheticText(`${nonce}:${step}`, shape.outputBytes, shape.repeatedFraction) : final,
    tools,
    native: {
      shape: shape.name,
      nonce,
      step,
      modelCalls: shape.modelCalls,
      toolCalls: tools.length,
      terminal: tools.length === 0,
    },
    pacing: shape,
  };
}
