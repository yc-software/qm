import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { JUNK_FILE, deploymentLayerBundle } from "./deployment-layer.ts";
import { errMessage } from "./log.ts";

export type ApprovalDecision = "require_approval" | "deny";

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

const isStringArray = (v: unknown): v is string[] => Array.isArray(v) && v.every((x) => typeof x === "string");

const BUILT_IN_CREDENTIAL_PATHS: readonly ToolCredentialPath[] = [
  { path: ".aws", kind: "directory" },
  { path: ".config/gh", kind: "directory" },
  { path: ".config/glab", kind: "directory" },
  { path: ".config/gcloud", kind: "directory" },
  { path: ".ssh", kind: "directory" },
  { path: ".netrc", kind: "file" },
  { path: ".git-credentials", kind: "file" },
] as const;

const nested = (a: string, b: string): boolean => a.startsWith(`${b}/`);

export interface ToolApproval {
  command?: string;
  pattern?: string;
  decision?: ApprovalDecision;
  reason?: string;
}

export interface ToolAuthDescriptor {
  check: string;
  reauth: string;
  credentialPaths?: ToolCredentialPath[];
  splitEnv?: Record<string, string>;
  broker?: ToolCredentialBroker;
}

interface ToolCredentialBroker {
  kind: "aws-role";
  roleArnEnv: string;
  regionEnv?: string;
  region?: string;
  sessionActions: string[];
}

export interface ToolCredentialPath {
  path: string;
  kind: "file" | "directory";
}

export interface ToolDescriptor {
  id: string;
  label?: string;
  advertise?: string;
  hints?: string[];
  egress?: string[];
  auth?: ToolAuthDescriptor;
  approvals?: ToolApproval[];
  install?: { binary?: string };
}

