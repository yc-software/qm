export type FireReport = { cronId: string; cronTitle: string; at: number; text: string; urgent?: boolean };

export type HandlerDecision = {
  sendNow: string[];
  digestItems: string[];
  dropped: { cronId: string; reason: string }[];
};

export type HandlerState = { lastText: Record<string, string>; digest: string[] };

export const UNCHANGED_REASON = "same text as its previous delivery";

const TRIAGE_PROMPT = `You triage reports from one person's scheduled tasks before they reach that person's direct messages. Each report is the final message of one scheduled run.
Put every report in exactly one bucket:
- sendNow: the person should see it within the hour: something needs their decision or action, something failed or broke, or a result they are clearly waiting on arrived.
- digestItems: worth knowing but not time-sensitive; it waits for the next twice-daily digest.
- dropped: it says nothing happened, nothing changed, or only restates routine status.
For sendNow and digestItems, write the line the person will read: start with the task title and a colon, and keep the report's substance, links and numbers.
Reply with JSON only: {"sendNow": string[], "digestItems": string[], "dropped": [{"cronId": string, "reason": string}]}

Reports:
`;

export const DIGEST_HEADING = "Digest of your scheduled tasks since the last one:";

const line = (r: FireReport): string => `${r.cronTitle}: ${r.text}`;

function parseDecision(raw: string): HandlerDecision | null {
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start < 0 || end < start) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.slice(start, end + 1));
  } catch {
    return null;
  }
  const o = parsed as Record<string, unknown>;
  const strings = (v: unknown): string[] | null =>
    Array.isArray(v) && v.every((s) => typeof s === "string") ? (v as string[]) : null;
  const sendNow = strings(o.sendNow ?? []);
  const digestItems = strings(o.digestItems ?? []);
  const dropped = Array.isArray(o.dropped ?? [])
    ? ((o.dropped ?? []) as unknown[]).flatMap((d) => {
        const e = d as Record<string, unknown> | null;
        return e && typeof e.cronId === "string" ? [{ cronId: e.cronId, reason: String(e.reason ?? "") }] : [];
      })
    : null;
  if (!sendNow || !digestItems || !dropped) return null;
  return { sendNow, digestItems, dropped };
}

export function combineSendNow(items: readonly string[]): string {
  return items.join("\n\n");
}

export function createFireHandler(opts: { model: (prompt: string) => Promise<string>; state?: HandlerState }) {
  const state: HandlerState = opts.state ?? { lastText: {}, digest: [] };
  return {
    state,
    async handle(reports: FireReport[], _now: number): Promise<HandlerDecision> {
      const decision: HandlerDecision = { sendNow: [], digestItems: [], dropped: [] };
      const fresh: FireReport[] = [];
      for (const r of [...reports].sort((a, b) => a.at - b.at)) {
        const text = r.text.trim();
        if (state.lastText[r.cronId] === text) decision.dropped.push({ cronId: r.cronId, reason: UNCHANGED_REASON });
        else fresh.push(r);
        state.lastText[r.cronId] = text;
      }
      decision.sendNow.push(...fresh.filter((r) => r.urgent).map(line));
      const triaged = fresh.filter((r) => !r.urgent);
      if (triaged.length) {
        const payload = triaged.map((r) => ({ cronId: r.cronId, title: r.cronTitle, text: r.text }));
        const verdict = await opts
          .model(TRIAGE_PROMPT + JSON.stringify(payload, null, 2))
          .then(parseDecision, () => null);
        if (verdict) {
          decision.sendNow.push(...verdict.sendNow);
          decision.digestItems.push(...verdict.digestItems);
          decision.dropped.push(...verdict.dropped);
        } else decision.sendNow.push(...triaged.map(line));
      }
      state.digest.push(...decision.digestItems);
      return decision;
    },
    async flushDigest(_now: number): Promise<string | null> {
      if (!state.digest.length) return null;
      const text = [DIGEST_HEADING, ...state.digest.map((item) => `- ${item}`)].join("\n");
      state.digest = [];
      return text;
    },
  };
}
