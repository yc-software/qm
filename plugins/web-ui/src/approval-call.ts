import type { PendingApproval } from "./core-bridge.ts";

const SHORT_TEXT = 64;
const MAX_DEPTH = 4;

export type ArgNode =
  | { kind: "scalar"; text: string; literal: boolean }
  | { kind: "text"; text: string }
  | { kind: "list"; items: ArgNode[] }
  | { kind: "record"; view: ArgView; inline: boolean };

export interface ArgField {
  key: string;
  full: string;
  path: string[];
  label: string;
  node: ArgNode;
}

export interface ArgView {
  fields: ArgField[];
  empty: string[];
}

export interface ApprovalCall {
  tool: string;
  via: string | null;
  args: Record<string, unknown>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function unwrapCatalog(tool: string, input: Record<string, unknown>): ApprovalCall {
  const keys = Object.keys(input);
  if (
    typeof input.tool === "string" &&
    isRecord(input.arguments) &&
    keys.every((k) => k === "operation" || k === "tool" || k === "arguments")
  )
    return { tool: input.tool, via: tool, args: input.arguments };
  return { tool, via: null, args: input };
}

export function approvalCall(a: Pick<PendingApproval, "call">): ApprovalCall | null {
  return a.call && isRecord(a.call.input) ? unwrapCatalog(a.call.tool, a.call.input) : null;
}

function keyLabel(key: string): string {
  return key.replaceAll("_", " ").replaceAll("-", " ").trim();
}

function scalarText(value: unknown): { text: string; literal: boolean } {
  if (typeof value === "string") return { text: value, literal: false };
  if (value === null || value === undefined) return { text: "null", literal: true };
  return { text: String(value), literal: true };
}

function isScalar(value: unknown): boolean {
  return value === null || value === undefined || typeof value !== "object";
}

function isEmpty(value: unknown): boolean {
  if (value === null || value === undefined || value === "") return true;
  if (Array.isArray(value)) return value.length === 0;
  return isRecord(value) && Object.keys(value).length === 0;
}

function argNode(value: unknown, depth = 0): ArgNode {
  if (isScalar(value)) {
    const { text, literal } = scalarText(value);
    return !literal && (text.length > SHORT_TEXT || text.includes("\n"))
      ? { kind: "text", text }
      : { kind: "scalar", text, literal };
  }
  if (depth >= MAX_DEPTH) return { kind: "text", text: JSON.stringify(value, null, 2) };
  if (Array.isArray(value)) {
    if (value.every(isScalar)) {
      const joined = value.map((v) => scalarText(v).text).join(", ");
      if (joined.length <= SHORT_TEXT && !joined.includes("\n"))
        return { kind: "scalar", text: joined, literal: false };
    }
    return { kind: "list", items: value.map((v) => argNode(v, depth + 1)) };
  }
  const view = argView(value as Record<string, unknown>, depth + 1);
  const width = view.fields.reduce(
    (n, f) => n + f.label.length + (f.node.kind === "scalar" ? f.node.text.length : 99),
    0,
  );
  return { kind: "record", view, inline: view.fields.every((f) => f.node.kind === "scalar") && width <= 72 };
}

const NODE_ORDER: Record<ArgNode["kind"], number> = { scalar: 0, record: 1, list: 2, text: 3 };

export function argView(args: Record<string, unknown>, depth = 0): ArgView {
  const fields: ArgField[] = [];
  const empty: string[] = [];
  const walk = (obj: Record<string, unknown>, path: string[], level: number): void => {
    for (const [key, value] of Object.entries(obj)) {
      if (isEmpty(value)) empty.push([...path, key].map(keyLabel).join(" "));
      else if (isRecord(value) && level < MAX_DEPTH) walk(value, [...path, key], level + 1);
      else {
        const segments = [...path, key].map(keyLabel);
        fields.push({
          key,
          full: segments.join(" › "),
          path: path.map(keyLabel),
          label: keyLabel(key),
          node: argNode(value, level),
        });
      }
    }
  };
  walk(args, [], depth);
  const seen = new Map<string, number>();
  for (const f of fields) seen.set(f.label, (seen.get(f.label) ?? 0) + 1);
  for (const f of fields) if (seen.get(f.label) === 1) f.path = [];
  fields.sort((a, b) => NODE_ORDER[a.node.kind] - NODE_ORDER[b.node.kind]);
  return { fields, empty };
}

function toolWords(call: ApprovalCall): string {
  const words = keyLabel(call.tool);
  return words.charAt(0).toUpperCase() + words.slice(1);
}

export function approvalHeading(a: PendingApproval, call: ApprovalCall | null): string {
  const summary = a.summary?.trim();
  if (a.purpose?.trim()) return a.purpose.trim();
  if (summary && summary !== a.call?.tool) return summary;
  if (call) return toolWords(call);
  return summary || "Run a command";
}

type Leaf = { path: string[]; value: unknown };

function leaves(value: Record<string, unknown>, path: string[] = []): Leaf[] {
  return Object.entries(value).flatMap(([key, v]) =>
    isRecord(v) && Object.keys(v).length ? leaves(v, [...path, key]) : [{ path: [...path, key], value: v }],
  );
}

function rebuild(entries: Leaf[]): Record<string, unknown> {
  const root: Record<string, unknown> = {};
  for (const { path, value } of entries) {
    let at = root;
    for (const key of path.slice(0, -1)) at = (at[key] ??= {}) as Record<string, unknown>;
    at[path[path.length - 1]!] = value;
  }
  return root;
}

const pathKey = (path: string[]): string => JSON.stringify(path);
const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);

export interface ApprovalBatch {
  call: ApprovalCall;
  differing: ArgView[];
}

export function approvalBatch(approvals: PendingApproval[]): ApprovalBatch | null {
  if (approvals.length < 2) return null;
  const calls = approvals.map(approvalCall);
  const first = calls[0];
  if (!first || calls.some((c) => !c || c.tool !== first.tool || c.via !== first.via)) return null;
  const flat = calls.map((c) => leaves(c!.args));
  const byPath = flat.map((list) => new Map(list.map((leaf) => [pathKey(leaf.path), leaf.value])));
  const allPaths = new Set(flat.flatMap((list) => list.map((leaf) => pathKey(leaf.path))));
  const differing = new Set<string>();
  for (const key of allPaths.keys()) {
    const value = byPath[0]!.get(key);
    if (!byPath.every((m) => m.has(key) && same(m.get(key), value))) differing.add(key);
  }
  return {
    call: first,
    differing: flat.map((list) => argView(rebuild(list.filter((leaf) => differing.has(pathKey(leaf.path)))))),
  };
}