export function parseToolDescriptor(raw: string, sourcePath: string): ToolDescriptor {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`${sourcePath} is not valid JSON: ${errMessage(err)}`, { cause: err });
  }
  if (!isPlainObject(parsed)) {
    throw new Error(`${sourcePath} must be a JSON object`);
  }
  const d = parsed;
  if (typeof d["id"] !== "string" || !d["id"].trim()) {
    throw new Error(`${sourcePath}: "id" is required and must be a non-empty string`);
  }
  if (!TOOL_ID_RE.test(d["id"])) {
    throw new Error(
      `${sourcePath}: "id" must match ${TOOL_ID_RE.source} (lowercase alphanumerics and hyphens) — it is interpolated into shell probes`,
    );
  }
  const id = d["id"];
  const out: ToolDescriptor = { id };

  for (const key of ["label", "advertise"] as const) {
    if (d[key] !== undefined) {
      if (typeof d[key] !== "string") throw new Error(`${sourcePath}: "${key}" must be a string`);
      out[key] = d[key] as string;
    }
  }

  if (d["hints"] !== undefined) {
    if (!isStringArray(d["hints"])) throw new Error(`${sourcePath}: "hints" must be an array of strings`);
    out.hints = d["hints"];
  }

  if (d["egress"] !== undefined) {
    if (!isStringArray(d["egress"])) {
      throw new Error(`${sourcePath}: "egress" must be an array of host strings`);
    }
    out.egress = d["egress"];
  }

  if (d["auth"] !== undefined) out.auth = parseAuth(d["auth"], sourcePath);
  if (d["approvals"] !== undefined) out.approvals = parseApprovals(d["approvals"], sourcePath);

  if (d["install"] !== undefined) {
    const inst = d["install"];
    if (!isPlainObject(inst)) {
      throw new Error(`${sourcePath}: "install" must be an object`);
    }
    const binary = inst["binary"];
    if (binary !== undefined && typeof binary !== "string") {
      throw new Error(`${sourcePath}: "install.binary" must be a string`);
    }
    if (binary !== undefined && !TOOL_ID_RE.test(binary)) {
      throw new Error(
        `${sourcePath}: "install.binary" must match ${TOOL_ID_RE.source} (lowercase alphanumerics and hyphens) — it is interpolated into generated Dockerfile lines`,
      );
    }
    out.install = binary !== undefined ? { binary } : {};
  }

  const credentialPaths = out.auth?.credentialPaths ?? [];
  for (const [index, credentialPath] of credentialPaths.entries()) {
    const { path, kind } = credentialPath;
    const segments = path.split("/");
    if (
      !path ||
      path.startsWith("/") ||
      path.startsWith("~") ||
      path.includes("\\") ||
      /\s/.test(path) ||
      segments.includes("..") ||
      segments.includes(".") ||
      segments.includes("")
    ) {
      throw new Error(
        `${sourcePath}: credential path ${JSON.stringify(path)} must be a $HOME-relative path with no traversal`,
      );
    }
    if (!segments[0]!.startsWith(".")) {
      throw new Error(
        `${sourcePath}: credential path ${JSON.stringify(path)} must start with a dotfile or dot-directory segment — non-hidden $HOME paths are durable agent data, not credentials`,
      );
    }
    const builtIn = BUILT_IN_CREDENTIAL_PATHS.find(
      (base) => path === base.path || nested(path, base.path) || nested(base.path, path),
    );
    if (builtIn && (path !== builtIn.path || kind !== builtIn.kind)) {
      throw new Error(
        `${sourcePath}: credential path ${JSON.stringify(path)} (${kind}) overlaps the built-in credential path ${JSON.stringify(builtIn.path)} (${builtIn.kind}) — declare the exact built-in path with its correct kind or a disjoint one`,
      );
    }
    const other = credentialPaths.find(
      (entry, otherIndex) =>
        otherIndex !== index && (path === entry.path || nested(path, entry.path) || nested(entry.path, path)),
    );
    if (other) {
      throw new Error(
        `${sourcePath}: credential paths ${JSON.stringify(path)} and ${JSON.stringify(other.path)} overlap — declare disjoint paths`,
      );
    }
  }
  const binary = out.install?.binary ?? out.id;
  if (out.auth?.broker && !POSIX_FUNCTION_NAME_RE.test(binary)) {
    throw new Error(
      `${sourcePath}: a brokered tool's binary ${JSON.stringify(binary)} must match ${POSIX_FUNCTION_NAME_RE.source} — vended credentials wrap it in a shell function, and not every sandbox shell accepts hyphenated function names`,
    );
  }
  for (const [i, approval] of (out.approvals ?? []).entries()) {
    const compiled = compileApproval(binary, approval);
    try {
      new RegExp(compiled.pattern, "i");
    } catch (e) {
      throw new Error(`${sourcePath}: approvals[${i}] is not a valid regex: ${errMessage(e)}`, { cause: e });
    }
    if (compiled.pattern.length > MAX_APPROVAL_PATTERN_LEN) {
      throw new Error(`${sourcePath}: approvals[${i}] pattern is too long (max ${MAX_APPROVAL_PATTERN_LEN} chars)`);
    }
    if (approvalPatternTooSlow(compiled.pattern)) {
      throw new Error(
        `${sourcePath}: approvals[${i}] pattern is too slow to evaluate — it may cause catastrophic backtracking`,
      );
    }
    if (approval.pattern !== undefined && !rawApprovalTargetsTool(binary, approval.pattern)) {
      throw new Error(
        `${sourcePath}: approvals[${i}].pattern must refer to its own tool binary by starting with \\b${binary}\\b and may not use a top-level alternative`,
      );
    }
  }

  return out;
}

function parseAuth(raw: unknown, sourcePath: string): ToolAuthDescriptor {
  if (!isPlainObject(raw)) {
    throw new Error(`${sourcePath}: "auth" must be an object`);
  }
  const a = raw;
  for (const key of ["check", "reauth"] as const) {
    if (typeof a[key] !== "string" || !(a[key] as string).trim()) {
      throw new Error(`${sourcePath}: "auth.${key}" is required and must be a non-empty string`);
    }
  }
  const out: ToolAuthDescriptor = { check: a["check"] as string, reauth: a["reauth"] as string };
  if (a["credentialPaths"] !== undefined) {
    if (!Array.isArray(a["credentialPaths"])) {
      throw new Error(`${sourcePath}: "auth.credentialPaths" must be an array of { path, kind } objects`);
    }
    out.credentialPaths = a["credentialPaths"].map((entry, index) => {
      if (!isPlainObject(entry)) {
        throw new Error(`${sourcePath}: "auth.credentialPaths[${index}]" must be an object`);
      }
      if (typeof entry.path !== "string" || (entry.kind !== "file" && entry.kind !== "directory")) {
        throw new Error(
          `${sourcePath}: "auth.credentialPaths[${index}]" requires string path and kind file or directory`,
        );
      }
      return { path: entry.path, kind: entry.kind };
    });
  }
  if (a["splitEnv"] !== undefined) {
    const se = a["splitEnv"];
    if (!isPlainObject(se)) {
      throw new Error(`${sourcePath}: "auth.splitEnv" must be an object of string values`);
    }
    const map: Record<string, string> = {};
    for (const [k, v] of Object.entries(se)) {
      if (!SPLIT_ENV_KEY_RE.test(k)) {
        throw new Error(
          `${sourcePath}: "auth.splitEnv" key ${JSON.stringify(k)} must match ${SPLIT_ENV_KEY_RE.source}`,
        );
      }
      if (typeof v !== "string") throw new Error(`${sourcePath}: "auth.splitEnv.${k}" must be a string`);
      if (/[{}]/.test(v.replaceAll("{actingSlackUserId}", ""))) {
        throw new Error(`${sourcePath}: "auth.splitEnv.${k}" may only use the {actingSlackUserId} placeholder`);
      }
      map[k] = v;
    }
    out.splitEnv = map;
  }
  if (a["broker"] !== undefined) out.broker = parseBroker(a["broker"], sourcePath);
  return out;
}

