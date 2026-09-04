import { randomUUID } from "node:crypto";
import { shq } from "../util/shell.ts";
import type {
  ExecOptions,
  ExecResult,
  ProcessSession,
  ProcessState,
  ReadProcessOptions,
  ReadProcessResult,
  SandboxHandle,
  StartProcessOptions,
} from "./sandbox.ts";
import { createSecretValueMasker } from "../security/secret-masking.ts";

export interface ExecProcessIo {
  run(handle: SandboxHandle, command: string, opts?: ExecOptions): Promise<ExecResult>;
}

export interface ExecProcessSessions {
  startProcess(handle: SandboxHandle, command: string, opts?: StartProcessOptions): Promise<{ processId: string }>;
  readProcess(handle: SandboxHandle, processId: string, opts?: ReadProcessOptions): Promise<ReadProcessResult>;
  writeStdin(handle: SandboxHandle, processId: string, data: string): Promise<void>;
  signalProcess(handle: SandboxHandle, processId: string, signal: string): Promise<void>;
  listProcesses(handle: SandboxHandle): Promise<ProcessSession[]>;
}

const PROC_BASE = "${HOME:-/root}/.agent-proc";
const REBOOT_RC = 137;
const BOOT_ID_SH = `cat /proc/sys/kernel/random/boot_id 2>/dev/null || sysctl -n kern.boottime 2>/dev/null || true`;
const REAP_SH = [
  `_bootid() { ${BOOT_ID_SH}; }`,
  `_reap() { if [ -f "$1/code" ]; then return 0; fi; b=$(_bootid); o=$(cat "$1/boot" 2>/dev/null || true); if [ -n "$b" ] && [ -n "$o" ] && [ "$b" != "$o" ]; then echo ${REBOOT_RC} > "$1/code"; fi; return 0; }`,
].join("\n");
const DEFAULT_MAX_BYTES = 64 * 1024;
const ALLOWED_SIGNALS = new Set(["TERM", "KILL", "INT", "HUP", "QUIT"]);
const ID_RE = /^[0-9a-f-]{36}$/;

const b64 = (s: string): string => Buffer.from(s, "utf8").toString("base64");
const fromB64 = (s: string): string => Buffer.from(s, "base64").toString("utf8");

function assertId(processId: string): void {
  if (!ID_RE.test(processId)) throw new Error(`invalid process id: ${processId}`);
}

function parseStatus(raw: string): ProcessState {
  if (raw.startsWith("exited:")) return { state: "exited", code: Number.parseInt(raw.slice(7), 10) || 0 };
  return { state: "running" };
}

