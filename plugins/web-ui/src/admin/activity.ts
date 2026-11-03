import { html, render } from "lit";
import { fieldSelect, relTime } from "../ui.ts";
import { bareCard, empty, pageHeader, pager, table, type Header } from "./shared.ts";
import { VIEW_TITLE, type AdminPage } from "./sections.ts";

type Row = Record<string, any>;
let directory: Promise<Row[]> | null = null;
let labels = new Map<string, string>();

export function scopeRows(page: AdminPage): Promise<Row[]> {
  directory ??= page.api("GET", "/api/scopes").then((r) => {
    const rows: Row[] = r.ok ? r.data?.scopes || [] : [];
    labels = new Map(rows.map((s) => [s.scopeId, s.label || ""]));
    if (!r.ok) directory = null;
    return rows;
  });
  return directory;
}

export const scopeName = (id: string) => (id?.startsWith("org:") ? "org" : labels.get(id) || id || "");

export const orgWide = (page: AdminPage) => page.scope.startsWith("org:");

export function scopeSelect(page: AdminPage, rows: Row[]) {
  const choices = rows.filter((s) => !s.scopeId.startsWith("org:"));
  if (!orgWide(page) && !choices.some((s) => s.scopeId === page.scope)) choices.unshift({ scopeId: page.scope });
  return fieldSelect({
    ariaLabel: "Filter by scope",
    value: page.scope,
    onChange: (value) => page.go(page.href(page.view, { scope: value })),
    options: html`<option value=${page.orgScope} ?selected=${orgWide(page)}>All scopes</option>
      ${choices.map(
        (s) => html`<option value=${s.scopeId} ?selected=${s.scopeId === page.scope}>${scopeName(s.scopeId)}</option>`,
      )}`,
  });
}

export const when = (ts: number) =>
  html`<span title=${ts ? new Date(ts).toLocaleString() : ""}>${ts ? relTime(ts) : "—"}</span>`;

export const plural = (n: number, one: string, many = one + "s") =>
  `${Number(n || 0).toLocaleString()} ${Number(n || 0) === 1 ? one : many}`;

export async function load(page: AdminPage, path: string, header: Header) {
  const paint = (body: unknown) => render(html`${pageHeader(header)}${body}`, page.host);
  paint(html`<div class="loadingline">Loading ${(VIEW_TITLE[page.view] || page.view).toLowerCase()}…</div>`);
  const r = await page.api("GET", path);
  if (!page.current()) return null;
  if (r.ok) return r.data ?? {};
  paint(
    empty(r.status === 403 ? "You don't administer this scope." : r.data?.message || `Failed to load (${r.status}).`),
  );
  return null;
}

const ERRORS_PAGE = 50;

export async function mount(page: AdminPage) {
  const rows = await scopeRows(page);
  if (!page.current()) return;
  const header = { actions: scopeSelect(page, rows) };
  const offset = (Math.max(1, Number(page.params.get("page")) || 1) - 1) * ERRORS_PAGE;
  const scope = "scope=" + encodeURIComponent(page.scope);
  const path =
    page.view === "errors"
      ? `/api/errors?${scope}&limit=${ERRORS_PAGE}&offset=${offset}`
      : `/api/${page.view}?${scope}`;
  const data = await load(page, path, header);
  if (!data) return;
  const [count, body] = ({ errors, audit, egress } as Record<string, typeof errors>)[page.view]!(page, data);
  render(html`${pageHeader({ ...header, count })}${body}`, page.host);
}