function parseBroker(raw: unknown, sourcePath: string): ToolCredentialBroker {
  if (!isPlainObject(raw)) {
    throw new Error(`${sourcePath}: "auth.broker" must be an object`);
  }
  const b = raw;
  if (b["kind"] !== "aws-role") throw new Error(`${sourcePath}: "auth.broker.kind" must be "aws-role"`);
  if (typeof b["roleArnEnv"] !== "string" || !SPLIT_ENV_KEY_RE.test(b["roleArnEnv"])) {
    throw new Error(`${sourcePath}: "auth.broker.roleArnEnv" is required and must match ${SPLIT_ENV_KEY_RE.source}`);
  }
  const out: ToolCredentialBroker = { kind: "aws-role", roleArnEnv: b["roleArnEnv"], sessionActions: [] };
  if (b["regionEnv"] !== undefined) {
    if (typeof b["regionEnv"] !== "string" || !SPLIT_ENV_KEY_RE.test(b["regionEnv"])) {
      throw new Error(`${sourcePath}: "auth.broker.regionEnv" must match ${SPLIT_ENV_KEY_RE.source}`);
    }
    out.regionEnv = b["regionEnv"];
  }
  if (b["region"] !== undefined) {
    if (typeof b["region"] !== "string" || !b["region"].trim()) {
      throw new Error(`${sourcePath}: "auth.broker.region" must be a non-empty string`);
    }
    out.region = b["region"];
  }
  if (out.region === undefined && out.regionEnv === undefined) {
    throw new Error(
      `${sourcePath}: "auth.broker" needs "region" or "regionEnv" — the vended credentials carry a region`,
    );
  }
  const actions = b["sessionActions"];
  if (
    !Array.isArray(actions) ||
    actions.length === 0 ||
    actions.some((entry) => typeof entry !== "string" || !entry.trim())
  ) {
    throw new Error(`${sourcePath}: "auth.broker.sessionActions" must be a non-empty array of IAM action strings`);
  }
  out.sessionActions = actions as string[];
  return out;
}

function parseApprovals(raw: unknown, sourcePath: string): ToolApproval[] {
  if (!Array.isArray(raw)) throw new Error(`${sourcePath}: "approvals" must be an array`);
  return raw.map((entry, i) => {
    if (!isPlainObject(entry)) {
      throw new Error(`${sourcePath}: approvals[${i}] must be an object`);
    }
    const e = entry;
    const hasCommand = typeof e["command"] === "string" && (e["command"] as string).trim() !== "";
    const hasPattern = typeof e["pattern"] === "string" && (e["pattern"] as string).trim() !== "";
    if (!hasCommand && !hasPattern) {
      throw new Error(`${sourcePath}: approvals[${i}] needs a "command" or a "pattern"`);
    }
    if (hasCommand && hasPattern) {
      throw new Error(`${sourcePath}: approvals[${i}] has both "command" and "pattern" — use one`);
    }
    const out: ToolApproval = {};
    if (hasCommand) out.command = e["command"] as string;
    if (hasPattern) out.pattern = e["pattern"] as string;
    if (e["decision"] !== undefined) {
      const dec = e["decision"];
      if (dec !== "require_approval" && dec !== "deny") {
        throw new Error(`${sourcePath}: approvals[${i}].decision must be require_approval or deny`);
      }
      out.decision = dec;
    }
    if (e["reason"] !== undefined) {
      if (typeof e["reason"] !== "string") throw new Error(`${sourcePath}: approvals[${i}].reason must be a string`);
      out.reason = e["reason"];
    }
    return out;
  });
}

const TOOL_ID_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;
const SPLIT_ENV_KEY_RE = /^[A-Z][A-Z0-9_]*$/;
const POSIX_FUNCTION_NAME_RE = /^[a-z_][a-z0-9_]*$/;

