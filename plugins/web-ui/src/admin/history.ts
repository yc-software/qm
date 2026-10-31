import { html, nothing, render } from "lit";
import { fieldSelect, relTime } from "../ui.ts";
import { bareCard, denseList, pageHeader } from "./shared.ts";
import type { AdminPage } from "./sections.ts";
import * as transcript from "./transcript.ts";

type Row = Record<string, any>;

const KIND_LABEL: Record<string, string> = {
  conversation: "Conversations",
  cron: "Cron runs",
  background: "Background",
};
const PAGE_SIZE = 50;
let scopes: Row[] | null = null;

export const loadScopes = (page: AdminPage) =>
  scopes ? null : page.api("GET", "/api/scopes").then((r) => (scopes = r.ok ? r.data?.scopes || [] : null));

const scopeKind = (id: string) => String(id || "").split(":")[0] || "scope";

export function shortName(id: string) {
  if (!id) return "";
  const kind = scopeKind(id);
  if (kind === "org") return "org";
  const label = scopes?.find((row) => row.scopeId === id)?.label;
  if (label) return label;
  const rest = id.slice(kind.length + 1);
  if (kind === "channel" || kind === "group") return rest.startsWith("#") ? rest : "#" + rest;
  if (kind === "personal") {
    const local = rest.split("@")[0]!;
    return /^[a-z]/.test(local) ? local[0]!.toUpperCase() + local.slice(1) : local || rest;
  }
  return rest || id;
}

export function cronName(cron: Row | null | undefined) {
  if (!cron) return "Cron";
  return (
    cron.title ||
    cron.message ||
    String(cron.action || "")
      .split("\n")[0]!
      .slice(0, 96) ||
    "Cron " + cron.id
  );
}

const matchesKind = (row: Row, kind: string) => {
  if (kind === "conversation") return row.category !== "background";
  if (kind === "cron") return row.origin?.kind === "cron";
  return row.category === "background" && row.origin?.kind !== "cron";
};

function background(row: Row) {
  if (row.origin?.kind === "cron") return cronName(row.origin.cron);
  const kind = String(row.kind || row.type);
  if (row.origin?.label) return row.origin.label;
  if (kind === "dm") return "DM";
  if (["cron_monologue", "cron_wake", "cron"].includes(kind)) return "Cron";
  return kind.replaceAll("_", " ").replace(/\b\w/g, (m) => m.toUpperCase());
}

function rowOf(row: Row, orgWide: boolean, cron: string | null) {
  let name = row.firstMessage || row.lastMessage || "(no messages yet)";
  let preview = "";
  if (row.category === "background" && !cron) {
    name = background(row);
    preview = row.result || row.lastMessage || row.firstMessage || "";
  } else if (row.category === "background" && row.result) {
    name = row.result;
    if (row.lastMessage && row.lastMessage !== row.result) preview = row.lastMessage;
  } else if (row.lastMessage && row.lastMessage !== name) preview = row.lastMessage;
  const tag = orgWide && row.scopeId ? html`<span class="dense-tag">${shortName(row.scopeId)}</span>` : nothing;
  return {
    name,
    preview: html`<span>${tag}${preview}</span>`,
    time: row.lastActivity ? relTime(row.lastActivity) : "—",
  };
}

export async function mount(page: AdminPage) {
  if (page.session) return transcript.mount(page);
  const kind = KIND_LABEL[page.params.get("kind") ?? ""] ? page.params.get("kind")! : "conversation";
  const cron = kind === "cron" ? page.params.get("cron") : null;
  const cursor = page.params.get("cursor");
  const orgWide = scopeKind(page.scope) === "org";
  const list = (extra: Row = {}) =>
    page.href("history", {
      scope: orgWide ? null : page.scope,
      kind: kind === "conversation" ? null : kind,
      cron,
      ...extra,
    });
  const session = (id: string) => page.href("history", {}, "/s/" + encodeURIComponent(id));
  let path = `/api/sessions?scope=${encodeURIComponent(page.scope)}&limit=${PAGE_SIZE}`;
  path += `&category=${kind === "conversation" ? kind : "background"}`;
  if (cursor) path += `&cursor=${encodeURIComponent(cursor)}`;
  if (kind === "cron") path += "&origin=cron" + (cron ? `&cron=${encodeURIComponent(cron)}` : "");
  if (kind === "background") path += "&origin=other_background";
  const draw = (d: Row | null, body: unknown) => {
    const sessions: Row[] = (d?.sessions || []).filter((row: Row) => matchesKind(row, kind));
    const options = (scopes || []).filter((row) => scopeKind(row.scopeId) !== "org");
    if (!orgWide && !options.some((row) => row.scopeId === page.scope)) options.unshift({ scopeId: page.scope });
    const header = cron
      ? pageHeader({
          back: { label: "Cron runs", href: list({ cron: null }) },
          title: cronName(d?.cron?.cron || sessions[0]?.origin?.cron),
          context: orgWide ? "" : shortName(page.scope),
        })
      : pageHeader({
          tabs: Object.entries(KIND_LABEL).map(([key, label]) => ({
            label,
            count: d?.counts?.[key],
            active: key === kind,
            href: list({ kind: key === "conversation" ? null : key, cron: null }),
          })),
          actions: fieldSelect({
            ariaLabel: "Filter by scope",
            value: orgWide ? page.orgScope : page.scope,
            onChange: (next) => page.go(list({ scope: scopeKind(next) === "org" ? null : next, cron: null })),
            options: html`<option value=${page.orgScope} ?selected=${orgWide}>All scopes</option>
              ${options.map(
                (row) =>
                  html`<option value=${row.scopeId} ?selected=${row.scopeId === page.scope}>
                    ${shortName(row.scopeId)}
                  </option>`,
              )}`,
          }),
        });
    const rows = d
      ? html`${bareCard(
          denseList(
            sessions,
            (row: Row) => ({ ...rowOf(row, orgWide, cron), href: session(row.id) }),
            (row: Row) => page.go(session(row.id)),
            "No " + KIND_LABEL[kind]!.toLowerCase() + (orgWide ? " yet." : " in this scope."),
          ),
        )}${
          cursor || d.nextCursor
            ? html`<div class="pager">
                <button type="button" class="btn compact page" ?disabled=${!cursor} @click=${() => page.go(list())}>
                  ← Newest</button
                ><button
                  type="button"
                  class="btn compact page"
                  ?disabled=${!d.nextCursor}
                  @click=${() => page.go(list({ cursor: d.nextCursor }))}
                >
                  Older →
                </button>
              </div>`
            : nothing
        }`
      : nothing;
    render(html`${header}${body ?? rows}`, page.host);
  };
  draw(null, html`<p class="empty">Loading…</p>`);
  const [result] = await Promise.all([page.api("GET", path), loadScopes(page)]);
  if (!page.current()) return;
  if (!result.ok)
    return draw(
      null,
      html`<p class="empty">${result.data?.message || `Failed to load sessions (${result.status}).`}</p>`,
    );
  draw(result.data, null);
}
