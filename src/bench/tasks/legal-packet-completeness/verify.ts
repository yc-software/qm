import { asArray, asRecord, f1, parseJson, str } from "../../core/text.ts";
import type { Check, Outputs } from "../../core/types.ts";
import type { PacketKey } from "./generate.ts";

export async function verify(outputs: Outputs, key: PacketKey): Promise<Check[]> {
  const o = asRecord(parseJson(await outputs.read("output/completeness.json")));
  const companies = Object.keys(key.missing);
  const expectedPairs = companies.flatMap((c) => key.missing[c]!.map((d) => `${c}|${d}`));
  const actualPairs = Object.entries(o).flatMap(([c, v]) =>
    asArray(asRecord(v).missing).map((d) => `${c.toLowerCase()}|${str(d).toLowerCase()}`),
  );
  const exact = companies.filter((c) => {
    const entry = asRecord(o[c]);
    const got = asArray(entry.missing)
      .map((d) => str(d).toLowerCase())
      .sort()
      .join();
    return got === [...key.missing[c]!].sort().join() && entry.complete === (key.missing[c]!.length === 0);
  }).length;
  return [
    {
      id: "all-packets-listed",
      score: f1(
        companies,
        Object.keys(o).map((c) => c.toLowerCase()),
      ),
    },
    { id: "missing-pairs", score: f1(expectedPairs, actualPairs) },
    { id: "packets-exactly-right", score: exact / companies.length },
  ];
}