const MAX_APPROVAL_PATTERN_LEN = 256;
function approvalPatternTooSlow(pattern: string): boolean {
  if (/\\[1-9]|\\k<[^>]+>/.test(pattern)) return true;
  type AtomChars = { ascii: Set<number>; asciiOnly: boolean };
  const unknownChars = (): AtomChars => ({
    ascii: new Set(Array.from({ length: 128 }, (_, i) => i)),
    asciiOnly: false,
  });
  const atomChars = (source: string): AtomChars => {
    let atom: RegExp;
    try {
      atom = new RegExp(`^(?:${source})$`, "i");
    } catch {
      return unknownChars();
    }
    const ascii = new Set<number>();
    for (let code = 0; code < 128; code++) if (atom.test(String.fromCharCode(code))) ascii.add(code);
    const asciiOnly =
      (source.length === 1 && source.charCodeAt(0) < 128 && source !== ".") ||
      /^\\(?:[dw]|x[0-7][0-9a-f]|u00[0-7][0-9a-f])$/i.test(source) ||
      /^\[(?!\^)(?:[^\\\]]|\\(?:[dw]|x[0-7][0-9a-f]|u00[0-7][0-9a-f]))+\]$/i.test(source);
    return { ascii, asciiOnly };
  };
  const overlaps = (left: AtomChars | undefined, right: AtomChars | undefined): boolean => {
    if (!left || !right) return false;
    for (const code of left.ascii) if (right.ascii.has(code)) return true;
    return !left.asciiOnly && !right.asciiOnly;
  };
  const splitAlternatives = (source: string): string[] => {
    const branches: string[] = [];
    let start = 0;
    let depth = 0;
    let inClass = false;
    for (let i = 0; i < source.length; i++) {
      const char = source[i]!;
      if (char === "\\") {
        i++;
        continue;
      }
      if (char === "[") inClass = true;
      else if (char === "]" && inClass) inClass = false;
      else if (!inClass && char === "(") depth++;
      else if (!inClass && char === ")") depth--;
      else if (!inClass && depth === 0 && char === "|") {
        branches.push(source.slice(start, i));
        start = i + 1;
      }
    }
    branches.push(source.slice(start));
    return branches;
  };
  const branchShape = (branch: string): { domains: AtomChars[]; nullable: boolean } => {
    const domains: AtomChars[] = [];
    let nullable = true;
    for (let i = 0; i < branch.length; i++) {
      const char = branch[i]!;
      if (char === "^" || char === "$") continue;
      let end = i + 1;
      let domain: AtomChars;
      if (char === "\\") {
        if (branch[i + 1] === "b" || branch[i + 1] === "B") {
          i++;
          continue;
        }
        end = i + 2;
        if (branch[i + 1] === "x" && /^[0-9a-f]{2}$/i.test(branch.slice(i + 2, i + 4))) end = i + 4;
        else if (branch[i + 1] === "u" && /^[0-9a-f]{4}$/i.test(branch.slice(i + 2, i + 6))) end = i + 6;
        domain = atomChars(branch.slice(i, end));
      } else if (char === "[") {
        end = i + 1;
        for (; end < branch.length; end++) {
          if (branch[end] === "\\") end++;
          else if (branch[end] === "]") {
            end++;
            break;
          }
        }
        domain = atomChars(branch.slice(i, end));
      } else if (char === "(" || char === "*" || char === "+" || char === "?" || char === "{") {
        return { domains: domains.length ? domains : [unknownChars()], nullable: true };
      } else {
        domain = atomChars(char);
      }
      domains.push(domain);
      const quantifier = /^(?:[*+?]|\{\d+(?:,\d*)?\})\??/.exec(branch.slice(end))?.[0];
      if (quantifier) {
        if (quantifier === "+" || /^\{[1-9]/.test(quantifier)) nullable = false;
        end += quantifier.length;
      } else nullable = false;
      i = end - 1;
    }
    return domains.length ? { domains, nullable } : { domains: [unknownChars()], nullable: true };
  };
  const prefixAmbiguous = (left: ReturnType<typeof branchShape>, right: ReturnType<typeof branchShape>): boolean => {
    if (left.nullable || right.nullable) return true;
    const length = Math.min(left.domains.length, right.domains.length);
    for (let i = 0; i < length; i++) if (!overlaps(left.domains[i], right.domains[i])) return false;
    return true;
  };
  const alternativeFactor = (source: string): number => {
    const branches = splitAlternatives(source).map(branchShape);
    let overlapsCount = 0;
    for (let i = 0; i < branches.length; i++) {
      for (let j = i + 1; j < branches.length; j++) if (prefixAmbiguous(branches[i]!, branches[j]!)) overlapsCount++;
    }
    return 1 + overlapsCount;
  };
  let ambiguityBudget = 1;
  const stack: Array<{
    start: number;
    bodyStart: number;
    hasQuantifier: boolean;
    hasAlternative: boolean;
    directAlternative: boolean;
    assertion: boolean;
    branchStart: boolean;
    startsQuantified?: AtomChars;
    endsQuantified?: AtomChars;
    lastQuantified?: AtomChars;
    firstChars?: AtomChars;
    lastChars?: AtomChars;
    hasAtom: boolean;
  }> = [
    {
      start: -1,
      bodyStart: 0,
      hasQuantifier: false,
      hasAlternative: false,
      directAlternative: false,
      assertion: false,
      branchStart: true,
      hasAtom: false,
    },
  ];
  const quantifierEnd = (at: number): number | undefined => {
    if (pattern[at] === "*" || pattern[at] === "+" || pattern[at] === "?")
      return at + 1 + (pattern[at + 1] === "?" ? 1 : 0);
    if (pattern[at] !== "{") return undefined;
    const match = /^\{\d+(?:,\d*)?\}/.exec(pattern.slice(at));
    if (!match) return undefined;
    const end = at + match[0].length;
    return end + (pattern[end] === "?" ? 1 : 0);
  };
  const markAtom = (quantified: boolean, firstChars: AtomChars, lastChars = firstChars): boolean => {
    const frame = stack.at(-1)!;
    if (quantified && overlaps(frame.lastQuantified, firstChars)) return true;
    if (frame.branchStart) {
      frame.firstChars ??= firstChars;
      if (quantified) frame.startsQuantified ??= firstChars;
    }
    frame.branchStart = false;
    frame.hasAtom = true;
    frame.lastChars = lastChars;
    frame.lastQuantified = quantified ? lastChars : undefined;
    if (quantified) for (const open of stack) open.hasQuantifier = true;
    return false;
  };
  for (let i = 0; i < pattern.length; i++) {
    const char = pattern[i]!;
    if (char === "\\") {
      let end = i + 2;
      if (pattern[i + 1] === "x" && /^[0-9a-f]{2}$/i.test(pattern.slice(i + 2, i + 4))) end = i + 4;
      else if (pattern[i + 1] === "u" && /^[0-9a-f]{4}$/i.test(pattern.slice(i + 2, i + 6))) end = i + 6;
      if (pattern[i + 1] === "b" || pattern[i + 1] === "B") {
        i = end - 1;
        continue;
      }
      const quantifiedEnd = quantifierEnd(end);
      if (markAtom(quantifiedEnd !== undefined, atomChars(pattern.slice(i, end)))) return true;
      i = (quantifiedEnd ?? end) - 1;
      continue;
    }
    if (char === "[") {
      let end = i + 1;
      for (; end < pattern.length; end++) {
        if (pattern[end] === "\\") end++;
        else if (pattern[end] === "]") {
          end++;
          break;
        }
      }
      const quantifiedEnd = quantifierEnd(end);
      if (markAtom(quantifiedEnd !== undefined, atomChars(pattern.slice(i, end)))) return true;
      i = (quantifiedEnd ?? end) - 1;
      continue;
    }
    if (char === "(") {
      let prefixEnd = i + 1;
      let assertion = false;
      if (pattern[prefixEnd] === "?") {
        const kind = pattern[prefixEnd + 1];
        if (kind === ":") prefixEnd += 2;
        else if (kind === "=" || kind === "!") {
          assertion = true;
          prefixEnd += 2;
        } else if (kind === "<" && (pattern[prefixEnd + 2] === "=" || pattern[prefixEnd + 2] === "!")) {
          assertion = true;
          prefixEnd += 3;
        } else if (kind === "<") {
          const close = pattern.indexOf(">", prefixEnd + 2);
          if (close !== -1) prefixEnd = close + 1;
        }
      }
      stack.push({
        start: i,
        bodyStart: prefixEnd,
        hasQuantifier: false,
        hasAlternative: false,
        directAlternative: false,
        assertion,
        branchStart: true,
        hasAtom: false,
      });
      i = prefixEnd - 1;
      continue;
    }
    if (char === "|") {
      for (const group of stack) group.hasAlternative = true;
      const frame = stack.at(-1)!;
      frame.directAlternative = true;
      frame.endsQuantified ??= frame.lastQuantified;
      frame.lastQuantified = undefined;
      frame.branchStart = true;
      continue;
    }
    if (char === ")" && stack.length > 1) {
      const group = stack.pop()!;
      if (group.directAlternative) {
        ambiguityBudget *= alternativeFactor(pattern.slice(group.bodyStart, i));
        if (ambiguityBudget > 1_024) return true;
      }
      group.endsQuantified ??= group.lastQuantified;
      const quantifiedEnd = quantifierEnd(i + 1);
      const quantified = quantifiedEnd !== undefined;
      if (quantified && (group.hasQuantifier || group.hasAlternative)) return true;
      if (!group.assertion) {
        const parent = stack.at(-1)!;
        const firstChars = group.hasAlternative ? unknownChars() : (group.firstChars ?? unknownChars());
        const lastChars = group.hasAlternative ? unknownChars() : (group.lastChars ?? unknownChars());
        if (quantified) {
          if (markAtom(true, firstChars, lastChars)) return true;
        } else if (group.hasAtom) {
          if (overlaps(parent.lastQuantified, group.startsQuantified)) return true;
          if (parent.branchStart) {
            parent.firstChars ??= firstChars;
            parent.startsQuantified ??= group.startsQuantified;
          }
          parent.branchStart = false;
          parent.hasAtom = true;
          parent.lastChars = lastChars;
          parent.lastQuantified = group.endsQuantified;
          parent.hasQuantifier ||= group.hasQuantifier;
          parent.hasAlternative ||= group.hasAlternative;
        }
      }
      i = (quantifiedEnd ?? i + 1) - 1;
      continue;
    }
    if (char === "^" || char === "$" || char === ")") continue;
    const quantifiedEnd = quantifierEnd(i + 1);
    if (markAtom(quantifiedEnd !== undefined, atomChars(char))) return true;
    i = (quantifiedEnd ?? i + 1) - 1;
  }
  return false;
}