function errors(page: AdminPage, data: Row): [string, unknown] {
  const all = orgWide(page);
  const rows: Row[] = data.errors || [];
  const total = data.total ?? rows.length;
  const pages = pager(total, data.limit || ERRORS_PAGE, data.offset || 0, (n) =>
    page.go(page.href("errors", { scope: page.scope, page: n })),
  );
  const content = table(
    ["Category", "Code", "Message", ...(all ? ["Scope"] : []), "Session", "Time"],
    rows.map((e) => {
      const scope = /^(personal|channel|team|org|group):.+/.test(e.scopeLabel || "") ? e.scopeLabel : null;
      const text = e.message || "(no message)";
      const scopeCell = scope
        ? { node: html`<a href=${page.href("errors", { scope })}>${scopeName(scope)}</a>` }
        : e.scopeLabel || "System";
      const session = { scope: scope || page.scope, session: e.sessionId };
      return [
        e.category || "uncategorized",
        { text: e.code || "—", cls: "mono" },
        {
          node: html`<details class="error-message">
            <summary>
              <span class="error-preview">${text.split("\n")[0].slice(0, 160)}</span
              ><span class="error-full">${text}</span>
            </summary>
          </details>`,
        },
        ...(all ? [scopeCell] : []),
        e.sessionId ? { node: html`<a href=${page.href("history", session)}>View session</a>` } : "—",
        { node: when(e.ts), cls: "num" },
      ];
    }),
    all ? "No errors recorded." : "No errors recorded for this scope.",
    undefined,
    { wrapClass: "errors-table " + (all ? "errors-all" : "errors-scoped") },
  );
  return [plural(total, "error"), html`${pages}${bareCard(content)}${pages}`];
}

function audit(page: AdminPage, data: Row): [string, unknown] {
  const all = orgWide(page);
  const events: Row[] = data.events || [];
  const content = table(
    ["Admin", "Action", "Resource", ...(all ? ["Scope"] : []), "Time"],
    events.map((e) => [
      { text: e.principalId, cls: "mono" },
      {
        node: html`<span class=${/revoke|delete|deny|fail/.test(String(e.action || "")) ? "flag-err" : "subline"}
          >${e.action || "event"}</span
        >`,
      },
      { text: e.status ? e.resource + " (" + e.status + ")" : e.resource || "", cls: "mono" },
      ...(all ? [scopeName(e.scopeLabel)] : []),
      { node: when(e.ts), cls: "num" },
    ]),
    all ? "No admin activity yet." : "No admin activity for this scope.",
  );
  return [plural(events.length, "event"), bareCard(content)];
}

function egressDetail(r: Row) {
  const bits =
    r.source === "broker"
      ? [r.slug && "cred:" + r.slug, r.upstreamStatus != null && "↑" + r.upstreamStatus]
      : [r.via, r.port != null && ":" + r.port, r.peerIp];
  return bits.filter(Boolean).join(" · ") || "None";
}

function egressStatus(r: Row) {
  const denied = r.allowed === false;
  const tone = (denied && "flag-warn") || (r.status === "error" ? "flag-err" : "subline");
  return html`<span class=${tone}
    >${denied ? r.status || "denied" : (r.status !== "ok" && r.status) || "allowed"}</span
  >`;
}

function egress(page: AdminPage, data: Row): [string, unknown] {
  const all = orgWide(page);
  const rows: Row[] = data.records || [];
  const sources = data.bySource || {};
  const count = [
    plural(data.total ?? rows.length, "call"),
    plural(data.denied ?? 0, "denied request"),
    plural(data.hosts ?? 0, "host"),
    plural(sources.broker ?? 0, "broker request"),
    plural(sources.firewall ?? 0, "firewall request"),
  ].join(" · ");
  const content = table(
    ["Host", "Status", "Source", ...(all ? ["Scope"] : []), "Principal", "Detail", "Time"],
    rows.map((r) => [
      { text: r.host, cls: "mono" },
      { node: egressStatus(r) },
      { node: html`<span class="subline">${r.source || "firewall"}</span>` },
      ...(all ? [scopeName(r.scopeLabel)] : []),
      { text: r.principalId || "None", cls: "mono" },
      { text: egressDetail(r), cls: "mono" },
      { node: when(r.ts), cls: "num" },
    ]),
    "No egress in this scope yet.",
  );
  return [count, bareCard(content)];
}
