import { type BenchTask, type Fixture, defineTask } from "../../core/types.ts";
import { type PeersKey, generate } from "./generate.ts";
import { verify } from "./verify.ts";

export function task(): BenchTask {
  return defineTask<PeersKey>({
    id: "network-find-peers",
    difficulty: "easy",
    family: "network",
    origin: "observed",
    evidence:
      "Proposed network workflow for qm: match a founder's ask against the community directory while respecting contact preferences. Not a workflow Garry listed.",
    sources: ["https://qm.ycombinator.com/", "https://github.com/yc-software/qm"],
    outputs: ["output/peers.json"],
    generate,
    prompt: () =>
      'A founder asks for peer intros in inbox/request.md. Search all of directory/ (read directory/README.md first) and write output/peers.json: a JSON array of up to 5 {"name", "company", "why"}, best matches first, where why quotes the expertise phrase from their own record that matched. A match works in the same sector and has the topic in their expertise; expertise is phrased differently across files, and directory/updates.csv changes some records after the exports. ' +
      "Never suggest anyone on do-not-contact.csv, never suggest the same person twice, and prefer the requester's city when there are more matches than slots. Use only the directory. Write a script.",
    verify,
  });
}

export function gold(f: Fixture<PeersKey>): Record<string, string> {
  const preferred = new Set(f.key.preferred);
  const ranked = [...f.key.eligible].sort((a, b) => Number(preferred.has(b)) - Number(preferred.has(a))).slice(0, 5);
  return {
    "output/peers.json": JSON.stringify(
      ranked.map((k) => ({
        ...f.key.personOf[k]!,
        why: `Same sector; their profile lists "${f.key.phraseOf[k]}"`,
      })),
    ),
  };
}