const escapeRegex = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

function rawApprovalTargetsTool(binary: string, pattern: string): boolean {
  if (!pattern.startsWith(`\\b${escapeRegex(binary)}\\b`)) return false;
  let depth = 0;
  let inClass = false;
  let escaped = false;
  for (const char of pattern) {
    if (escaped) {
      escaped = false;
      continue;
    }
    if (char === "\\") {
      escaped = true;
      continue;
    }
    if (char === "[" && !inClass) {
      inClass = true;
      continue;
    }
    if (char === "]" && inClass) {
      inClass = false;
      continue;
    }
    if (inClass) continue;
    if (char === "(") depth++;
    else if (char === ")") depth = Math.max(0, depth - 1);
    else if (char === "|" && depth === 0) return false;
  }
  return true;
}

export function compileApproval(binary: string, a: ToolApproval): { pattern: string; decision: ApprovalDecision } {
  const decision: ApprovalDecision = a.decision ?? "require_approval";
  if (a.pattern !== undefined) return { pattern: a.pattern, decision };
  const words = (a.command ?? "").trim().split(/\s+/).filter(Boolean).map(escapeRegex);
  const pattern = `\\b${[escapeRegex(binary), ...words].join("\\s+")}(?:\\b|\\s|$)`;
  return { pattern, decision };
}

