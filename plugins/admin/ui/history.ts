import { html, nothing } from "lit";
import { bareCard, card, denseList, pager, renderer, node } from "./shared.ts";

export function history(root: HTMLElement, d: any, s: Record<string, any>) {
  const paint = renderer(root);
  const sessions = (d.sessions || []).filter((row: any) => s.historyKindMatches(row, s.historyKind));
  const counts = d.totalByCategory || {};
  const types = d.totalByType || d.byType || {};
  const cronCount = types.cron ?? types.cron_wake ?? types.cron_monologue ?? 0;
  const count = (kind: string) => {
    if (kind === "conversation") return counts.conversation ?? 0;
    if (kind === "cron") return d.distinctCrons ?? cronCount;
    if (kind === "background") return Math.max(0, (counts.background ?? 0) - cronCount);
    return d.total ?? sessions.length;
  };
  const cron = s.historyKind === "cron" ? s.cron : null;
  const total = (cron ? d.total : count(s.historyKind)) || sessions.length;
  const limit = d.limit || s.pageSize;
  const offset = d.offset || 0;
  s.correctPage(Math.floor(offset / limit) + 1, cron);
  const route = (extra: any) => ({
    view: "history",
    scope: s.scope,
    session: null,
    page: 1,
    historyKind: s.historyKind,
    ...extra,
  });
  const mode = s.historyModeLabel(s.historyKind);
  const tabs = [
    "conversation",
    "cron",
    ...(count("background") > 0 || s.historyKind === "background" ? ["background"] : []),
  ].map((kind) => ({
    label: s.kindLabels[kind],
    count: count(kind) || 0,
    active: s.historyKind === kind,
    onClick: () => s.go(route({ historyKind: kind })),
  }));
  s.pageShell(
    cron
      ? {
          back: { label: "← Crons", onClick: () => s.go(route({})) },
          title: s.cronName(d.cron?.cron || sessions[0]?.origin?.cron, true),
          context: s.scopeKind(s.scope) !== "org" ? s.shortName(s.scope) : "",
          count: s.plural(total, "fire"),
        }
      : {
          back:
            s.scopeKind(s.scope) !== "org"
              ? { label: "← Sessions", onClick: () => s.go(route({ scope: s.orgScope })) }
              : undefined,
          title: s.scopeKind(s.scope) !== "org" ? s.shortName(s.scope) : s.title,
          tabs,
        },
  );
  const environment = (s.environments || []).find((e: any) => e.id === s.scope);
  const attached = environment?.attachedScopes || [];
  let errors: any[] = [];
  let errorCount = 0;
  let errorsOpen = false;
  const draw = () =>
    paint(
      html`${environment && !cron ? card("Attached scopes", s.plural(attached.length, "scope") + " share this environment's computer and working memory.", html`<div class="history-empty-scopes">${attached.length ? attached.map((id: string) => html`<button type="button" class="history-empty-scope" title=${id} @click=${() => s.selectScope(id)}>${s.shortName(id)}</button>`) : html`<p class="empty">No scopes attached.</p>`}</div>`) : nothing}${
        s.historyKind === "cron" && !cron
          ? bareCard(
              denseList(
                d.crons || [],
                (c: any) => ({
                  name: s.cronName(c.origin?.cron, true),
                  preview: html`<span
                    >${s.plural(c.sessions || 0, "fire") + (typeof c.deliveredRuns === "number" ? " · " + Number(c.deliveredRuns).toLocaleString() + " delivered" : "") + " · first fired " + s.fmtHistoryCreated(c.createdAt, c.lastActivity)}</span
                  >`,
                  time: c.lastActivity ? s.relTime(c.lastActivity) : "—",
                  cls: typeof c.deliveredRuns === "number" && !c.deliveredRuns ? "history-silent" : "",
                  href: s.stateToUrl(route({ cron: c.cronId })),
                }),
                (c) => s.go(route({ cron: c.cronId })),
                "No crons in this scope.",
              ),
            )
          : html`${bareCard(
              denseList(
                sessions,
                (row: any) => {
                  const origin = row.origin?.kind === "cron" ? row.origin.cron : null;
                  const background = row.category === "background";
                  let name = row.firstMessage || row.lastMessage || "(no messages yet)";
                  let preview = "";
                  if (background && !cron) {
                    const kind = row.kind || row.type;
                    let typeLabel = s.titleCase(String(kind).replaceAll("_", " "));
                    if (kind === "dm") typeLabel = "DM";
                    if (["cron_monologue", "cron_wake", "cron"].includes(kind)) typeLabel = "Cron";
                    name = origin ? s.cronName(origin, true) : row.origin?.label || typeLabel;
                    preview = row.result || row.lastMessage || row.firstMessage || "";
                  } else if (background && row.result) {
                    name = row.result;
                    if (row.lastMessage && row.lastMessage !== row.result) preview = row.lastMessage;
                  } else if (row.lastMessage && row.lastMessage !== name) preview = row.lastMessage;
                  return {
                    name,
                    preview: html`<span
                      >${background && typeof row.delivered === "number" && row.delivered > 0 ? html`<span class="delivery-chip">${row.delivered > 1 ? "✓ delivered ×" + row.delivered : "✓ delivered"}</span>` : nothing}${preview}</span
                    >`,
                    time: row.lastActivity ? s.relTime(row.lastActivity) : "—",
                    cls: background && typeof row.delivered === "number" && !row.delivered ? "history-silent" : "",
                    href: s.stateToUrl(route({ session: row.id })),
                  };
                },
                (row) => s.go(route({ session: row.id })),
                "No " + mode.toLowerCase() + " in this scope.",
              ),
            )}${pager(total, limit, offset, (page) => s.go(route({ page, cron })))}${
              s.scopeKind(s.scope) !== "org" && !cron
                ? html`<div>
                    ${
                      errorCount && errors.length
                        ? html`<div class="statline">
                              <a
                                href="#"
                                @click=${(e: Event) => {
                                  e.preventDefault();
                                  errorsOpen = !errorsOpen;
                                  draw();
                                }}
                                >${s.plural(errorCount, "error")} logged in this scope</a
                              >
                            </div>
                            ${errorsOpen ? s.errorStripBox(errors, "Most recent errors", 20, (e: any) => (e.sessionId ? { href: s.stateToUrl(route({ session: e.sessionId })), go: () => s.go(route({ session: e.sessionId })) } : null)) : nothing}`
                        : nothing
                    }
                  </div>`
                : nothing
            }`
      }`,
    );
  draw();
  if (s.scopeKind(s.scope) !== "org" && !cron) {
    const query = "scope=" + encodeURIComponent(s.scope);
    void Promise.all([s.adminErrorCount(query), s.adminErrors(query)])
      .then(([count, rows]) => {
        errorCount = count;
        errors = rows;
        draw();
      })
      .catch(() => {});
  }
}