export function redactCommand(command: string, env?: Record<string, string>): string {
  return createSecretValueMasker(env)(command)
    .replace(/(--?(?:token|password|secret|client[-_]?secret|api[-_]?key)[ =])\S+/gi, "$1<redacted>")
    .replace(/(?:printf|echo)(?:\s+(?:"[^"]*"|'[^']*'|[^\s"']\S*))+(\s*\|[^|]*--with-token\b)/gi, "echo <redacted>$1")
    .replace(
      /(export\s+\w*(?:PASS|PASSWORD|SECRET|TOKEN|KEY|IDENTIFIER|CREDENTIAL|PROXY_USER)\w*=')[^']*'/gi,
      "$1<redacted>'",
    )
    .slice(0, 500);
}

export function createExecProcessSessions(io: ExecProcessIo): ExecProcessSessions {
  return {
    async startProcess(handle, command, opts): Promise<{ processId: string }> {
      const processId = randomUUID();
      const cwd = opts?.cwd ?? handle.rootDir;
      const env = { ...handle.env, ...opts?.env };
      const envExports = Object.entries(env)
        .map(([k, v]) => `export ${k}=${shq(v)}`)
        .join("; ");
      const script = [
        `P="${PROC_BASE}/${processId}"`,
        `mkdir -p "$P"`,
        `printf '%s' '${b64(command)}' | base64 -d > "$P/cmd"`,
        ...(envExports ? [`printf '%s' '${b64(envExports)}' | base64 -d > "$P/env"`] : []),
        `printf '%s' '${b64(cwd)}' | base64 -d > "$P/cwd"`,
        `date +%s > "$P/started"`,
        `{ ${BOOT_ID_SH}; } > "$P/boot" 2>/dev/null || true`,
        `[ -p "$P/in" ] || mkfifo "$P/in"`,
        `LAUNCH='d="$1"; cd "$(cat "$d/cwd")" 2>/dev/null; if [ -f "$d/env" ]; then . "$d/env"; rm -f "$d/env"; fi; exec 3<>"$d/in"; cpid=""; _fin(){ [ -f "$d/code" ] || echo 143 > "$d/code"; trap - TERM INT HUP QUIT; [ -n "$cpid" ] && kill -TERM "$cpid" 2>/dev/null; kill -TERM -$$ 2>/dev/null; exit 143; }; trap _fin TERM INT HUP QUIT; sh "$d/cmd" <&3 >"$d/out" 2>&1 & cpid=$!; wait "$cpid"; rc=$?; [ -f "$d/code" ] || echo $rc > "$d/code"'`,
        `if command -v setsid >/dev/null 2>&1; then setsid sh -c "$LAUNCH" _ "$P" >/dev/null 2>&1 & else sh -c "$LAUNCH" _ "$P" >/dev/null 2>&1 & fi`,
        `echo $! > "$P/pid"`,
        `echo OK`,
      ].join("\n");
      const r = await io.run(handle, script, { timeoutMs: 20_000 });
      if (r.code !== 0 || !r.stdout.includes("OK")) {
        throw new Error(`startProcess failed (code ${r.code}): ${r.stderr.trim() || r.stdout.trim()}`);
      }
      return { processId };
    },

    async readProcess(handle, processId, opts): Promise<ReadProcessResult> {
      assertId(processId);
      const cursor = Math.max(0, opts?.sinceCursor ?? 0);
      const maxBytes = Math.max(1, opts?.maxBytes ?? DEFAULT_MAX_BYTES);
      const waitMs = Math.max(0, opts?.waitMs ?? 0);
      const iters = Math.ceil(waitMs / 100);
      const script = [
        `P="${PROC_BASE}/${processId}"`,
        `[ -d "$P" ] || { echo "MISSING=1"; exit 0; }`,
        REAP_SH,
        `_reap "$P"`,
        `cur=${cursor}`,
        `i=0`,
        `while [ $i -lt ${iters} ]; do`,
        `  sz=$(wc -c < "$P/out" 2>/dev/null || echo 0)`,
        `  if [ -f "$P/code" ] || [ "$sz" -gt "$cur" ]; then break; fi`,
        `  sleep 0.1; i=$((i+1))`,
        `done`,
        `sz=$(wc -c < "$P/out" 2>/dev/null || echo 0)`,
        `end=$((cur+${maxBytes})); if [ "$end" -gt "$sz" ]; then end=$sz; fi`,
        `n=$((end-cur)); if [ "$n" -lt 0 ]; then n=0; fi`,
        `echo "CURSOR=$end"`,
        `if [ -f "$P/code" ]; then echo "STATUS=exited:$(cat "$P/code")"; else echo "STATUS=running"; fi`,
        `echo "DATA="`,
        `if [ "$n" -gt 0 ]; then tail -c +$((cur+1)) "$P/out" | head -c "$n" | base64 | tr -d '\\n'; fi`,
        `echo ""`,
      ].join("\n");
      const r = await io.run(handle, script, { timeoutMs: waitMs + 20_000 });
      const out = r.stdout;
      if (/MISSING=1/.test(out)) throw new Error(`no such process session: ${processId}`);
      const cur = /CURSOR=(\d+)/.exec(out);
      const st = /STATUS=(running|exited:-?\d+)/.exec(out);
      const dataIdx = out.indexOf("DATA=");
      const dataLine = dataIdx >= 0 ? out.slice(out.indexOf("\n", dataIdx) + 1).trim() : "";
      return {
        chunks: dataLine ? fromB64(dataLine) : "",
        cursor: cur ? Number.parseInt(cur[1]!, 10) : cursor,
        status: st ? parseStatus(st[1]!) : { state: "running" },
      };
    },

    async writeStdin(handle, processId, data): Promise<void> {
      assertId(processId);
      const script = [
        `P="${PROC_BASE}/${processId}"`,
        `[ -p "$P/in" ] || { echo "MISSING=1"; exit 1; }`,
        `printf '%s' '${b64(data)}' | base64 -d > "$P/in"`,
      ].join("\n");
      const r = await io.run(handle, script, { timeoutMs: 15_000 });
      if (r.code !== 0) throw new Error(`writeStdin failed for ${processId}: ${r.stderr.trim() || "no such session"}`);
    },

    async signalProcess(handle, processId, signal): Promise<void> {
      assertId(processId);
      const sig = signal.replace(/^SIG/, "").toUpperCase();
      if (!ALLOWED_SIGNALS.has(sig)) throw new Error(`unsupported signal: ${signal}`);
      const sentinelLine =
        sig === "KILL"
          ? `[ -f "$P/code" ] || echo 137 > "$P/code"`
          : `if ! kill -0 -"$pid" 2>/dev/null && ! kill -0 "$pid" 2>/dev/null; then [ -f "$P/code" ] || echo 143 > "$P/code"; fi`;
      const script = [
        `P="${PROC_BASE}/${processId}"`,
        `pid=$(cat "$P/pid" 2>/dev/null) || exit 0`,
        `kill -${sig} -"$pid" 2>/dev/null || kill -${sig} "$pid" 2>/dev/null || true`,
        sentinelLine,
      ].join("\n");
      await io.run(handle, script, { timeoutMs: 15_000 });
    },

    async listProcesses(handle): Promise<ProcessSession[]> {
      const script = [
        `B="${PROC_BASE}"`,
        `[ -d "$B" ] || exit 0`,
        REAP_SH,
        `for d in "$B"/*; do`,
        `  [ -d "$d" ] || continue`,
        `  _reap "$d"`,
        `  id=$(basename "$d")`,
        `  st=$(cat "$d/started" 2>/dev/null || echo 0)`,
        `  if [ -f "$d/code" ]; then status="exited:$(cat "$d/code")"; else status="running"; fi`,
        `  cmd=$(head -c 500 "$d/cmd" 2>/dev/null | base64 | tr -d '\\n')`,
        `  echo "$id|$st|$status|$cmd"`,
        `done`,
      ].join("\n");
      const r = await io.run(handle, script, { timeoutMs: 15_000 });
      const sessions: ProcessSession[] = [];
      for (const line of r.stdout.split("\n")) {
        const parts = line.split("|");
        if (parts.length < 4 || !ID_RE.test(parts[0]!)) continue;
        sessions.push({
          processId: parts[0]!,
          startedAt: (Number.parseInt(parts[1]!, 10) || 0) * 1000,
          status: parseStatus(parts[2]!),
          command: redactCommand(parts[3] ? fromB64(parts[3]) : "", handle.env),
        });
      }
      return sessions;
    },
  };
}
