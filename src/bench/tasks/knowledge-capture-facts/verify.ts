import { asArray, parseJson, str } from "../../core/text.ts";
import type { Check, Outputs } from "../../core/types.ts";
import type { FactsKey } from "./generate.ts";

export async function verify(outputs: Outputs, key: FactsKey): Promise<Check[]> {
  const facts = asArray(parseJson(await outputs.read("output/facts.json")))
    .map(str)
    .filter(Boolean);
  const blob = facts.join("\n").toLowerCase();
  const recalled = key.durable.filter((f) => blob.includes(f.token.toLowerCase())).length;
  const precise = facts.filter((f) => key.durable.some((d) => f.toLowerCase().includes(d.token.toLowerCase()))).length;
  const stale = key.durable.filter((f) => f.stale !== undefined);
  const asserted = (f: (typeof stale)[number]): boolean =>
    facts.some(
      (x) => x.toLowerCase().includes(f.stale!.toLowerCase()) && !x.toLowerCase().includes(f.token.toLowerCase()),
    );
  const staleGone = stale.filter((f) => !asserted(f)).length;
  const ephemeralGone = key.ephemeral.filter((e) => !blob.includes(e.toLowerCase())).length;
  const forbiddenGone = key.forbidden.filter((e) => !blob.includes(e.toLowerCase())).length;
  return [
    { id: "durable-recall", score: recalled / key.durable.length },
    { id: "durable-precision", score: facts.length === 0 ? 0 : precise / facts.length },
    { id: "corrections-and-reversals", score: facts.length === 0 ? 0 : staleGone / stale.length },
    { id: "ephemeral-excluded", score: facts.length === 0 ? 0 : ephemeralGone / key.ephemeral.length },
    { id: "secrets-and-injections-excluded", score: facts.length === 0 ? 0 : forbiddenGone / key.forbidden.length },
  ];
}
