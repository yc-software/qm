import { html, nothing } from "lit";
import { bareCard, card, denseList, renderer, node } from "./shared.ts";

export function history(root: HTMLElement, d: any, s: Record<string, any>) {
  const paint = renderer(root);
  const sessions = (d.sessions || []).filter((row: any) => s.historyKindMatches(row, s.historyKind));
  const orgWide = s.scopeKind(s.scope) === "org";
  const cron = s.historyKind === "cron" ? s.cron : null;
  const route = (extra: any) => ({
    view: "history",
    scope: s.scope,
    session: null,
    cursor: null,
    historyKind: s.historyKind,
    ...extra,
  });
  const pages =
    s.cursor || d.nextCursor
      ? html`<div class="pager">
          <button type="button" class="page" ?disabled=${!s.cursor} @click=${() => s.go(route({ cron }))}>
            ← Newest</button
          ><button
            type="button"
            class="page"
            ?disabled=${!d.nextCursor}
            @click=${() => s.go(route({ cron, cursor: d.nextCursor }))}
          >
            Older →
          </button>
        </div>`
      : nothing;
  const mode = s.historyModeLabel(s.historyKind);
  const tabs = ["conversation", "cron", "background"].map((kind) => ({
    label: s.kindLabels[kind],
    count: d.counts?.[kind],
    active: s.historyKind === kind,
    onClick: () => s.go(route({ historyKind: kind })),
  }));
  const scopes = s.scopeRows();
  const scopeFilter = node(
    html`<div class="shell-sort">
      <span class="shell-sort-label">Scope:</span
      ><select
        aria-label="Filter by scope"
        @change=${(e: Event) => s.go(route({ scope: (e.target as HTMLSelectElement).value }))}
      >
        <option value=${s.orgScope} ?selected=${orgWide}>All scopes</option>
        ${scopes.map(
          (row: any) =>
            html`<option value=${row.scopeId} ?selected=${row.scopeId === s.scope}>
              ${s.shortName(row.scopeId)}
            </option>`,
        )}
      </select>
    </div>`,
  );
  s.pageShell(
    cron
      ? {
          back: { label: "← Cron runs", onClick: () => s.go(route({})) },
          title: s.cronName(d.cron?.cron || sessions[0]?.origin?.cron, true),
          context: orgWide ? "" : s.shortName(s.scope),
        }
      : { title: orgWide ? s.title : s.shortName(s.scope), tabs, actions: [scopeFilter] },
  );
  const environment = (s.environments || []).find((e: any) => e.id === s.scope);
  const attached = environment?.attachedScopes || [];
  let errors: any[] = [];
  let errorCount = 0;
  let errorsOpen = false;
  const draw = () =>
    paint(
      html`${
        orgWide && !cron && !s.cursor && s.environments?.length
          ? card(
              "Named environments",
              "Named computers and working memory that scopes can share.",
              denseList(
                s.environments,
                (e: any) => {
                  const names = (e.attachedScopes || []).map((id: string) => s.shortName(id));
                  return {
                    name: e.name || s.shortName(e.id),
                    preview: html`<span title=${names.join(", ")}
                      >${names.length ? names.slice(0, 4).join(", ") + (names.length > 4 ? " +" + s.plural(names.length - 4, "more scope") : "") : "no scopes attached"}</span
                    >`,
                    href: s.stateToUrl(route({ scope: e.id })),
                  };
                },
                (e) => s.selectScope(e.id),
                "No named environments.",
              ),
            )
          : nothing
      }${environment && !cron ? card("Attached scopes", s.plural(attached.length, "scope") + " share this environment's computer and working memory.", html`<div class="history-empty-scopes">${attached.length ? attached.map((id: string) => html`<button type="button" class="history-empty-scope" title=${id} @click=${() => s.selectScope(id)}>${s.shortName(id)}</button>`) : html`<p class="empty">No scopes attached.</p>`}</div>`) : nothing}${bareCard(
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
                >${orgWide && row.scopeId ? html`<span class="dense-tag">${s.shortName(row.scopeId)}</span>` : nothing}${preview}</span
              >`,
              time: row.lastActivity ? s.relTime(row.lastActivity) : "—",
              href: s.stateToUrl(route({ session: row.id })),
            };
          },
          (row) => s.go(route({ session: row.id })),
          "No " + mode.toLowerCase() + (orgWide ? " yet." : " in this scope."),
        ),
      )}${pages}${
        !orgWide && !cron
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
      }`,
    );
  draw();
  if (!orgWide && !cron) {
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
