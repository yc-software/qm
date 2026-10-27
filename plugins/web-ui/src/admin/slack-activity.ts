import { html, nothing } from "lit";
import { repeat } from "lit/directives/repeat.js";
import { classMap } from "lit/directives/class-map.js";
import { badge, renderer, empty, denseList as dense } from "./shared.ts";
import { fmtTime, relTime } from "./format.ts";
import { slackParseText } from "./rich-text.ts";
type Row = Record<string, any>;
type Log = "judgments" | "ackemoji";
let context: Row;
export function configure(value: Row) {
  context = value;
}
const loading = (text: string) => html`<div class="loadingline">${text}</div>`;
const failure = (result: Row, fallback = `Failed to load (${result.status}).`) => result.data?.message || fallback;
const refused = (result: Row, denied: string) => empty(result.status === 403 ? denied : failure(result));
const param = (key: string, value?: string | null) => (value ? "&" + key + "=" + encodeURIComponent(value) : "");
const reply = (m: Row) => m.sub && m.sub !== m.ts;
const author = (m: Row) => (m.self ? context.brandSelfLabel() : m.authorName || m.authorId || "unknown");
function message(m: Row, opts: Row = {}) {
  return html`<div
    class=${classMap({ "sm-msg": true, "sm-self": !!m.self, "sm-reply": !!reply(m), "sm-deleted": !!m.deleted, "sm-target": !!opts.target })}
    data-ts=${m.ts}
  >
    <div class="sm-gutter">
      <span class="sm-avatar">${(author(m).trim()[0] || "?").toUpperCase()}</span>
    </div>
    <div class="sm-body">
      <div class="sm-head">
        <span class="sm-author">${author(m)}</span
        >${messageTag(m)}${reply(m) ? html`<span class="sm-tag" title=${"Reply in the thread rooted at " + m.sub}>Thread reply</span>` : nothing}<span
          class="sm-when"
          title=${fmtTime(m.createdAt) + " · ts " + m.ts}
          >${relTime(m.createdAt)}</span
        >
      </div>
      <div class="sm-text">
        ${slackParseText(m.text || "", m.mentions)}${m.editedAt ? html`<span class="sm-flag" title=${fmtTime(m.editedAt)}>(edited)</span>` : nothing}${m.deleted ? html`<span class="sm-flag">(deleted in Slack)</span>` : nothing}
      </div>
    </div>
  </div>`;
}
function messageTag(m: Row) {
  if (m.self) return html`<span class="sm-tag sm-tag-agent">agent</span>`;
  return m.bot ? html`<span class="sm-tag">bot</span>` : nothing;
}
const stream = (messages: Row[], key: (m: Row) => string, opts: (m: Row) => Row) =>
  html`<div class="sm-stream">${repeat(messages, key, (m) => message(m, opts(m)))}</div>`;
