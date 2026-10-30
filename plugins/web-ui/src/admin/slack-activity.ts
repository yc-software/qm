import { html, nothing } from "lit";
import { repeat } from "lit/directives/repeat.js";
import { badge, renderer } from "./shared.ts";
import type { Api } from "./integrations-state.ts";
type Row = Record<string, any>;
type Context = {
  api: Api;
  go: (state: Row) => void;
  stateToUrl: (state: Row) => string;
  pageShell: (state: Row) => void;
  navLink: (label: string, state: Row) => Node;
  relTime: (value: string) => string;
  fmtTime: (value: string) => string;
  slackContainerLabel: (id: string) => string;
  slackContainerScope: (id: string) => string | null;
  loadSlackContainers: () => ReturnType<Api>;
  containers: () => Row[] | null;
  view: () => string;
};
let context: Context;
export function configure(value: Context) {
  context = value;
}
const empty = (text: string) => html`<p class="empty">${text}</p>`;
const loading = (text: string) => html`<div class="loadingline">${text}</div>`;
function dense(items: Row[], rowOf: (item: Row) => Row, onOpen: (item: Row) => void, emptyText: string) {
  if (!items.length) return empty(emptyText);
  return html`<div class="dense-list">
    ${repeat(
      items,
      (it) => it.id || it.container,
      (it) => {
        const row = rowOf(it);
        return html`<a
          class="dense-row"
          href=${row.href}
          @click=${(event: MouseEvent) => {
            if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
            event.preventDefault();
            onOpen(it);
          }}
          ><span class="dense-name">${row.name}</span><span class="dense-preview">${row.preview}</span
          ><span class="dense-time">${row.time}</span></a
        >`;
      },
    )}
  </div>`;
}
function judgmentBadge(decision: string) {
  if (decision === "act") return badge("woke", "ok");
  return decision === "ignore" ? badge("silent", "muted") : badge("fastlane", "accent");
}
function ackBadge(row: Row) {
  return row.outcome === "picked" ? ackTag(row.picked, row.icon) : badge("declined", "muted");
}
function judgmentReason(item: Row) {
  if (item.reason) return item.reason;
  if (item.decision === "ignore") return "Stayed silent.";
  return item.decision === "fastlane" ? "@mention, routed past the judge." : "None";
}

