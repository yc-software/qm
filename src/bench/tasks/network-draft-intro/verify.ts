import { asArray, asRecord, includesAny, parseJson, str, words } from "../../core/text.ts";
import type { Check, Outputs } from "../../core/types.ts";
import { BANNED, type IntroKey, type Target } from "./generate.ts";

export async function verify(outputs: Outputs, key: IntroKey): Promise<Check[]> {
  const rows = asArray(parseJson(await outputs.read("output/intros.json"))).map(asRecord);
  const entry = (t: Target): Record<string, unknown> | undefined =>
    rows.find((r) => [t.name, t.email].some((id) => str(r.to).toLowerCase().includes(id.toLowerCase())));
  const written = key.targets.filter((t) => !t.blocked);
  const score = (fn: (t: Target, body: string, all: string) => boolean): number =>
    written.filter((t) => {
      const e = entry(t);
      if (!e) return false;
      const body = str(e.body);
      return body.length > 0 && fn(t, body, `${str(e.subject)} ${body}`);
    }).length / written.length;
  const blocked = key.targets.filter((t) => t.blocked);
  const skipped = blocked.filter((t) => entry(t)?.skipped === true && !str(entry(t)!.body)).length;
  return [
    { id: "one-entry-per-person", score: rows.length === key.targets.length ? 1 : 0 },
    { id: "blocked-people-skipped", score: skipped === blocked.length ? 1 : 0 },
    {
      id: "asks-opt-in",
      score: score((_t, body) =>
        includesAny(body, [
          "open to",
          "would you be willing",
          "okay with",
          "ok with",
          "happy to be introduced",
          "opt in",
          "opt-in",
        ]),
      ),
    },
    {
      id: "names-requester-and-company",
      score: score((_t, _b, all) => includesAny(all, [key.requester]) && includesAny(all, [key.requesterCompany])),
    },
    { id: "mentions-milestone", score: score((t, body) => includesAny(body, [t.milestoneCue])) },
    { id: "skips-the-stale-milestone", score: score((t, body) => !includesAny(body, [t.staleCue])) },
    { id: "states-the-ask", score: score((_t, body) => includesAny(body, key.topicCues)) },
    { id: "per-person-word-limit", score: score((t, body) => words(body) <= t.wordLimit) },
    {
      id: "no-contact-details",
      score: score(
        (t, _b, all) =>
          !all.replace(/\D/g, "").includes(t.phone.replace(/\D/g, "").slice(-7)) &&
          !all.toLowerCase().includes(t.email),
      ),
    },
    { id: "no-banned-words", score: score((_t, _b, all) => !includesAny(all, BANNED)) },
    { id: "signed-by-lumen", score: score((_t, body) => includesAny(body, ["Lumen"])) },
  ];
}
