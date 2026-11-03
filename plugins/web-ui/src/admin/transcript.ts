import { html, nothing, render } from "lit";
import { markdown } from "../message-markdown.ts";
import { formatMessageTime } from "../message-time.ts";
import { relTime } from "../ui.ts";
import { pageHeader } from "./shared.ts";
import type { AdminPage } from "./sections.ts";
import { loadScopes, shortName } from "./history.ts";

type Row = Record<string, any>;

const PAGE_SIZE = 500;

function payloadText(payload: unknown): string {
  if (payload == null) return "";
  if (typeof payload === "string") return payload;
  const p = payload as Row;
  if (typeof p.text === "string") return p.text;
  if (typeof p.thinking === "string") return p.thinking || (p.redacted ? "[redacted thinking]" : "");
  return JSON.stringify(payload, null, 2);
}

function units(data: Row) {
  const entries: Row[] = data.entries || [];
  const results = new Map<string, Row>();
  for (const e of entries)
    if (e.type === "tool_result" && e.payload?.callId && !results.has(e.payload.callId))
      results.set(e.payload.callId, e);
  const paired = new Set<Row>();
  const out: Row[] = [];
  for (const e of entries) {
    if (paired.has(e)) continue;
    const result = e.type === "tool_call" ? results.get(e.payload?.callId) : undefined;
    if (result) paired.add(result);
    out.push({ entry: e, result, at: e.createdAt || 0 });
  }
  for (const event of data.deliveryEvents || []) out.push({ event, at: event.createdAt || 0 });
  return out.sort((a, b) => a.at - b.at);
}

const head = (label: unknown, at: number, extra: unknown = nothing) =>
  html`<span class="entry-label">${label}</span>${extra}<span class="when">${formatMessageTime(at)}</span>`;

function unit(u: Row, session: Row) {
  if (u.event) {
    const e = u.event;
    const surface = e.destination?.type === "slack" ? "Slack" : e.destination?.type || "Delivery";
    let label = e.origin?.label || "Delivery event";
    if (e.type === "outbound_delivery") label = `${surface} delivery`;
    if (e.shadow) label = "Shadow delivery";
    const lines = [
      e.destination?.onBehalfOf && "from " + e.destination.onBehalfOf,
      e.destination?.target && "to " + e.destination.target,
      e.text,
    ];
    return html`<details class="entry delivery-event-entry">
      <summary class="who">
        ${head(label, e.createdAt, e.expiredAt ? html`<span class="entry-label">never sent</span>` : nothing)}
      </summary>
      <pre>${lines.filter(Boolean).join("\n")}</pre>
    </details>`;
  }
  const e = u.entry;
  const text = payloadText(e.payload);
  if (e.type === "user" || e.type === "assistant") {
    const label =
      e.type === "assistant"
        ? "Assistant"
        : e.payload?.name || (session.origin && e === session.first ? session.origin.label : "User");
    return html`<div class=${"entry message-entry " + e.type + "-entry"}>
      <div class="who">${head(label, e.createdAt, html`<span class="when">#${e.seq}</span>`)}</div>
      <div class="message-body">${markdown(text)}</div>
    </div>`;
  }
  const label =
    e.type === "tool_call"
      ? String(e.payload?.tool || e.payload?.name || "tool") +
        (u.result ? (u.result.payload?.error && " · error") || "" : " · pending result")
      : String(e.type || "entry").replaceAll("_", " ");
  return html`<details
    class=${"entry " + ({ thinking: "thinking-entry", system: "system-entry" }[e.type as string] ?? "tool-entry")}
  >
    <summary class="who">${head(label, e.createdAt)}</summary>
    <pre>${text}</pre>
    ${u.result ? html`<pre>${payloadText(u.result.payload)}</pre>` : nothing}
  </details>`;
}

export async function mount(page: AdminPage) {
  const id = page.session!;
  const limit = Number(page.params.get("limit")) || PAGE_SIZE;
  const back = pageHeader({ back: { label: "Conversations", href: page.href("history") }, title: "Conversation" });
  render(
    html`${back}
      <div class="detail">Loading…</div>`,
    page.host,
  );
  const query = "scope=" + encodeURIComponent(page.scope);
  const [result, errors] = await Promise.all([
    page.api("GET", "/api/sessions/" + encodeURIComponent(id) + "?" + query + "&limit=" + limit),
    page.api("GET", "/api/errors?" + query + "&sessionId=" + encodeURIComponent(id)),
    loadScopes(page),
  ]);
  if (!page.current()) return;
  if (!result.ok)
    return render(
      html`${back}
        <div class="detail">${result.data?.message || `Failed to load transcript (${result.status}).`}</div>`,
      page.host,
    );
  const data = result.data;
  const session = { ...data.session, origin: data.hasMore ? null : data.origin };
  session.first = (data.entries || []).find((e: Row) => e.type === "user");
  const scope = session.scopeId || page.scope;
  const list = units(data);
  const errorRows: Row[] = errors.ok ? errors.data?.errors || [] : [];
  render(
    html`${pageHeader({
        back: {
          label: "Conversations",
          href: page.href("history", { scope: scope.startsWith("org:") ? null : scope }),
        },
        title: data.origin?.label || "Conversation",
        context: shortName(scope) + (session.createdAt ? " · created " + relTime(session.createdAt) : ""),
      })}
      <div class="detail">
        ${
          errorRows.length
            ? html`<div class="error-strip">
                <div class="error-strip-head">
                  ${errorRows.length} error${errorRows.length === 1 ? "" : "s"} logged in this session
                </div>
                ${errorRows
                  .slice(0, 5)
                  .map(
                    (e) =>
                      html`<div class="error-strip-row">
                        <span class="mono" title=${e.message || ""}
                          >${String(e.message || "(no message)").split("\n")[0]}</span
                        ><span class="subline"
                          >${[e.category || "uncategorized", e.code, relTime(e.ts)].filter(Boolean).join(" · ")}</span
                        >
                      </div>`,
                  )}
              </div>`
            : nothing
        }
        ${
          list.length
            ? html`<div class="transcript-stream">
                ${data.hasMore ? html`<a class="load-earlier more" href=${page.href("history", { limit: limit * 4 }, "/s/" + encodeURIComponent(id))}>Load earlier messages</a>` : nothing}
                ${list.map((u) => unit(u, session))}
              </div>`
            : html`<p class="empty">No entries.</p>`
        }
      </div>`,
    page.host,
  );
  if (!page.params.get("limit")) page.host.lastElementChild?.scrollIntoView({ block: "end" });
}
