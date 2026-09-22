import { html, nothing } from "lit";
import { table, card, mount } from "./shared.ts";

export function metrics(root: HTMLElement, d: any, s: Record<string, any>) {
  const n = (text: any) => ({ text, cls: "num" });
  const line = (parts: any[]) => html`<div class="statline">${parts.filter(Boolean).join(" · ")}</div>`;
  const stacked = (title: string, description: string) => ({
    node: html`<div>
      <div class="primaryline">${title}</div>
      ${description ? html`<div class="subline">${description}</div>` : nothing}
    </div>`,
  });
  if (s.phase) {
    const p = (d.phases || []).find((p: any) => p.phase === s.phase);
    s.pageShell({
      back: { label: "← Metrics", onClick: () => s.go({ view: "metrics", scope: s.scope, session: null }) },
      title: s.phaseLabel(s.phase),
      context: s.phaseDesc(s.phase),
    });
    if (!p?.count) {
      mount(root, html`<p class="empty">No ${s.phaseLabel(s.phase).toLowerCase()} samples in this scope yet.</p>`);
      return;
    }
    const bins = (p.dist || []).map((b: any, i: number, all: any[]) => ({
      ...b,
      label: b.le == null ? "> " + s.fmtMs(all[i - 1]?.le) : "≤ " + s.fmtMs(b.le),
    }));
    while (bins.length && !bins[bins.length - 1].count) bins.pop();
    const max = Math.max(...bins.map((b: any) => b.count), 1);
    const worst = p.worst || [];
    mount(
      root,
      html`${line([Number(p.count).toLocaleString() + " turns", s.fmtMs(p.p50) + " p50", s.fmtMs(p.p95) + " p95", s.fmtMs(p.p99) + " p99"])}${card(
        "Distribution",
        "Where the samples land.",
        bins.length
          ? html`<div class="dist">
              ${bins.map(
                (b: any) =>
                  html`<div class="dist-row">
                    <span class="dist-label">${b.label}</span
                    ><span class="dist-track"
                      ><span
                        class="dist-bar"
                        style=${"width:" + Math.max((b.count / max) * 100, b.count ? 1 : 0) + "%"}
                      ></span></span
                    ><span class="dist-count">${b.count ? Number(b.count).toLocaleString() : ""}</span>
                  </div>`,
              )}
            </div>`
          : html`<p class="empty">No samples.</p>`,
      )}${card(
        "By day",
        "Daily percentiles (UTC).",
        table(
          ["Day", "Turns", "p50", "p95", "p99"],
          (p.daily || [])
            .slice()
            .reverse()
            .map((r: any) => [
              { text: r.day, cls: "mono" },
              n(Number(r.count).toLocaleString()),
              n(s.fmtMs(r.p50)),
              n(s.fmtMs(r.p95)),
              n(s.fmtMs(r.p99)),
            ]),
          "No daily samples.",
        ),
      )}${card(
        "Worst recent turns",
        worst.some((t: any) => t.sessionId)
          ? "The slowest samples. Each opens the turn's transcript."
          : "The slowest samples.",
        table(
          [s.phaseLabel(s.phase), "Total turn", "Scope", "Machine", "Time"],
          worst.map((t: any) => [
            n(s.fmtMs(t.ms)),
            n(t.totalMs ? s.fmtMs(t.totalMs) : "n/a"),
            s.shortName(t.scopeLabel),
            { text: s.turnKindWords(t) || "None", cls: "subline" },
            n(s.relTime(t.ts)),
          ]),
          "No samples.",
          (i) => {
            const t = worst[i];
            if (t.sessionId)
              s.go({
                view: "history",
                scope: t.scopeLabel || s.scope,
                session: t.sessionId,
                ...(t.turnSeq != null ? { turn: t.turnSeq } : {}),
              });
          },
        ),
      )}`,
    );
    return;
  }
  s.defaultShell({ count: s.plural(d.throughput?.total ?? 0, "run") });
  const c = d.cache,
    phases = d.phases || [],
    tp = d.throughput || {},
    an = d.anatomy;
  const mix = () => {
    if (!an?.composite?.totalTurns) return nothing;
    const a = an.traceA || {},
      b = an.traceB || {},
      c = an.composite;
    const share = (n: number) => s.fmtPct((n || 0) / c.totalTurns);
    const fmtX = (n: number) => (n == null ? "n/a" : String(Math.round(n * 10) / 10));
    return card(
      "Turn mix",
      "How often turns provision a machine, and what each kind of turn costs.",
      table(
        ["Kind of turn", "Share", "Turns", "Median", "Model calls", "Tool calls"],
        [
          [
            stacked("Turns that never touched a machine", "pure conversation, no tools"),
            n(share(a.samples)),
            n(String(a.samples || 0)),
            n(s.fmtMs(a.total?.p50)),
            n(fmtX(a.modelCalls?.avg)),
            n(fmtX(a.toolCalls?.avg)),
          ],
          [
            stacked(
              "Turns that used a machine",
              (b.warm || 0) +
                " on a warm machine (" +
                s.fmtMs(b.provisionWarm?.p50) +
                " median resume) · " +
                (b.cold || 0) +
                " booted cold (" +
                s.fmtMs(b.provisionCold?.p50) +
                " median boot)",
            ),
            n(share(b.samples)),
            n(String(b.samples || 0)),
            n(s.fmtMs(b.total?.p50)),
            n(fmtX(b.modelCalls?.avg)),
            n(fmtX(b.toolCalls?.avg)),
          ],
          [
            stacked("All turns", "the blended average"),
            n("100%"),
            n(String(c.totalTurns || 0)),
            n(s.fmtMs(c.total?.p50)),
            n(fmtX(c.modelCalls?.avg)),
            n(fmtX(c.toolCalls?.avg)),
          ],
        ],
        "No turns sampled.",
      ),
    );
  };
  mount(
    root,
    html`${c?.samples ? line([(c.avgHitRatio == null ? "n/a" : s.fmtPct(c.avgHitRatio)) + " prompt-cache hit ratio", (c.pooledHitRatio == null ? "n/a" : s.fmtPct(c.pooledHitRatio)) + " token-weighted", (c.missRate == null ? "n/a" : s.fmtPct(c.missRate)) + " stable-prefix miss rate", (c.missTurns || 0) + " miss turns", (c.samples || 0) + " turns with cache data", s.fmtTokens(c.cacheReadTotal || 0) + " read", s.fmtTokens(c.cacheWriteTotal || 0) + " written"]) : nothing}${table(
      ["Phase", "p50", "p95", "p99", "Turns", "Trend"],
      phases.map((p: any) => [
        stacked(s.phaseLabel(p.phase), s.phaseDesc(p.phase)),
        n(s.fmtMs(p.p50)),
        n(s.fmtMs(p.p95)),
        n(s.fmtMs(p.p99)),
        n(p.count ? Number(p.count).toLocaleString() : "n/a"),
        { node: s.sparkline(p.daily), cls: "num" },
      ]),
      "No turn metrics in this scope yet.",
      (i) => s.go({ view: "metrics", scope: s.scope, session: null, phase: phases[i].phase }),
    )}${mix()}${tp.total ? line([(tp.total ?? 0) + " runs", (tp.done ?? 0) + " done", (tp.failed ?? 0) + " failed", s.fmtPct(tp.failureRate) + " failure rate"]) : nothing}`,
  );
}
