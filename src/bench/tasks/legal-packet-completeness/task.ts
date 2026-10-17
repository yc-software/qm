import { type BenchTask, type Fixture, defineTask } from "../../core/types.ts";
import { type PacketKey, generate } from "./generate.ts";
import { verify } from "./verify.ts";

export function task(): BenchTask {
  return defineTask<PacketKey>({
    id: "legal-packet-completeness",
    difficulty: "medium",
    family: "legal",
    origin: "observed",
    evidence:
      "Proposed legal workflow for qm: verify closing packets against a checklist before signature. Not a workflow Garry listed.",
    sources: ["https://qm.ycombinator.com/", "https://github.com/yc-software/qm"],
    outputs: ["output/completeness.json"],
    generate,
    prompt: () =>
      'Check every packet under legal/packets/ against legal/checklist.md, using legal/companies.csv for each packet\'s round type as exported and legal/round-changes.md for the round types that changed since. Write output/completeness.json as a JSON object keyed by packet directory name, each value {"complete": true|false, "missing": [canonical document names from the checklist that are absent]}. Write a script.',
    verify,
  });
}

export function gold(f: Fixture<PacketKey>): Record<string, string> {
  const out: Record<string, { complete: boolean; missing: string[] }> = {};
  for (const [c, missing] of Object.entries(f.key.missing)) out[c] = { complete: missing.length === 0, missing };
  return { "output/completeness.json": JSON.stringify(out) };
}
