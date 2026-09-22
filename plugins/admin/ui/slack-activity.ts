import { html, nothing } from "lit";
import { repeat } from "lit/directives/repeat.js";
import { classMap } from "lit/directives/class-map.js";
import { badge, renderer, node } from "./shared.ts";
import type { Api } from "./integrations-state.ts";
type Row = Record<string, any>;
type Context = {
  api: Api;
  go: (state: Row) => void;
  urlToState: () => Row;
  stateToUrl: (state: Row) => string;
  pageShell: (state: Row) => void;
  navLink: (label: string, state: Row) => Node;
  relTime: (value: string) => string;
  fmtTime: (value: string) => string;
  brandSelfLabel: () => string;
  slackParseText: (text: string, mentions?: Row) => Node;
  slackContainerLabel: (id: string) => string;
  slackContainerScope: (id: string) => string | null;
  loadSlackContainers: () => ReturnType<Api>;
  containers: () => Row[] | null;
  truncated: () => boolean;
  view: () => string;
  loaded: () => void;
};
let context: Context;
export function configure(value: Context) {
  context = value;
}
const empty = (text: string) => html`<p class="empty">${text}</p>`;
const loading = (text: string) => html`<div class="loadingline">${text}</div>`;
export const groupKey = (m: Row) =>
  (m.authorId || m.authorName || m.ts) + "|" + (m.sub && m.sub !== m.ts ? m.sub : "root");
