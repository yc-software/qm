import { html, nothing, render } from "lit";
import { relTime } from "../ui.ts";
import { badge, denseList, empty, pageHeader, type Header } from "./shared.ts";
import type { AdminPage } from "./sections.ts";

type Row = Record<string, any>;
let containers: Promise<Row[]> | null = null;
let known: Row[] = [];

function label(id: string) {
  const c = known.find((x) => x.container === id) || {};
  if (c.kind === "dm") return c.name || id;
  if (c.kind === "group") return c.name || ((c.members || []).length ? c.members.length + " people" : id);
  return c.name ? "#" + c.name : id;
}

function containerScope(id: string) {
  const kind = known.find((x) => x.container === id)?.kind;
  return kind === "channel" || kind === "group" ? kind + ":" + id : null;
}

const judgmentBadge = (decision: string) =>
  (decision === "act" && badge("woke", "ok")) ||
  (decision === "ignore" ? badge("silent", "muted") : badge("fastlane", "accent"));

function ackTag(name: string, icon?: string, accent = false) {
  const title = ":" + name + ":";
  if (icon && /^https?:\/\//.test(icon))
    return html`<img class=${"ack-emoji-img" + (accent ? " accent" : "")} src=${icon} alt=${title} title=${title} />`;
  return icon
    ? html`<span class=${"ack-emoji-glyph" + (accent ? " accent" : "")} title=${title}>${icon}</span>`
    : html`<span class=${"pill" + (accent ? " accent" : "")}>${name ? title : "None"}</span>`;
}

const ackBadge = (r: Row) => (r.outcome === "picked" ? ackTag(r.picked, r.icon) : badge("declined", "muted"));

const slackHref = (workspace: string, container: string, ts: string) =>
  workspace && container?.startsWith("C") && ts
    ? workspace.replace(/\/$/, "") + "/archives/" + container + "/p" + ts.replace(".", "")
    : null;

const meta = (item: Row) =>
  [item.model, item.latencyMs != null && item.latencyMs + "ms", new Date(item.createdAt).toLocaleString()]
    .filter(Boolean)
    .join(" · ");

export async function mount(page: AdminPage) {
  const ack = page.view === "ackemoji";
  const paint = (header: Header, body: unknown) =>
    page.current() && render(html`${pageHeader(header)}${body}`, page.host);
  const title = ack ? "Ack emoji" : "Judgments";
  paint({}, html`<div class="loadingline">${ack ? "Loading ack-emoji picks…" : "Loading judgments…"}</div>`);
  containers ??= page.api("GET", "/api/slack-mirror").then((r) => (known = (r.ok && r.data?.containers) || []));
  await containers;
  const p = (key: string) => page.params.get(key);
  const jid = p("jid");
  if (jid) return detail(page, ack, jid, paint);
  const decision = p("decision") || (ack ? null : "act,ignore");
  const container = p("container");
  const path = ack
    ? "/api/ack-emoji-picks?" +
      (decision ? "outcome=" + encodeURIComponent(decision) : "") +
      (container ? "&container=" + encodeURIComponent(container) : "")
    : "/api/ambient-judgments?decision=" +
      encodeURIComponent(decision!) +
      (container ? "&container=" + encodeURIComponent(container) : "");
  const result = await page.api("GET", path);
  if (!page.current()) return;
  if (!result.ok) {
    const denied = ack
      ? "Only an org admin can read ack-emoji picks."
      : "Only an org admin can read ambient judgments.";
    return paint(
      {},
      empty(result.status === 403 ? denied : result.data?.message || `Failed to load (${result.status}).`),
    );
  }
  const counts = result.data.counts || {};
  const tabs = ack
    ? [
        [null, "All", ["picked", "declined"]],
        ["picked", "Picked", ["picked"]],
        ["declined", "Declined", ["declined"]],
      ]
    : [
        ["act,ignore", "Judged", ["act", "ignore"]],
        ["act", "Woke", ["act"]],
        ["ignore", "Silent", ["ignore"]],
        ["fastlane", "Fastlane", ["fastlane"]],
      ];
  const header: Header = {
    title,
    ...(container ? { back: { label: title, href: page.href(page.view) }, context: label(container) } : {}),
    ...(ack && !container ? { back: { label: "Judgments", href: page.href("judgments") } } : {}),
    tabs: (tabs as [string | null, string, string[]][]).map(([key, text, keys]) => ({
      label: text,
      count: keys.reduce((n, k) => n + (counts[k] || 0), 0),
      active: key === decision,
      href: page.href(page.view, { container, decision: key === "act,ignore" ? null : key }),
    })),
    actions: ack ? nothing : html`<a class="link" href=${page.href("ackemoji")}>Ack emoji →</a>`,
  };
  let rows: Row[] = result.data[ack ? "picks" : "judgments"] || [];
  let [hasMore, busy, error] = [!!result.data.hasMore, false, ""];
  const target = (r: Row) => page.href(page.view, { container, decision: p("decision"), jid: String(r.id) });
  const row = (r: Row) => ({
    name: label(ack ? r.channel : r.container),
    preview: html`<span class="badges"
      >${ack ? ackBadge(r) : judgmentBadge(r.decision)}<span class=${ack ? "pill" : "pill judgment-reason"}
        >${ack ? r.message || "None" : r.reason || (r.decision === "fastlane" ? "@mention, routed past the judge" : "None")}</span
      >${r.latencyMs != null ? html`<span class="dense-time">${r.latencyMs + "ms"}</span>` : nothing}</span
    >`,
    time: relTime(r.createdAt),
    href: target(r),
  });
  const earlier = async () => {
    if (busy) return;
    const last = rows[rows.length - 1]!;
    busy = true;
    draw();
    const more = await page.api(
      "GET",
      path + "&before=" + encodeURIComponent(last.createdAt) + "&beforeId=" + encodeURIComponent(last.id),
    );
    if (!page.current()) return;
    busy = false;
    if (more.ok) {
      rows = [...rows, ...(more.data[ack ? "picks" : "judgments"] || [])];
      hasMore = !!more.data.hasMore;
    } else error = more.data?.message || "Failed to load earlier entries.";
    draw();
  };
  const draw = () =>
    paint(
      header,
      rows.length
        ? html`${denseList(rows, row, (r) => page.go(target(r)), "")}${
            hasMore
              ? html`<button type="button" class="load-earlier more" ?disabled=${busy} @click=${earlier}>
                  ${ack ? "Load earlier picks" : "Load earlier judgments"}
                </button>`
              : nothing
          }${error ? empty(error) : nothing}`
        : empty(
            ack ? "No ack-emoji picks recorded for this filter yet." : "No judgments recorded for this filter yet.",
          ),
    );
  draw();
}

async function detail(page: AdminPage, ack: boolean, jid: string, paint: (h: Header, body: unknown) => unknown) {
  const title = ack ? "Ack emoji" : "Judgment";
  const params = { container: page.params.get("container"), decision: page.params.get("decision") };
  const back = { label: ack ? "Ack emoji" : "Judgments", href: page.href(page.view, params) };
  const result = await page.api(
    "GET",
    (ack ? "/api/ack-emoji-picks?id=" : "/api/ambient-judgments?id=") + encodeURIComponent(jid),
  );
  if (!page.current()) return;
  if (!result.ok) return paint({ back, title }, empty(result.data?.message || `Failed to load (${result.status}).`));
  const item = result.data[ack ? "pick" : "judgment"];
  const container = ack ? item.channel : item.container;
  const href = slackHref(result.data.workspaceUrl, container, ack ? item.ts : item.tsFrom);
  const scope = containerScope(container);
  const header = {
    back,
    title,
    context: label(container),
    actions:
      !ack && scope ? html`<a class="link" href=${page.href("governance", { scope })}>Governance →</a>` : nothing,
  };
  const open = href
    ? html`<a href=${href} target="_blank" rel="noopener" class="judg-extlink">Open in Slack ↗</a>`
    : nothing;
  if (ack)
    return paint(
      header,
      html`<div class="detail judg-detail">
        <div class="judg-decision">
          <div class="badges">${ackBadge(item)}<span class="subline">${meta(item)}</span>${open}</div>
        </div>
        <div class="judg-pane-title">Message</div>
        <div class="judg-prompt"><pre>${item.message || "(not recorded)"}</pre></div>
        <div class="judg-pane-title">Candidate slate</div>
        <div class="badges">
          ${
            (item.candidates || "").trim()
              ? item.candidates
                  .split(" ")
                  .filter(Boolean)
                  .map((name: string) => ackTag(name, undefined, name === item.picked))
              : empty("(candidate slate not recorded)")
          }
        </div>
      </div>`,
    );
  const reason =
    item.reason ||
    (item.decision === "ignore" && "Stayed silent.") ||
    (item.decision === "fastlane" ? "@mention, routed past the judge." : "None");
  const prompt =
    item.prompt ||
    (item.decision === "fastlane"
      ? "Routed past the judge (formal @mention). No prompt was rendered."
      : "(prompt not recorded)");
  paint(
    header,
    html`<div class="detail judg-detail">
      <div class="judg-decision">
        <div class="badges">
          ${judgmentBadge(item.decision)}${item.askedBy ? badge("asked by " + item.askedBy, "accent") : nothing}<span
            class="subline"
            >${meta(item)}</span
          >${open}
        </div>
        <p>${reason}</p>
      </div>
      <div class="judg-pane-title">Judge context</div>
      <div class="judg-prompt"><pre>${prompt}</pre></div>
    </div>`,
  );
}