function ackTag(name: string, icon?: string, accent = false) {
  if (icon && /^https?:\/\//.test(icon))
    return html`<img
      class=${"ack-emoji-img" + (accent ? " accent" : "")}
      src=${icon}
      alt=${":" + name + ":"}
      title=${":" + name + ":"}
    />`;
  return icon
    ? html`<span class=${"ack-emoji-glyph" + (accent ? " accent" : "")} title=${":" + name + ":"}>${icon}</span>`
    : html`<span class=${"pill" + (accent ? " accent" : "")}>${name ? ":" + name + ":" : "None"}</span>`;
}
function slackHref(workspace: string, container: string, ts: string) {
  return workspace && container?.startsWith("C") && ts
    ? workspace.replace(/\/$/, "") + "/archives/" + container + "/p" + ts.replace(".", "")
    : null;
}
export class SlackActivity {
  generation = 0;
  state: Row = {};
  rows: Row[] = [];
  hasMore = false;
  busy = false;
  error = "";
  draw: (value: unknown) => void = () => {};
  root!: HTMLElement;
  current(view: string, generation = this.generation) {
    return generation === this.generation && context.view() === view;
  }
  begin(state: Row) {
    this.generation++;
    this.state = state;
    this.rows = [];
    this.hasMore = false;
    this.busy = false;
    this.error = "";
    this.root = document.getElementById("view-data")!;
    this.root.replaceChildren();
    this.draw = renderer(this.root);
    return this.generation;
  }
  async log(st: Row, kind: "judgments" | "ackemoji") {
    const generation = this.begin(st);
    if (!context.containers()) await context.loadSlackContainers();
    if (!this.current(kind, generation)) return;
    if (st.jid) return this.detail(st, kind, generation);
    const ack = kind === "ackemoji",
      title = ack ? "Ack emoji" : "Judgments",
      decision = st.decision || (ack ? null : "act,ignore");
    let navigation: Row = {};
    if (st.container)
      navigation = {
        back: {
          label: "← " + title,
          onClick: () => context.go({ view: kind, container: null, decision: st.decision, jid: null }),
        },
        context: context.slackContainerLabel(st.container),
      };
    else if (ack)
      navigation = {
        back: {
          label: "← Judgments",
          onClick: () => context.go({ view: "judgments", container: null, decision: null, jid: null }),
        },
      };
    const shell = (extra: Row) =>
      context.pageShell({
        title,
        ...navigation,
        ...(ack ? {} : { actions: [context.navLink("Ack emoji →", { view: "ackemoji" })] }),
        ...extra,
      });
    shell({});
    this.draw(loading(ack ? "Loading ack-emoji picks…" : "Loading judgments…"));
    const path = ack
      ? "/api/ack-emoji-picks?" +
        (decision ? "outcome=" + encodeURIComponent(decision) : "") +
        (st.container ? "&container=" + encodeURIComponent(st.container) : "")
      : "/api/ambient-judgments?decision=" +
        encodeURIComponent(decision) +
        (st.container ? "&container=" + encodeURIComponent(st.container) : "");
    const result = await context.api("GET", path);
    if (!this.current(kind, generation)) return;
    if (!result.ok)
      return this.draw(
        empty(result.status === 403 ? deniedLog(ack) : result.data?.message || `Failed to load (${result.status}).`),
      );
    const counts = result.data.counts || {},
      tabs = ack
        ? [
            { key: null, label: "All", counts: ["picked", "declined"] },
            { key: "picked", label: "Picked", counts: ["picked"] },
            { key: "declined", label: "Declined", counts: ["declined"] },
          ]
        : [
            { key: "act,ignore", label: "Judged", counts: ["act", "ignore"] },
            { key: "act", label: "Woke", counts: ["act"] },
            { key: "ignore", label: "Silent", counts: ["ignore"] },
            { key: "fastlane", label: "Fastlane", counts: ["fastlane"] },
          ];
    shell({
      tabs: tabs.map((t) => ({
        label: t.label,
        count: t.counts.reduce((n, key) => n + (counts[key] || 0), 0),
        active: t.key === decision,
        onClick: () =>
          context.go({
            view: kind,
            container: st.container,
            decision: t.key === "act,ignore" ? null : t.key,
            jid: null,
          }),
      })),
    });
    this.rows = result.data[ack ? "picks" : "judgments"] || [];
    this.hasMore = !!result.data.hasMore;
    this.paintLog(kind, path);
  }
  paintLog(kind: "judgments" | "ackemoji", path: string) {
    const ack = kind === "ackemoji",
      st = this.state;
    if (!this.rows.length)
      return this.draw(
        empty(ack ? "No ack-emoji picks recorded for this filter yet." : "No judgments recorded for this filter yet."),
      );
    const target = (r: Row) => ({ view: kind, container: st.container, decision: st.decision, jid: String(r.id) });
    this.draw(
      html`<div>
          ${dense(
            this.rows,
            (r) => ({
              name: context.slackContainerLabel(ack ? r.channel : r.container),
              preview: html`<span class="badges"
                >${ack ? ackBadge(r) : judgmentBadge(r.decision)}<span class=${ack ? "pill" : "pill judgment-reason"}
                  >${ack ? r.message || "None" : r.reason || (r.decision === "fastlane" ? "@mention, routed past the judge" : "None")}</span
                >${r.latencyMs != null ? html`<span class="dense-time">${r.latencyMs + "ms"}</span>` : nothing}</span
              >`,
              time: context.relTime(r.createdAt),
              href: context.stateToUrl(target(r)),
            }),
            (r) => context.go(target(r)),
            "",
          )}
        </div>
        ${this.hasMore ? html`<button type="button" class="load-earlier more" ?disabled=${this.busy} @click=${() => this.earlierLog(kind, path)}>${ack ? "Load earlier picks" : "Load earlier judgments"}</button>` : nothing}${this.error ? empty(this.error) : nothing}`,
    );
  }
  async earlierLog(kind: "judgments" | "ackemoji", path: string) {
    if (this.busy) return;
    const generation = this.generation,
      last = this.rows[this.rows.length - 1];
    this.busy = true;
    this.paintLog(kind, path);
    const result = await context.api(
      "GET",
      path + "&before=" + encodeURIComponent(last.createdAt) + "&beforeId=" + encodeURIComponent(last.id),
    );
    if (!this.current(kind, generation)) return;
    this.busy = false;
    if (result.ok) {
      this.rows = [...this.rows, ...(result.data[kind === "ackemoji" ? "picks" : "judgments"] || [])];
      this.hasMore = !!result.data.hasMore;
    } else this.error = result.data?.message || "Failed to load earlier entries.";
    this.paintLog(kind, path);
  }
  async detail(st: Row, kind: "judgments" | "ackemoji", generation: number) {
    const ack = kind === "ackemoji",
      title = ack ? "Ack emoji" : "Judgment",
      back = {
        label: ack ? "← Ack emoji" : "← Judgments",
        onClick: () => context.go({ view: kind, container: st.container, decision: st.decision, jid: null }),
      };
    context.pageShell({ back, title });
    this.draw(html`<div class="detail judg-detail">Loading…</div>`);
    const result = await context.api(
      "GET",
      (ack ? "/api/ack-emoji-picks?id=" : "/api/ambient-judgments?id=") + encodeURIComponent(st.jid),
    );
    if (!this.current(kind, generation)) return;
    if (!result.ok)
      return this.draw(
        html`<div class="detail judg-detail">
          ${empty(result.data?.message || `Failed to load (${result.status}).`)}
        </div>`,
      );
    const item = result.data[ack ? "pick" : "judgment"],
      container = ack ? item.channel : item.container,
      scope = context.slackContainerScope(container);
    context.pageShell({
      back,
      title,
      context: context.slackContainerLabel(container),
      ...(!ack
        ? { actions: scope ? [context.navLink("Governance →", { view: "governance", scope, session: null })] : [] }
        : {}),
    });
    if (ack) return this.draw(ackDetail(item, result.data.workspaceUrl));
    this.draw(judgmentDetail(item, result.data.workspaceUrl));
  }
}
function meta(item: Row) {
  return [item.model, item.latencyMs != null ? item.latencyMs + "ms" : null, context.fmtTime(item.createdAt)]
    .filter(Boolean)
    .join(" · ");
}
function judgmentDetail(item: Row, workspace: string) {
  const href = slackHref(workspace, item.container, item.tsFrom);
  return html`<div class="detail judg-detail">
    <div class="judg-pane-title">Judge context</div>
    <div class="judg-prompt">
      <pre>
${item.prompt || (item.decision === "fastlane" ? "Routed past the judge (formal @mention). No prompt was rendered." : "(prompt not recorded)")}</pre>
    </div>
    <div class="judg-decision">
      <div class="badges">
        ${judgmentBadge(item.decision)}${item.askedBy ? badge("asked by " + item.askedBy, "accent") : nothing}<span
          class="shell-context"
          >${meta(item)}</span
        >${href ? html`<a href=${href} target="_blank" rel="noopener" class="judg-extlink">Open in Slack ↗</a>` : nothing}
      </div>
      <p>${judgmentReason(item)}</p>
    </div>
  </div>`;
}
function ackDetail(item: Row, workspace: string) {
  const href = slackHref(workspace, item.channel, item.ts);
  return html`<div class="detail judg-detail">
    <div class="judg-decision">
      <div class="badges">
        ${item.outcome === "picked" ? ackTag(item.picked, item.icon) : badge("declined", "muted")}<span
          class="shell-context"
          >${meta(item)}</span
        >${href ? html`<a href=${href} target="_blank" rel="noopener" class="judg-extlink">Open in Slack ↗</a>` : nothing}
      </div>
    </div>
    <div class="judg-pane-title">Message</div>
    <div class="judg-prompt"><pre>${item.message || "(not recorded)"}</pre></div>
    <div class="judg-pane-title">Candidate slate</div>
    <div class="badges">
      ${
        (item.candidates || "").trim()
          ? (item.candidates || "")
              .split(" ")
              .filter(Boolean)
              .map((name: string) => ackTag(name, undefined, name === item.picked))
          : empty("(candidate slate not recorded)")
      }
    </div>
  </div>`;
}
export const activity = new SlackActivity();
export const renderAmbientJudgments = (state: Row) => activity.log(state, "judgments");
export const renderAckEmojiPicks = (state: Row) => activity.log(state, "ackemoji");

function deniedLog(ack: boolean) {
  return ack ? "Only an org admin can read ack-emoji picks." : "Only an org admin can read ambient judgments.";
}