const author = (m: Row) => (m.self ? context.brandSelfLabel() : m.authorName || m.authorId || "unknown");
const time = (m: Row) => new Date(m.createdAt).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
export function message(m: Row, opts: Row = {}) {
  return html`<div
    class=${classMap({ "sm-msg": true, "sm-cont": !!opts.cont, "sm-self": !!m.self, "sm-reply": !!(m.sub && m.sub !== m.ts), "sm-deleted": !!m.deleted, "sm-target": !!opts.target, "sm-openable": !!opts.onOpen })}
    data-ts=${m.ts}
    @click=${opts.onOpen ? () => opts.onOpen(m) : nothing}
  >
    <div class="sm-gutter">
      ${opts.cont ? html`<span class="sm-guttertime">${time(m)}</span>` : html`<span class="sm-avatar">${(author(m).trim()[0] || "?").toUpperCase()}</span>`}
    </div>
    <div class="sm-body">
      ${opts.cont ? nothing : html`<div class="sm-head"><span class="sm-author">${author(m)}</span>${messageTag(m)}${m.sub && m.sub !== m.ts ? html`<span class="sm-tag" title=${"Reply in the thread rooted at " + m.sub}>Thread reply</span>` : nothing}${opts.containerLabel ? html`<span class="sm-tag">${opts.containerLabel}</span>` : nothing}<span class="sm-when" title=${context.fmtTime(m.createdAt) + " · ts " + m.ts}>${context.view() === "slack" && !opts.onOpen ? time(m) : context.relTime(m.createdAt)}</span></div>`}
      <div class="sm-text">
        ${context.slackParseText(m.text || "", m.mentions)}${m.editedAt ? html`<span class="sm-flag" title=${context.fmtTime(m.editedAt)}>(edited)</span>` : nothing}${m.deleted ? html`<span class="sm-flag">(deleted in Slack)</span>` : nothing}
      </div>
    </div>
  </div>`;
}
export function groupedMessages(messages: Row[], target?: string) {
  return repeat(
    messages,
    (m) => m.ts,
    (m, index) => {
      const previous = messages[index - 1],
        day = new Date(m.createdAt).toDateString(),
        sameDay = previous && new Date(previous.createdAt).toDateString() === day;
      return html`${sameDay ? nothing : html`<div class="sm-day">${day === new Date().toDateString() ? "Today" : new Date(m.createdAt).toLocaleDateString([], { month: "short", day: "numeric", year: "numeric" })}</div>`}${message(m, { target: target === m.ts, cont: !!sameDay && groupKey(previous) === groupKey(m) && target !== m.ts })}`;
    },
  );
}
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
function messageTag(m: Row) {
  if (m.self) return html`<span class="sm-tag sm-tag-agent">agent</span>`;
  return m.bot ? html`<span class="sm-tag">bot</span>` : nothing;
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
export function slackHref(workspace: string, container: string, ts: string) {
  return workspace && container?.startsWith("C") && ts
    ? workspace.replace(/\/$/, "") + "/archives/" + container + "/p" + ts.replace(".", "")
    : null;
}
export class SlackActivity {
  generation = 0;
  state: Row = {};
  messages: Row[] = [];
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
    this.messages = [];
    this.rows = [];
    this.hasMore = false;
    this.busy = false;
    this.error = "";
    this.root = document.getElementById("view-data")!;
    this.root.replaceChildren();
    this.draw = renderer(this.root);
    return this.generation;
  }
  searchBox(container: string | null) {
    let timer: ReturnType<typeof setTimeout>;
    return {
      placeholder: container ? "Search this channel…" : "Search all mirrored messages…",
      onInput: (value: string) => {
        clearTimeout(timer);
        timer = setTimeout(() => {
          if (context.view() === "slack" && (context.urlToState().container || null) === container)
            void this.search(value.trim(), container);
        }, 250);
      },
    };
  }
  async search(query: string, container: string | null) {
    if (context.view() !== "slack") return;
    if (!query) return this.mirror({ ...context.urlToState(), ts: null });
    const generation = this.begin({ ...context.urlToState(), query });
    const result = await context.api(
      "GET",
      "/api/slack-mirror/messages?q=" +
        encodeURIComponent(query) +
        (container ? "&container=" + encodeURIComponent(container) : ""),
    );
    if (!this.current("slack", generation)) return;
    if (!result.ok) return this.draw(empty(result.data?.message || `Search failed (${result.status}).`));
    this.messages = result.data.messages || [];
    this.draw(
      this.messages.length
        ? html`<div class="sm-stream">
              ${repeat(
                this.messages,
                (m) => m.container + ":" + m.ts,
                (m) =>
                  message(m, {
                    containerLabel: container ? null : context.slackContainerLabel(m.container),
                    onOpen: (msg: Row) => context.go({ view: "slack", container: msg.container, ts: msg.ts }),
                  }),
              )}
            </div>
            ${result.data.hasMore ? empty(`First ${this.messages.length.toLocaleString()} matches shown. Refine the search to see the rest.`) : nothing}`
        : empty("No matches in the mirror."),
    );
  }
  async mirror(st: Row) {
    const generation = this.begin(st);
    if (!st.container) {
      context.pageShell({ title: "Slack", search: this.searchBox(null) });
      this.draw(loading("Loading Slack mirror..."));
      const result = await context.loadSlackContainers();
      if (!this.current("slack", generation)) return;
      if (!result.ok)
        return this.draw(
          empty(
            result.status === 403
              ? "Only an org admin can read the Slack mirror."
              : result.data?.message || `Failed to load (${result.status}).`,
          ),
        );
      context.loaded();
      const containers = context.containers() || [];
      context.pageShell({
        title: "Slack",
        count: (context.truncated() ? containers.length.toLocaleString() + "+" : containers.length) + " conversations",
        search: this.searchBox(null),
      });
      this.draw(
        html`${dense(
          containers,
          (c) => ({
            name: context.slackContainerLabel(c.container),
            preview: `${Number(c.messageCount).toLocaleString()} mirrored · ${(c.members || []).length} ${(c.members || []).length === 1 ? "member" : "members"}`,
            time: context.relTime(c.updatedAt),
            href: context.stateToUrl({ view: "slack", container: c.container }),
          }),
          (c) => context.go({ view: "slack", container: c.container }),
          "Nothing mirrored yet. The surface pushes messages here as it sees them.",
        )}${context.truncated() ? empty(`Showing the ${containers.length.toLocaleString()} most recently active conversations.`) : nothing}`,
      );
      return;
    }
    if (!context.containers()) await context.loadSlackContainers();
    if (!this.current("slack", generation)) return;
    const container = st.container,
      scope = context.slackContainerScope(container);
    context.pageShell({
      back: { label: "← Slack", onClick: () => context.go({ view: "slack", container: null, ts: null }) },
      title: context.slackContainerLabel(container),
      context: container,
      search: this.searchBox(container),
      actions: [
        context.navLink("Judgments →", { view: "judgments", container }),
        ...(scope ? [context.navLink("Governance →", { view: "governance", scope, session: null })] : []),
      ],
    });
    const bar = document.getElementById("shellbar")!;
    const toolbar = node(
      html`<div class="sm-toolbar">${bar.querySelector(".back")}${[...bar.querySelectorAll(".link")]}</div>`,
    );
    const heading = node(
      html`<div class="sm-channel-heading">
        ${bar.querySelector(".shell-title")}${bar.querySelector(".shell-context")}
      </div>`,
    );
    bar.querySelector(".shell-spacer")?.remove();
    bar.prepend(toolbar, heading);
    this.draw(loading("Loading messages..."));
    const result = await this.fetchMessages(container);
    if (!this.current("slack", generation)) return;
    if (!result.ok) return this.draw(empty(result.data?.message || `Failed to load (${result.status}).`));
    this.messages = result.data.messages || [];
    this.hasMore = !!result.data.hasMore;
    for (
      let hops = 0;
      st.ts && this.hasMore && this.messages.length && this.messages[0].ts > st.ts && hops < 10;
      hops++
    ) {
      const older = await this.fetchMessages(container, this.messages[0].ts);
      if (!this.current("slack", generation)) return;
      if (!older.ok) break;
      this.messages = [...(older.data.messages || []), ...this.messages];
      this.hasMore = !!older.data.hasMore;
    }
    toolbar.appendChild(
      node(
        html`<a
          href=${"/api/slack-mirror/messages?container=" + encodeURIComponent(container)}
          target="_blank"
          rel="noopener"
          title="Open the raw mirrored JSON rows for this container in a new tab"
          >Raw feed ↗</a
        >`,
      ),
    );
    this.paintMessages();
    requestAnimationFrame(() => {
      if (!this.current("slack", generation)) return;
      if (st.ts) this.root.querySelector(".sm-target")?.scrollIntoView({ block: "center" });
      else window.scrollTo({ top: document.body.scrollHeight });
    });
  }
  fetchMessages(container: string, before?: string) {
    return context.api(
      "GET",
      "/api/slack-mirror/messages?container=" +
        encodeURIComponent(container) +
        "&limit=200" +
        (before ? "&before=" + encodeURIComponent(before) : ""),
    );
  }
  paintMessages() {
    this.draw(
      html`${this.state.ts && !this.messages.some((m) => m.ts === this.state.ts) ? html`<div class="sm-day">${"Message " + this.state.ts + " isn't in the loaded window. It may be older than what's shown (use “Load earlier messages”) or was never mirrored."}</div>` : nothing}${this.hasMore ? html`<button type="button" class="load-earlier more" ?disabled=${this.busy} @click=${() => this.earlierMessages()}>Load earlier messages</button>` : nothing}${this.error ? empty(this.error) : nothing}
        <div class="sm-stream">
          ${this.messages.length ? groupedMessages(this.messages, this.state.ts) : empty("Nothing mirrored for this channel yet.")}
        </div>`,
    );
  }
  async earlierMessages() {
    if (this.busy) return;
    const generation = this.generation;
    this.busy = true;
    this.paintMessages();
    const result = await this.fetchMessages(this.state.container, this.messages[0]?.ts);
    if (!this.current("slack", generation)) return;
    this.busy = false;
    if (result.ok) {
      this.messages = [...(result.data.messages || []), ...this.messages];
      this.hasMore = !!result.data.hasMore;
    } else this.error = result.data?.message || "Failed to load earlier messages.";
    this.paintMessages();
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
        contextGo: { view: "slack", container: st.container },
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
      ts = ack ? item.ts : item.tsFrom,
      scope = context.slackContainerScope(container);
    context.pageShell({
      back,
      title,
      context: context.slackContainerLabel(container),
      contextGo: { view: "slack", container, ts },
      ...(!ack
        ? { actions: scope ? [context.navLink("Governance →", { view: "governance", scope, session: null })] : [] }
        : {}),
    });
    if (ack) return this.draw(ackDetail(item, result.data.workspaceUrl));
    this.draw(judgmentDetail(item, result.data.workspaceUrl, nothing));
    const before = item.tsTo ? (Number(item.tsTo) + 1).toString() : undefined;
    const mirror = await this.fetchMessages(container, before);
    if (!this.current(kind, generation)) return;
    const messages = (mirror.data?.messages || []).filter((m: Row) => !item.tsTo || m.ts <= item.tsTo);
    let mirrorContent: unknown = empty("Nothing mirrored for this window.");
    if (messages.length)
      mirrorContent = html`<div class="sm-stream">
        ${repeat(
          messages,
          (m: Row) => m.ts,
          (m: Row) => message(m, { target: item.tsFrom && item.tsTo && m.ts >= item.tsFrom && m.ts <= item.tsTo }),
        )}
      </div>`;
    if (!mirror.ok) mirrorContent = empty(mirror.data?.message || `Failed to load mirror (${mirror.status}).`);
    this.draw(judgmentDetail(item, result.data.workspaceUrl, mirrorContent));
    requestAnimationFrame(() => {
      if (this.current(kind, generation)) this.root.querySelector(".sm-target")?.scrollIntoView({ block: "center" });
    });
  }
}
function meta(item: Row) {
  return [item.model, item.latencyMs != null ? item.latencyMs + "ms" : null, context.fmtTime(item.createdAt)]
    .filter(Boolean)
    .join(" · ");
}
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
export const renderSlackMirror = (state: Row) => activity.mirror(state);
export const renderAmbientJudgments = (state: Row) => activity.log(state, "judgments");
export const renderAckEmojiPicks = (state: Row) => activity.log(state, "ackemoji");

function deniedLog(ack: boolean) {
  return ack ? "Only an org admin can read ack-emoji picks." : "Only an org admin can read ambient judgments.";
}