function judgmentBadge(decision: string) {
  if (decision === "act") return badge("woke", "ok");
  return decision === "ignore" ? badge("silent", "muted") : badge("fastlane", "accent");
}
function judgmentReason(item: Row) {
  if (item.reason) return item.reason;
  if (item.decision === "ignore") return "Stayed silent.";
  return item.decision === "fastlane" ? "@mention, routed past the judge." : "None";
}
const ackBadge = (row: Row) => (row.outcome === "picked" ? ackTag(row.picked, row.icon) : badge("declined", "muted"));
function ackTag(name: string, icon?: string, accent = false) {
  const cls = (base: string) => base + (accent ? " accent" : "");
  if (icon && /^https?:\/\//.test(icon))
    return html`<img class=${cls("ack-emoji-img")} src=${icon} alt=${":" + name + ":"} title=${":" + name + ":"} />`;
  return icon
    ? html`<span class=${cls("ack-emoji-glyph")} title=${":" + name + ":"}>${icon}</span>`
    : html`<span class=${cls("pill")}>${name ? ":" + name + ":" : "None"}</span>`;
}
function slackHref(workspace: string, container: string, ts: string) {
  return workspace && container?.startsWith("C") && ts
    ? workspace.replace(/\/$/, "") + "/archives/" + container + "/p" + ts.replace(".", "")
    : null;
}
class SlackActivity {
  generation = 0;
  state: Row = {};
  messages: Row[] = [];
  rows: Row[] = [];
  hasMore = false;
  busy = false;
  error = "";
  draw: (value: unknown) => void = () => {};
  root!: HTMLElement;
  current(view: string, generation: number) {
    return generation === this.generation && context.view() === view;
  }
  begin(state: Row) {
    Object.assign(this, { state, messages: [], rows: [], hasMore: false, busy: false, error: "" });
    this.root = document.getElementById("view-data")!;
    this.root.replaceChildren();
    this.draw = renderer(this.root);
    return ++this.generation;
  }
  more(label: string, load: () => void) {
    return html`${this.hasMore ? html`<button type="button" class="load-earlier more" ?disabled=${this.busy} @click=${load}>${label}</button>` : nothing}${this.error ? empty(this.error) : nothing}`;
  }
  async earlier(view: string, paint: () => void, load: () => Promise<Row>, add: (data: Row) => void, fallback: string) {
    if (this.busy) return;
    const generation = this.generation;
    this.busy = true;
    paint();
    const result = await load();
    if (!this.current(view, generation)) return;
    this.busy = false;
    if (result.ok) {
      add(result.data);
      this.hasMore = !!result.data.hasMore;
    } else this.error = failure(result, fallback);
    paint();
  }
  fetchMessages(container: string, before?: string) {
    return context.api(
      "GET",
      "/api/ambient-context/messages?container=" +
        encodeURIComponent(container) +
        "&limit=200" +
        param("before", before),
    );
  }
  async log(st: Row, kind: Log) {
    const generation = this.begin(st);
    if (!context.containers()) await context.loadSlackContainers();
    if (!this.current(kind, generation)) return;
    if (st.jid) return this.detail(st, kind, generation);
    const ack = kind === "ackemoji",
      title = ack ? "Ack emoji" : "Judgments",
      decision = st.decision || (ack ? null : "act,ignore"),
      container = st.container;
    const back = (label: string, view: string, decision: string | null) => ({
      back: { label, onClick: () => context.go({ view, container: null, decision, jid: null }) },
    });
    let navigation: Row = {};
    if (container)
      navigation = {
        ...back("← " + title, kind, st.decision),
        context: context.slackContainerLabel(container),
      };
    else if (ack) navigation = back("← Judgments", "judgments", null);
    const shell = (extra: Row) =>
      context.pageShell({
        title,
        ...navigation,
        ...(ack ? {} : { actions: [context.navLink("Ack emoji →", { view: "ackemoji" })] }),
        ...extra,
      });
    shell({});
    this.draw(loading(ack ? "Loading ack-emoji picks…" : "Loading judgments…"));
    const path =
      (ack
        ? "/api/ack-emoji-picks?" + (decision ? "outcome=" + encodeURIComponent(decision) : "")
        : "/api/ambient-judgments?decision=" + encodeURIComponent(decision!)) + param("container", container);
    const result = await context.api("GET", path);
    if (!this.current(kind, generation)) return;
    if (!result.ok)
      return this.draw(refused(result, `Only an org admin can read ${ack ? "ack-emoji picks" : "ambient judgments"}.`));
    const counts = result.data.counts || {},
      tabs: [string | null, string, ...string[]][] = ack
        ? [
            [null, "All", "picked", "declined"],
            ["picked", "Picked", "picked"],
            ["declined", "Declined", "declined"],
          ]
        : [
            ["act,ignore", "Judged", "act", "ignore"],
            ["act", "Woke", "act"],
            ["ignore", "Silent", "ignore"],
            ["fastlane", "Fastlane", "fastlane"],
          ];
    shell({
      tabs: tabs.map(([key, label, ...keys]) => ({
        label,
        count: keys.reduce((n, k) => n + (counts[k] || 0), 0),
        active: key === decision,
        onClick: () => context.go({ view: kind, container, decision: key === "act,ignore" ? null : key, jid: null }),
      })),
    });
    this.rows = result.data[ack ? "picks" : "judgments"] || [];
    this.hasMore = !!result.data.hasMore;
    this.paintLog(kind, path);
  }
  paintLog(kind: Log, path: string) {
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
              time: relTime(r.createdAt),
              href: context.stateToUrl(target(r)),
            }),
            (r) => context.go(target(r)),
            "",
          )}
        </div>
        ${this.more(ack ? "Load earlier picks" : "Load earlier judgments", () => this.earlierLog(kind, path))}`,
    );
  }
  earlierLog(kind: Log, path: string) {
    const last = this.rows[this.rows.length - 1];
    return this.earlier(
      kind,
      () => this.paintLog(kind, path),
      () => context.api("GET", path + param("before", last.createdAt) + param("beforeId", String(last.id))),
      (data) => (this.rows = [...this.rows, ...(data[kind === "ackemoji" ? "picks" : "judgments"] || [])]),
      "Failed to load earlier entries.",
    );
  }
  async detail(st: Row, kind: Log, generation: number) {
    const ack = kind === "ackemoji",
      title = ack ? "Ack emoji" : "Judgment",
      back = {
        label: ack ? "← Ack emoji" : "← Judgments",
        onClick: () => context.go({ view: kind, container: st.container, decision: st.decision, jid: null }),
      },
      frame = (content: unknown) => html`<div class="detail judg-detail">${content}</div>`;
    context.pageShell({ back, title });
    this.draw(frame("Loading…"));
    const result = await context.api(
      "GET",
      (ack ? "/api/ack-emoji-picks?id=" : "/api/ambient-judgments?id=") + encodeURIComponent(st.jid),
    );
    if (!this.current(kind, generation)) return;
    if (!result.ok) return this.draw(frame(empty(failure(result))));
    const item = result.data[ack ? "pick" : "judgment"],
      container = ack ? item.channel : item.container,
      scope = context.slackContainerScope(container);
    context.pageShell({
      back,
      title,
      context: context.slackContainerLabel(container),
      actions: !ack && scope ? [context.navLink("Governance →", { view: "governance", scope, session: null })] : [],
    });
    if (ack) return this.draw(ackDetail(item, result.data.workspaceUrl));
    this.draw(judgmentDetail(item, result.data.workspaceUrl, nothing));
    const mirror = await this.fetchMessages(container, item.tsTo ? (Number(item.tsTo) + 1).toString() : undefined);
    if (!this.current(kind, generation)) return;
    const messages = (mirror.data?.messages || []).filter((m: Row) => !item.tsTo || m.ts <= item.tsTo);
    let content: unknown = empty("Nothing mirrored for this window.");
    if (messages.length)
      content = stream(
        messages,
        (m) => m.ts,
        (m) => ({ target: item.tsFrom && item.tsTo && m.ts >= item.tsFrom && m.ts <= item.tsTo }),
      );
    if (!mirror.ok) content = empty(failure(mirror, `Failed to load mirror (${mirror.status}).`));
    this.draw(judgmentDetail(item, result.data.workspaceUrl, content));
    requestAnimationFrame(() => {
      if (this.current(kind, generation)) this.root.querySelector(".sm-target")?.scrollIntoView({ block: "center" });
    });
  }
}
const meta = (item: Row) =>
  [item.model, item.latencyMs != null ? item.latencyMs + "ms" : null, fmtTime(item.createdAt)]
    .filter(Boolean)
    .join(" · ");
function judgmentDetail(item: Row, workspace: string, mirror: unknown) {
  const href = slackHref(workspace, item.container, item.tsFrom);
  return html`<div class="detail judg-detail">
    <div class="judg-split">
      <div>
        <div class="judg-pane-title">
          Slack
          mirror${
            href
              ? html`<a
                  href=${href}
                  target="_blank"
                  rel="noopener"
                  class="judg-extlink"
                  aria-label="Open in Slack"
                  title="Jump to this moment in Slack to scroll up for more context"
                  ><svg
                    width="13"
                    height="13"
                    viewBox="0 0 16 16"
                    fill="none"
                    stroke="currentColor"
                    stroke-width="1.6"
                    stroke-linecap="round"
                    stroke-linejoin="round"
                    aria-hidden="true"
                  >
                    <path d="M6.5 3.5H3.5a1 1 0 0 0-1 1v8a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1v-3" />
                    <path d="M9.5 2.5h4v4" />
                    <path d="M7 9 13.5 2.5" /></svg
                ></a>`
              : nothing
          }
        </div>
        <div class="judg-mirror">${mirror}</div>
      </div>
      <div>
        <div class="judg-pane-title">Judge context</div>
        <div class="judg-prompt">
          <pre>
