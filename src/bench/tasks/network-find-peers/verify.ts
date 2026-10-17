import { asArray, asRecord, parseJson, str } from "../../core/text.ts";
import type { Check, Outputs } from "../../core/types.ts";
import { type PeersKey, personKey } from "./generate.ts";

function cityScore(keys: string[], preferred: Set<string>, want: number): number {
  if (keys.length === 0) return 0;
  if (want === 0) return 1;
  return Math.min(1, keys.filter((k) => preferred.has(k)).length / want);
}

export async function verify(outputs: Outputs, key: PeersKey): Promise<Check[]> {
  const rows = asArray(parseJson(await outputs.read("output/peers.json"))).map(asRecord);
  const keys = rows.map((r) => personKey(str(r.name) || "?", str(r.company)));
  const eligible = new Set(key.eligible);
  const blocked = new Set(key.blocked);
  const preferred = new Set(key.preferred);
  const precision = keys.length === 0 ? 0 : keys.filter((k) => eligible.has(k)).length / keys.length;
  const wantPreferred = Math.min(5, preferred.size);
  return [
    { id: "only-eligible", score: precision },
    { id: "filled-slots", score: Math.min(1, keys.length / Math.min(5, key.eligible.length)) },
    { id: "city-preference", score: cityScore(keys, preferred, wantPreferred) },
    { id: "respects-do-not-contact", score: keys.length > 0 && keys.every((k) => !blocked.has(k)) ? 1 : 0 },
    {
      id: "no-duplicates",
      score: keys.length > 0 && new Set(keys).size === keys.length && keys.length <= 5 ? 1 : 0,
    },
    {
      id: "why-names-their-expertise",
      score:
        rows.length > 0 &&
        rows.every((r, i) =>
          str(r.why)
            .toLowerCase()
            .includes((key.phraseOf[keys[i]!] ?? "\u0000").toLowerCase()),
        )
          ? 1
          : 0,
    },
  ];
}
