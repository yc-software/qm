import { execFile } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { jqChildEnv } from "../config.ts";
import { MAX_AUDIENCE_EXPR_CHARS, MAX_AUDIENCE_RECIPIENTS, type PeerIdentity } from "./types.ts";

const JQ_TIMEOUT_MS = 2_000;
const JQ_MAX_OUTPUT_BYTES = 256 * 1024;
const JQ_MAX_INPUT_BYTES = 1024 * 1024;
const JQ_MAX_REASON_CHARS = 500;

type AudienceCandidate = Record<string, unknown>;

export type AudienceResult = { ok: true; recipientIds: string[] } | { ok: false; reason: string };

function audienceCandidates(identities: readonly PeerIdentity[]): AudienceCandidate[] {
  return identities.map((identity) => ({
    ...identity.character,
    _qm: { sessionId: identity.sessionId, character: identity.character },
  }));
}

let emptyLibraryDir: string | undefined;
function libraryDir(): string {
  emptyLibraryDir ??= mkdtempSync(join(tmpdir(), "qm-jq-"));
  return emptyLibraryDir;
}

function compareText(a: string, b: string): number {
  if (a < b) return -1;
  return a > b ? 1 : 0;
}

function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) => compareText(a, b));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(",")}}`;
}

function runJq(expr: string, input: string): Promise<{ ok: true; stdout: string } | { ok: false; reason: string }> {
  return new Promise((resolve) => {
    const child = execFile(
      "jq",
      ["-c", "-L", libraryDir(), "--", expr],
      {
        env: jqChildEnv(),
        timeout: JQ_TIMEOUT_MS,
        killSignal: "SIGKILL",
        maxBuffer: JQ_MAX_OUTPUT_BYTES,
        encoding: "utf8",
      },
      (error, stdout, stderr) => {
        if (error) {
          const killed = (error as { killed?: boolean }).killed === true;
          const detail = stderr.trim().slice(0, JQ_MAX_REASON_CHARS);
          resolve({
            ok: false,
            reason: killed || !detail ? "audience expression exceeded its limits" : detail,
          });
          return;
        }
        resolve({ ok: true, stdout });
      },
    );
    child.stdin?.on("error", () => undefined);
    child.stdin?.end(input);
  });
}

export async function evaluateAudience(expr: string, identities: readonly PeerIdentity[]): Promise<AudienceResult> {
  if (!expr.trim()) return { ok: false, reason: "audience expression must not be empty" };
  if (expr.length > MAX_AUDIENCE_EXPR_CHARS) return { ok: false, reason: "audience expression is too long" };
  const candidates = audienceCandidates(identities);
  const input = JSON.stringify(candidates);
  if (Buffer.byteLength(input, "utf8") > JQ_MAX_INPUT_BYTES) {
    return { ok: false, reason: "audience input is too large to evaluate" };
  }
  const authorized = new Map<string, string>();
  for (const [index, candidate] of candidates.entries()) {
    authorized.set(canonical(candidate), identities[index]!.sessionId);
  }

  const run = await runJq(expr, input);
  if (!run.ok) return run;

  const lines = run.stdout.split("\n").filter((line) => line.trim());
  if (lines.length > MAX_AUDIENCE_RECIPIENTS)
    return { ok: false, reason: "audience expression produced too many results" };
  const recipientIds: string[] = [];
  for (const line of lines) {
    let emitted: unknown;
    try {
      emitted = JSON.parse(line);
    } catch {
      return { ok: false, reason: "audience expression produced output that is not JSON" };
    }
    if (emitted === null || typeof emitted !== "object" || Array.isArray(emitted)) {
      return { ok: false, reason: "audience expression must select candidate objects" };
    }
    const sessionId = authorized.get(canonical(emitted));
    if (sessionId === undefined) {
      return { ok: false, reason: "audience expression returned an object it was not given" };
    }
    if (!recipientIds.includes(sessionId)) recipientIds.push(sessionId);
  }
  return { ok: true, recipientIds };
}
