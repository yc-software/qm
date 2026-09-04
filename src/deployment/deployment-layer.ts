export type ApprovalDecision = "require_approval" | "deny";

export interface ToolApproval {
  command?: string;
  pattern?: string;
  decision?: ApprovalDecision;
  reason?: string;
}

interface ToolAuthDescriptor {
  check: string;
  reauth: string;
  credentialPaths?: ToolCredentialPath[];
  splitEnv?: Record<string, string>;
  broker?: ToolCredentialBroker;
}

export interface ToolCredentialBroker {
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

export function parseToolDescriptor(raw: string, sourcePath: string): ToolDescriptor {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`${sourcePath} is not valid JSON: ${(err as Error).message}`, { cause: err });
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`${sourcePath} must be a JSON object`);
  }
  const d = parsed as Record<string, unknown>;
  if (typeof d["id"] !== "string" || !d["id"].trim()) {
    throw new Error(`${sourcePath}: "id" is required and must be a non-empty string`);
  }
  if (!TOOL_ID_RE.test(d["id"])) {
    throw new Error(
      `${sourcePath}: "id" must match ${TOOL_ID_RE.source} (lowercase alphanumerics and hyphens) — it is interpolated into shell probes`,
    );
  }
  const out: ToolDescriptor = { id: d["id"] };

  for (const key of ["label", "advertise"] as const) {
    if (d[key] !== undefined) {
      if (typeof d[key] !== "string") throw new Error(`${sourcePath}: "${key}" must be a string`);
      out[key] = d[key] as string;
    }
  }

  if (d["hints"] !== undefined) {
    if (!Array.isArray(d["hints"]) || d["hints"].some((h) => typeof h !== "string")) {
      throw new Error(`${sourcePath}: "hints" must be an array of strings`);
    }
    out.hints = d["hints"] as string[];
  }

  if (d["egress"] !== undefined) {
    if (!Array.isArray(d["egress"]) || d["egress"].some((h) => typeof h !== "string")) {
      throw new Error(`${sourcePath}: "egress" must be an array of host strings`);
    }
    out.egress = d["egress"] as string[];
  }

  if (d["auth"] !== undefined) out.auth = parseAuth(d["auth"], sourcePath);
  if (d["approvals"] !== undefined) out.approvals = parseApprovals(d["approvals"], sourcePath);

  if (d["install"] !== undefined) {
    const inst = d["install"];
    if (typeof inst !== "object" || inst === null || Array.isArray(inst)) {
      throw new Error(`${sourcePath}: "install" must be an object`);
    }
    const binary = (inst as Record<string, unknown>)["binary"];
    if (binary !== undefined && typeof binary !== "string") {
      throw new Error(`${sourcePath}: "install.binary" must be a string`);
    }
    if (binary !== undefined && !TOOL_ID_RE.test(binary as string)) {
      throw new Error(
        `${sourcePath}: "install.binary" must match ${TOOL_ID_RE.source} (lowercase alphanumerics and hyphens) — it is interpolated into generated Dockerfile lines`,
      );
    }
    out.install = binary !== undefined ? { binary: binary as string } : {};
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
      throw new Error(`${sourcePath}: approvals[${i}] is not a valid regex: ${(e as Error).message}`, { cause: e });
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
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new Error(`${sourcePath}: "auth" must be an object`);
  }
  const a = raw as Record<string, unknown>;
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
      if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
        throw new Error(`${sourcePath}: "auth.credentialPaths[${index}]" must be an object`);
      }
      const value = entry as Record<string, unknown>;
      if (typeof value.path !== "string" || (value.kind !== "file" && value.kind !== "directory")) {
        throw new Error(
          `${sourcePath}: "auth.credentialPaths[${index}]" requires string path and kind file or directory`,
        );
      }
      return { path: value.path, kind: value.kind };
    });
  }
  if (a["splitEnv"] !== undefined) {
    const se = a["splitEnv"];
    if (typeof se !== "object" || se === null || Array.isArray(se)) {
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
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new Error(`${sourcePath}: "auth.broker" must be an object`);
  }
  const b = raw as Record<string, unknown>;
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
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
      throw new Error(`${sourcePath}: approvals[${i}] must be an object`);
    }
    const e = entry as Record<string, unknown>;
    const hasCommand = typeof e["command"] === "string" && (e["command"] as string).trim() !== "";
    const hasPattern = typeof e["pattern"] === "string" && (e["pattern"] as string).trim() !== "";
    if (!hasCommand && !hasPattern) throw new Error(`${sourcePath}: approvals[${i}] needs a "command" or a "pattern"`);
    if (hasCommand && hasPattern)
      throw new Error(`${sourcePath}: approvals[${i}] has both "command" and "pattern" — use one`);
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
const POSIX_FUNCTION_NAME_RE = /^[a-z_][a-z0-9_]*$/;
const SPLIT_ENV_KEY_RE = /^[A-Z][A-Z0-9_]*$/;

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
  return { pattern: `\\b${[escapeRegex(binary), ...words].join("\\s+")}(?:\\b|\\s|$)`, decision };
}

export function interpolateSplitEnv(
  template: Record<string, string>,
  ctx: { actingSlackUserId?: string },
): Record<string, string> {
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
