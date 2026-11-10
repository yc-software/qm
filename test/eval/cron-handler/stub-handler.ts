type FireReport = { cronId: string; cronTitle: string; at: number; text: string; urgent?: boolean };
type HandlerDecision = { sendNow: string[]; digestItems: string[]; dropped: { cronId: string; reason: string }[] };

export function createFireHandler(_opts: { model: (prompt: string) => Promise<string>; state?: unknown }) {
  const state = { pending: [] as string[] };
  return {
    state,
    async handle(reports: FireReport[], _now: number): Promise<HandlerDecision> {
      const d: HandlerDecision = { sendNow: [], digestItems: [], dropped: [] };
      for (const r of reports) {
        if (r.urgent) d.sendNow.push(`${r.cronTitle}: ${r.text}`);
        else if (/no (desk )?change|finish silently|nothing (new|to report)|routine/i.test(r.text)) d.dropped.push({ cronId: r.cronId, reason: "routine" });
        else d.digestItems.push(`${r.cronTitle}: ${r.text}`);
      }
      state.pending.push(...d.digestItems);
      return d;
    },
    async flushDigest(_now: number): Promise<string | null> {
      if (!state.pending.length) return null;
      const text = state.pending.map((s) => `- ${s}`).join("\n");
      state.pending = [];
      return text;
    },
  };
}