export function scopeIndex(root: HTMLElement, s: Record<string, any>) {
  const paint = renderer(root);
  if (!s.ready) {
    s.pageShell({ title: s.title });
    paint(html`<div class="loadingline">${s.note}</div>`);
    return;
  }
  const active = s.rows.filter((r: any) => (r.sessions || 0) > 0 || (r.backgroundSessions || 0) > 0);
  const quiet = s.rows.filter((r: any) => !(r.sessions || 0) && !(r.backgroundSessions || 0));
  if (s.sort === "human")
    active.sort(
      (a: any, b: any) =>
        (b.lastConversationActivity || 0) - (a.lastConversationActivity || 0) ||
        (b.sessions || 0) - (a.sessions || 0) ||
        (b.lastActivity || 0) - (a.lastActivity || 0) ||
        a.scopeId.localeCompare(b.scopeId),
    );
  s.pageShell({
    title: s.title,
    count: s.plural(active.length, "active scope"),
    actions: [node(html`<div class="shell-sort"><span class="shell-sort-label">Sort:</span>${s.sortControl()}</div>`)],
  });
  const route = (scope: string) => ({ view: "history", scope, historyKind: s.historyKind });
  paint(
    html`${
      s.environments.length
        ? card(
            "Named environments",
            "Named computers and working memory that scopes can share.",
            denseList(
              s.environments,
              (e: any) => {
                const attached = e.attachedScopes || [];
                const names = attached.map((id: string) => s.shortName(id));
                const label = !names.length
                  ? "no scopes attached"
                  : names.slice(0, 4).join(", ") +
                    (names.length > 4 ? " +" + s.plural(names.length - 4, "more scope") : "");
                return {
                  name: e.name || s.shortName(e.id),
                  preview: html`<span title=${attached.length ? names.join(", ") : ""}>${label}</span>`,
                  href: s.stateToUrl(route(e.id)),
                };
              },
              (e) => s.selectScope(e.id),
              "No named environments.",
            ),
          )
        : nothing
    }${card(
      "Conversations by person or channel",
      "",
      denseList(
        active,
        (row: any) => {
          const time = s.sort === "human" ? row.lastConversationActivity || 0 : row.lastActivity || 0;
          return {
            name: s.shortName(row.scopeId),
            preview: html`<span
              ><span class="dense-tag">${s.sessionCountsLabel(row.sessions || 0, row.backgroundSessions || 0)}</span
              >${row.environmentAttachment ? html`<span class="dense-tag" title="This scope is attached to a named environment.">${"env: " + (row.environmentAttachment.environmentName || s.shortName(row.environmentAttachment.environmentId))}</span>` : nothing}${row.lastMessage || ""}</span
            >`,
            time: time ? s.relTime(time) : "Never",
            href: s.stateToUrl(route(row.scopeId)),
          };
        },
        (row) => s.selectScope(row.scopeId),
        s.rows.length ? "No conversations yet." : "No scopes yet. Nobody has talked to the agent.",
      ),
    )}${
      quiet.length
        ? html`<details class="history-quiet">
            <summary>${quiet.length} known scope${quiet.length === 1 ? "" : "s"} without conversations</summary>
            <div class="history-empty-scopes">
              ${quiet.map((row: any) => html`<button type="button" class="history-empty-scope" @click=${() => s.selectScope(row.scopeId)}>${s.scopeTitle(row.scopeId)}</button>`)}
            </div>
          </details>`
        : nothing
    }`,
  );
}