type SplitEnvContext = { actingSlackUserId?: string };

export function interpolateSplitEnv(template: Record<string, string>, ctx: SplitEnvContext): Record<string, string> {
  const placeholders: Record<string, string | undefined> = { actingSlackUserId: ctx.actingSlackUserId };
  const out: Record<string, string> = {};
  for (const [key, raw] of Object.entries(template)) {
    let missing = false;
    const value = raw.replace(/\{(\w+)\}/g, (_m, name: string) => {
      const v = Object.hasOwn(placeholders, name) ? placeholders[name] : undefined;
      if (v === undefined) {
        missing = true;
        return "";
      }
      return v;
    });
    if (missing) return {};
    out[key] = value;
  }
  return out;
}

export interface SkillFrontmatter {
  name: string;
  description: string;
  requiredCapabilities?: string[];
}

function stripSkillQuotes(value: string): string {
  const trimmed = value.trim();
  if (
    trimmed.length >= 2 &&
    ((trimmed[0] === '"' && trimmed.at(-1) === '"') || (trimmed[0] === "'" && trimmed.at(-1) === "'"))
  ) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

function skillIndent(line: string): number {
  let indent = 0;
  while (indent < line.length && (line[indent] === " " || line[indent] === "\t")) indent++;
  return indent;
}

export function parseSkillFrontmatter(md: string, sourcePath: string): SkillFrontmatter {
  const source = md.startsWith("\uFEFF") ? md.slice(1) : md;
  const opening = /^---\r?\n/.exec(source);
  const closing = opening ? /\r?\n---/.exec(source.slice(opening[0].length)) : null;
  if (!opening || !closing) throw new Error(`${sourcePath}: missing YAML frontmatter (a leading --- … --- block)`);
  const contentStart = opening[0].length;
  const contentEnd = contentStart + closing.index;
  const body = source.slice(contentEnd + closing[0].length).replace(/^\s+/, "");
  if (!body.trim()) throw new Error(`${sourcePath}: skill requires a body below the frontmatter`);

  const fields: Record<string, unknown> = {};
  const lines = source.slice(contentStart, contentEnd).split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (!line.trim() || line.trimStart().startsWith("#")) continue;
    const kv = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(line);
    if (!kv) continue;
    const key = kv[1]!;
    const rest = kv[2] ?? "";
    if (rest === ">" || rest === "|" || rest === ">-" || rest === "|-") {
      const literal = rest[0] === "|";
      const baseIndent = skillIndent(line);
      const collected: string[] = [];
      while (i + 1 < lines.length) {
        const next = lines[i + 1]!;
        if (next.trim() && skillIndent(next) <= baseIndent) break;
        collected.push(next.trim() ? next.slice(Math.min(skillIndent(next), baseIndent + 2)) : "");
        i++;
      }
      fields[key] = (literal ? collected.join("\n") : collected.join(" ").replace(/\s+/g, " ")).trim();
      continue;
    }
    if (rest) {
      fields[key] =
        rest.startsWith("[") && rest.endsWith("]")
          ? rest.slice(1, -1).split(",").map(stripSkillQuotes).filter(Boolean)
          : stripSkillQuotes(rest);
      continue;
    }
    const baseIndent = skillIndent(line);
    const items: string[] = [];
    while (i + 1 < lines.length) {
      const next = lines[i + 1]!;
      if (!next.trim() || skillIndent(next) <= baseIndent) break;
      const item = /^\s*-\s+(.*)$/.exec(next);
      if (!item) break;
      items.push(stripSkillQuotes(item[1]!));
      i++;
    }
    fields[key] = items;
  }

  const name = fields["name"];
  const description = fields["description"];
  const requiredCapabilities = fields["requiredCapabilities"] ?? [];
  if (typeof name !== "string" || !name.trim()) throw new Error(`${sourcePath}: frontmatter is missing "name"`);
  if (!/^[A-Za-z0-9](?:[A-Za-z0-9_.-]{0,126}[A-Za-z0-9_-])?$/.test(name)) {
    throw new Error(
      `${sourcePath}: skill name must be 1-128 ASCII letters, digits, dots, underscores, or hyphens; it must start with a letter or digit and cannot end with a dot`,
    );
  }
  if (typeof description !== "string" || !description.trim())
    throw new Error(`${sourcePath}: frontmatter is missing "description"`);
  if (
    !Array.isArray(requiredCapabilities) ||
    requiredCapabilities.some((capability) => typeof capability !== "string")
  ) {
    throw new Error(`${sourcePath}: frontmatter "requiredCapabilities" must be a YAML list`);
  }
  const out: SkillFrontmatter = { name, description };
  if (requiredCapabilities.length) out.requiredCapabilities = requiredCapabilities as string[];
  return out;
}

