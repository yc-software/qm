import type { PendingApproval } from "./core-bridge.ts";

export const BOILERPLATE_APPROVAL_REASON = "this tool asks for approval before each call";

const SHORT_TEXT = 64;
const MAX_DEPTH = 4;

export type ArgNode =
  | { kind: "scalar"; text: string; literal: boolean; ident: boolean }
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

export function approvalCall(a: Pick<PendingApproval, "call" | "command">): ApprovalCall | null {
  if (a.call && isRecord(a.call.input)) return unwrapCatalog(a.call.tool, a.call.input);
  const brace = a.command.indexOf("{");
  const label = brace > 0 ? a.command.slice(0, brace).trim() : "";
  if (!label || /\s/.test(label)) return null;
  try {
    const parsed: unknown = JSON.parse(a.command.slice(brace));
    return isRecord(parsed) ? unwrapCatalog(label, parsed) : null;
  } catch {
    return null;
  }
}

export function keyLabel(key: string): string {
  return key
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[_\-.]+/g, " ")
    .trim()
    .toLowerCase();
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

const looksLikeIdentifier = (text: string): boolean =>
  /^\S{3,}$/.test(text) && /[A-Za-z]/.test(text) && /[\d._:/@-]/.test(text);

function scalarNode(text: string, literal: boolean): ArgNode {
  return { kind: "scalar", text, literal, ident: !literal && looksLikeIdentifier(text) };
}

export function argNode(value: unknown, depth = 0): ArgNode {
  if (isScalar(value)) {
    const { text, literal } = scalarText(value);
    return !literal && (text.length > SHORT_TEXT || text.includes("\n"))
      ? { kind: "text", text }
      : scalarNode(text, literal);
  }
  if (depth >= MAX_DEPTH) return { kind: "text", text: JSON.stringify(value, null, 2) };
  if (Array.isArray(value)) {
    if (value.every(isScalar)) {
      const joined = value.map((v) => scalarText(v).text).join(", ");
      if (joined.length <= SHORT_TEXT && !joined.includes("\n")) return scalarNode(joined, false);
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

export function toolWords(call: ApprovalCall): string {
  const words = keyLabel(call.tool);
  return words.charAt(0).toUpperCase() + words.slice(1);
}

export function approvalHeading(a: PendingApproval, call: ApprovalCall | null): string {
  if (a.purpose?.trim()) return a.purpose.trim();
  if (call) return toolWords(call);
  return a.summary?.trim() || "Run a command";
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

export interface BatchRow {
  approval: PendingApproval;
  heading: string;
  view: ArgView;
}

export interface ApprovalBatch {
  call: ApprovalCall;
  shared: ArgView;
  rows: BatchRow[];
}

export function approvalBatch(approvals: PendingApproval[]): ApprovalBatch | null {
  if (approvals.length < 2) return null;
  const calls = approvals.map(approvalCall);
  const first = calls[0];
  if (!first || calls.some((c) => !c || c.tool !== first.tool || c.via !== first.via)) return null;
  const flat = calls.map((c) => leaves(c!.args));
  const byPath = flat.map((list) => new Map(list.map((leaf) => [pathKey(leaf.path), leaf.value])));
  const allPaths = new Map<string, string[]>();
  for (const list of flat) for (const leaf of list) allPaths.set(pathKey(leaf.path), leaf.path);
  const shared: Leaf[] = [];
  const differing = new Set<string>();
  for (const [key, path] of allPaths) {
    const present = byPath.every((m) => m.has(key));
    const value = byPath[0]!.get(key);
    if (present && byPath.every((m) => same(m.get(key), value))) shared.push({ path, value });
    else differing.add(key);
  }
  return {
    call: first,
    shared: argView(rebuild(shared)),
    rows: approvals.map((approval, i) => ({
      approval,
      heading: approvalHeading(approval, calls[i]!),
      view: argView(rebuild(flat[i]!.filter((leaf) => differing.has(pathKey(leaf.path))))),
    })),
  };
}

export function realApprovalReason(reason: string | undefined): string | undefined {
  return reason && reason !== BOILERPLATE_APPROVAL_REASON ? reason : undefined;
}

export interface Segment {
  text: string;
  changed: boolean;
}

export function wordDiff(text: string, against: string): Segment[] {
  const tokens = (t: string): string[] => t.split(/(\s+|[.,;:!?()"“”‘’—–-])/).filter(Boolean);
  const a = tokens(text);
  const b = tokens(against);
  if (a.length * b.length > 200_000) return [{ text, changed: false }];
  const lcs: number[][] = Array.from({ length: a.length + 1 }, () => new Array<number>(b.length + 1).fill(0));
  for (let i = a.length - 1; i >= 0; i--)
    for (let j = b.length - 1; j >= 0; j--)
      lcs[i]![j] = a[i] === b[j] ? lcs[i + 1]![j + 1]! + 1 : Math.max(lcs[i + 1]![j]!, lcs[i]![j + 1]!);
  const out: Segment[] = [];
  const push = (t: string, changed: boolean): void => {
    const last = out[out.length - 1];
    if (last && last.changed === changed) last.text += t;
    else out.push({ text: t, changed });
  };
  let i = 0;
  let j = 0;
  while (i < a.length) {
    const token = a[i]!;
    if (j < b.length && token === b[j]) {
      push(token, false);
      i++;
      j++;
    } else if (j < b.length && lcs[i]![j + 1]! >= lcs[i + 1]![j]!) j++;
    else {
      push(token, !/^\s*$/.test(token));
      i++;
    }
  }
  for (let k = out.length - 2; k > 0; k--)
    if (!out[k]!.changed && /^\s+$/.test(out[k]!.text) && out[k - 1]!.changed && out[k + 1]!.changed) {
      out[k - 1]!.text += out[k]!.text + out[k + 1]!.text;
      out.splice(k, 2);
    }
  return out;
}
