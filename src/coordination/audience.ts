import { execFile } from "node:child_process";
import { mkdtemp, rmdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { CoordinationError, type AudienceCandidate } from "./types.ts";

function audienceDocument(candidate: AudienceCandidate) {
  return {
    ...candidate.character,
    _qm: { id: candidate.id, name: candidate.name, version: candidate.version, character: candidate.character },
  };
}

export async function evaluateAudience(
  expression: string,
  candidates: readonly AudienceCandidate[],
): Promise<string[]> {
  if (!expression.trim() || expression.length > 4096)
    throw new CoordinationError(400, "invalid_audience", "provide a jq audience expression of at most 4096 characters");
  if (/\b(?:include|import)\b/.test(expression))
    throw new CoordinationError(
      400,
      "invalid_audience",
      "jq module directives are unavailable in audience expressions",
    );
  const documents = candidates.map(audienceDocument);
  const input = JSON.stringify(documents);
  if (Buffer.byteLength(input) > 4 * 1024 * 1024)
    throw new CoordinationError(
      413,
      "audience_too_large",
      "organization character data exceeds the audience evaluator limit",
    );
  const directory = await mkdtemp(join(tmpdir(), "qm-audience-"));
  try {
    const output = await new Promise<string>((resolve, reject) => {
      const child = execFile(
        "/bin/sh",
        [
          "-c",
          process.platform === "darwin" ? 'ulimit -t 1 && exec "$@"' : 'ulimit -t 1 && ulimit -d 131072 && exec "$@"',
          "audience",
          "jq",
          "-cM",
          "-L",
          directory,
          "--",
          expression,
        ],
        {
          cwd: directory,
          env: { PATH: "/usr/bin:/bin:/opt/homebrew/bin" },
          timeout: 2000,
          killSignal: "SIGKILL",
          maxBuffer: 4 * 1024 * 1024,
        },
        (error, stdout) => {
          if (error)
            reject(
              new CoordinationError(
                400,
                "audience_evaluation_failed",
                "jq audience was invalid or exceeded its execution limit",
              ),
            );
          else resolve(stdout);
        },
      );
      child.stdin?.on("error", () => {});
      child.stdin?.end(input);
    });
    const byId = new Map(documents.map((doc) => [doc._qm.id, doc]));
    const ids = new Set<string>();
    for (const line of output.split("\n").filter(Boolean)) {
      let value;
      try {
        value = JSON.parse(line);
      } catch {
        throw new CoordinationError(400, "invalid_audience_result", "audience must emit unchanged candidate objects");
      }
      const id = value?._qm?.id;
      if (typeof id !== "string" || !byId.has(id) || !isDeepStrictEqual(value, byId.get(id)))
        throw new CoordinationError(400, "invalid_audience_result", "audience must emit unchanged candidate objects");
      ids.add(id);
    }
    if (ids.size > 256)
      throw new CoordinationError(400, "audience_fanout_exceeded", "a message may notify at most 256 sessions");
    return [...ids];
  } finally {
    await rmdir(directory);
  }
}