interface ToolEntry {
  dir: string;
  descriptorPath: string;
  descriptor: ToolDescriptor;
  binary: string;
  executablePath?: string;
}

interface SkillEntry {
  dir: string;
  skillPath: string;
  frontmatter: SkillFrontmatter;
}

export interface SandboxValidation {
  exists: boolean;
  hasDockerfile: boolean;
  tools: ToolEntry[];
  skills: SkillEntry[];
  errors: string[];
  warnings: string[];
}

const isFile = (p: string): boolean => {
  try {
    return statSync(p).isFile();
  } catch {
    return false;
  }
};

const subdirs = (dir: string): string[] => {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort();
};

const isCidr = (host: string): boolean =>
  /^\d{1,3}(\.\d{1,3}){3}\/\d{1,2}$/.test(host) || /^[0-9A-Fa-f:]+\/\d{1,3}$/.test(host);

export function validateSandboxLayer(sandboxDir: string): SandboxValidation {
  const out: SandboxValidation = {
    exists: existsSync(sandboxDir),
    hasDockerfile: existsSync(join(sandboxDir, "Dockerfile")),
    tools: [],
    skills: [],
    errors: [],
    warnings: [],
  };

  const toolsDir = join(sandboxDir, "tools");
  const idCounts = new Map<string, number>();
  for (const name of subdirs(toolsDir)) {
    const descriptorPath = join(toolsDir, name, "tool.json");
    if (!existsSync(descriptorPath)) {
      out.errors.push(`tools/${name}/ has no tool.json`);
      continue;
    }
    let descriptor: ToolDescriptor;
    try {
      descriptor = parseToolDescriptor(readFileSync(descriptorPath, "utf8"), `tools/${name}/tool.json`);
    } catch (e) {
      out.errors.push(errMessage(e));
      continue;
    }
    idCounts.set(descriptor.id, (idCounts.get(descriptor.id) ?? 0) + 1);
    for (const { path } of descriptor.auth?.credentialPaths ?? []) {
      if (path === ".ssh" || path.startsWith(".ssh/")) {
        out.warnings.push(
          `tool "${descriptor.id}" captures sensitive credential path ${JSON.stringify(path)}; keep it only if the whole SSH identity is required`,
        );
      }
    }
    for (const host of descriptor.egress ?? []) {
      if (host.includes("*") || host === "0.0.0.0/0" || host === "::/0") {
        out.warnings.push(
          `tool "${descriptor.id}" declares broad egress ${JSON.stringify(host)}; egress is validated-only in contract v1`,
        );
      }
      if (/^[a-z]+:\/\//i.test(host) || (host.includes("/") && !isCidr(host))) {
        out.errors.push(
          `tool "${descriptor.id}" egress ${JSON.stringify(host)} must name a host or a CIDR range, not a URL or path`,
        );
      }
    }
    const binaryName = descriptor.install?.binary ?? descriptor.id;
    const exePath = join(toolsDir, name, binaryName);
    const hasExe = isFile(exePath);
    if (!hasExe && !out.hasDockerfile) {
      out.errors.push(
        `tool "${descriptor.id}" (tools/${name}/) can't get its binary on PATH: ship an executable ` +
          `"${binaryName}" in the folder, or add a sandbox/Dockerfile that installs it`,
      );
    }
    const entry: ToolEntry = { dir: name, descriptorPath, descriptor, binary: binaryName };
    if (hasExe) entry.executablePath = exePath;
    out.tools.push(entry);
  }
  for (const [id, count] of idCounts) {
    if (count > 1) out.errors.push(`duplicate tool id "${id}" (declared by ${count} tool.json files)`);
  }
  const layerLinks = out.tools.flatMap((t) =>
    (t.descriptor.auth?.credentialPaths ?? []).map((entry) => ({ id: t.descriptor.id, ...entry })),
  );
  for (const a of layerLinks) {
    const b = layerLinks.find(
      (other) =>
        other !== a &&
        (a.path === other.path ? a.kind !== other.kind : nested(a.path, other.path) || nested(other.path, a.path)),
    );
    if (b) {
      out.errors.push(
        `tools "${a.id}" and "${b.id}" declare incompatible credential paths ${JSON.stringify(a.path)} and ${JSON.stringify(b.path)} — declare matching kinds for shared paths or disjoint paths`,
      );
    }
  }

  const skillsDir = join(sandboxDir, "skills");
  if (existsSync(skillsDir)) {
    for (const entry of readdirSync(skillsDir, { withFileTypes: true })) {
      if (!entry.isDirectory() && !JUNK_FILE.test(entry.name)) {
        out.errors.push(
          `skills/${entry.name} is not a skill directory; the core only accepts skills/<id>/<file> paths`,
        );
      }
    }
  }
  for (const name of subdirs(skillsDir)) {
    const skillPath = join(skillsDir, name, "SKILL.md");
    if (!existsSync(skillPath)) {
      out.errors.push(`skills/${name}/ has no SKILL.md`);
      continue;
    }
    try {
      const frontmatter = parseSkillFrontmatter(readFileSync(skillPath, "utf8"), `skills/${name}/SKILL.md`);
      out.skills.push({ dir: name, skillPath, frontmatter });
    } catch (e) {
      out.errors.push(errMessage(e));
    }
  }

  if (out.exists && out.errors.length === 0) {
    try {
      const body = JSON.stringify(deploymentLayerBundle(sandboxDir));
      if (Buffer.byteLength(body) > 1_000_000) {
        out.errors.push("deployment layer (skills/ + tool descriptors) exceeds the core API's 1 MB request limit");
      }
    } catch (e) {
      out.errors.push(errMessage(e));
    }
  }

  return out;
}
