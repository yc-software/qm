import { CREDENTIAL_PATH_RE, DISPLACED_DIR_REL, builtInCredentialPaths } from "./credential-paths.ts";

export type ApprovalDecision = "require_approval" | "deny";

export interface ToolApproval {
  command: string;
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
  install?: ToolInstall;
}

export interface ToolInstallFile {
  from: string;
  to: string;
  mode: string;
}

interface ToolInstall {
  binary?: string;
  files?: ToolInstallFile[];
}

const INSTALL_FROM_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const INSTALL_TO_RE = /^\/usr\/local\/(?:bin|lib)\/[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)*$/;
const INSTALL_MODE_RE = /^0[0-7]{3}$/;

function installFileError(
  file: unknown,
  sourcePath: string,
  index: number,
  owner: { id: string; binary: string },
): string | undefined {
  const at = `${sourcePath}: "install.files[${index}]"`;
  if (typeof file !== "object" || file === null || Array.isArray(file)) return `${at} must be an object`;
  const { from, to, mode } = file as Record<string, unknown>;
  if (typeof from !== "string" || !INSTALL_FROM_RE.test(from) || from === "tool.json")
    return `${at}.from must name a file beside tool.json (letters, digits, . _ -), not tool.json itself`;
  if (typeof to !== "string" || !INSTALL_TO_RE.test(to) || to.split("/").some((seg) => seg === ".." || seg === "."))
    return `${at}.to must be an absolute path under /usr/local/bin/ or /usr/local/lib/ with no dot segments`;
  if (to !== `/usr/local/bin/${owner.binary}` && !to.startsWith(`/usr/local/lib/${owner.id}/`))
    return `${at}.to must be /usr/local/bin/${owner.binary} or a path under /usr/local/lib/${owner.id}/ — a tool may only install its own binary and its own library directory`;
  if (mode !== undefined && (typeof mode !== "string" || !INSTALL_MODE_RE.test(mode)))
    return `${at}.mode must be a four-digit octal string like "0755"`;
  return undefined;
}

function parseInstallFiles(raw: unknown, sourcePath: string, owner: { id: string; binary: string }): ToolInstallFile[] {
  if (!Array.isArray(raw)) throw new Error(`${sourcePath}: "install.files" must be an array`);
  const out: ToolInstallFile[] = [];
  for (const [index, file] of raw.entries()) {
    const err = installFileError(file, sourcePath, index, owner);
    if (err) throw new Error(err);
    const { from, to, mode } = file as { from: string; to: string; mode?: string };
    if (out.some((other) => other.to === to))
      throw new Error(`${sourcePath}: "install.files" declares ${JSON.stringify(to)} twice`);
    out.push({ from, to, mode: mode ?? (to.startsWith("/usr/local/bin/") ? "0755" : "0644") });
  }
  return out;
}

const BUILT_IN_CREDENTIAL_PATHS: readonly ToolCredentialPath[] = builtInCredentialPaths();

const nested = (a: string, b: string): boolean => a.startsWith(`${b}/`);

function credentialPathError(path: string, kind: "file" | "directory"): string | undefined {
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
    return `credential path ${JSON.stringify(path)} must be a $HOME-relative path with no traversal`;
  }
  if (segments[0] === DISPLACED_DIR_REL)
    return `credential path ${JSON.stringify(path)} is reserved — ${DISPLACED_DIR_REL} is where provision quarantines displaced $HOME state, and linking it would make it its own displacement target`;
  if (!segments[0]!.startsWith("."))
    return `credential path ${JSON.stringify(path)} must start with a dotfile or dot-directory segment — non-hidden $HOME paths are durable agent data, not credentials`;
  if (!CREDENTIAL_PATH_RE.test(path))
    return `credential path ${JSON.stringify(path)} may only use letters, digits, and ._/@+- — other characters cannot ride the capture sweep`;
  const builtIn = BUILT_IN_CREDENTIAL_PATHS.find(
    (base) => path === base.path || nested(path, base.path) || nested(base.path, path),
  );
  if (builtIn && (path !== builtIn.path || kind !== builtIn.kind))
    return `credential path ${JSON.stringify(path)} (${kind}) overlaps the built-in credential path ${JSON.stringify(builtIn.path)} (${builtIn.kind}) — declare the exact built-in path with its correct kind or a disjoint one`;
  return undefined;
}

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
    const files = (inst as Record<string, unknown>)["files"];
    out.install = {
      ...(binary !== undefined ? { binary: binary as string } : {}),
      ...(files !== undefined
        ? {
            files: parseInstallFiles(files, sourcePath, {
              id: out.id,
              binary: (binary as string | undefined) ?? out.id,
            }),
          }
        : {}),
    };
  }

  const credentialPaths = out.auth?.credentialPaths ?? [];
  for (const [index, credentialPath] of credentialPaths.entries()) {
    const { path } = credentialPath;
    const err = credentialPathError(path, credentialPath.kind);
    if (err) throw new Error(`${sourcePath}: ${err}`);
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
    if (e["pattern"] !== undefined) {
      throw new Error(
        `${sourcePath}: approvals[${i}].pattern is no longer supported — list the subcommand words after the tool binary in "command"`,
      );
    }
    if (typeof e["command"] !== "string" || !e["command"].trim()) {
      throw new Error(`${sourcePath}: approvals[${i}] needs a "command"`);
    }
    const out: ToolApproval = { command: e["command"] };
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

export function approvalRule(
  binary: string,
  approval: ToolApproval,
): { argv: string[]; decision: ApprovalDecision; reason?: string } {
  return {
    argv: [binary, ...approval.command.trim().split(/\s+/)],
    decision: approval.decision ?? "require_approval",
    ...(approval.reason ? { reason: approval.reason } : {}),
  };
}