${item.prompt || (item.decision === "fastlane" ? "Routed past the judge (formal @mention). No prompt was rendered." : "(prompt not recorded)")}</pre>
        </div>
      </div>
    </div>
    <div class="judg-decision">
      <div class="badges">
        ${judgmentBadge(item.decision)}${item.askedBy ? badge("asked by " + item.askedBy, "accent") : nothing}<span
          class="shell-context"
          >${meta(item)}</span
        >
      </div>
      <p>${judgmentReason(item)}</p>
    </div>
  </div>`;
}
function ackDetail(item: Row, workspace: string) {
  const href = slackHref(workspace, item.channel, item.ts),
    names: string[] = (item.candidates || "").trim() ? item.candidates.split(" ").filter(Boolean) : [];
  return html`<div class="detail judg-detail">
    <div class="judg-decision">
      <div class="badges">
        ${ackBadge(item)}<span class="shell-context">${meta(item)}</span
        >${href ? html`<a href=${href} target="_blank" rel="noopener" class="judg-extlink">Open in Slack ↗</a>` : nothing}
      </div>
    </div>
    <div class="judg-pane-title">Message</div>
    <div class="judg-prompt"><pre>${item.message || "(not recorded)"}</pre></div>
    <div class="judg-pane-title">Candidate slate</div>
    <div class="badges">
      ${names.length ? names.map((name) => ackTag(name, undefined, name === item.picked)) : empty("(candidate slate not recorded)")}
    </div>
  </div>`;
}
export const activity = new SlackActivity();
export const renderAmbientJudgments = (state: Row) => activity.log(state, "judgments");
export const renderAckEmojiPicks = (state: Row) => activity.log(state, "ackemoji");
