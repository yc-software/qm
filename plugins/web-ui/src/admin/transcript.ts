import { html, nothing } from "lit";
import { classMap } from "lit/directives/class-map.js";
import { repeat } from "lit/directives/repeat.js";
import { ifDefined } from "lit/directives/if-defined.js";
import { node, renderer, badge, scroller } from "./shared.ts";
type Row = Record<string, any>;
let generation = 0;
export function cancel() {
  generation++;
}
const brain = html`<svg
  viewBox="0 0 24 24"
  fill="none"
  stroke-width="1.8"
  stroke-linecap="round"
  stroke-linejoin="round"
  aria-hidden="true"
>
  <path
    d="M12 4.5c-2.1 0-3.7 1.3-3.7 3.1 0 .2 0 .4.1.6A3.6 3.6 0 0 0 6 11.5c0 1 .4 2 1.1 2.6-.1.3-.1.5-.1.8 0 2 1.8 3.6 4 3.6h1.9c2.2 0 4-1.6 4-3.6 0-.3 0-.6-.1-.8.7-.7 1.1-1.6 1.1-2.6 0-1.5-.9-2.8-2.3-3.3 0-.2.1-.4.1-.6 0-1.8-1.6-3.1-3.7-3.1Z"
  />
  <path d="M9.2 9.2c.9.1 1.6.6 2 1.4" />
  <path d="M14.8 9.2c-.9.1-1.6.6-2 1.4" />
  <path d="M12 10.7v7.8" />
</svg>`;
const activate = (run: () => void) => (e: KeyboardEvent) => {
  if (e.key === "Enter" || e.key === " ") {
    e.preventDefault();
    run();
  }
};
const requestCount = (count: number) => count + " request" + (count === 1 ? "" : "s");
const contextIcon = (label: string, title: string, onClick: (e: Event) => void, expanded?: boolean) =>
  html`<button
    type="button"
    class=${"context-icon" + (expanded ? " active" : "")}
    aria-expanded=${ifDefined(expanded === undefined ? undefined : String(expanded))}
    aria-label=${label}
    title=${title}
    @click=${onClick}
  >
    ${brain}
  </button>`;
export function prepare(data: Row, requests: Row[]) {
  const entries: Row[] = data.entries || [],
    events: Row[] = data.deliveryEvents || [],
    llm = new Map<any, Row[]>(),
    byEntry = new Map<any, Row[]>(),
    dur = new Map<number, number>(),
    seqIndex = new Map(entries.map((e, i) => [e.seq, i])),
    add = (map: Map<any, Row[]>, key: any, rows: Row[]) => map.set(key, [...(map.get(key) || []), ...rows]);
  for (const req of requests) add(llm, req.turnSeq ?? "_orphan", [req]);
  for (let i = 1; i < entries.length; i++) {
    const delta = (entries[i].createdAt || 0) - (entries[i - 1].createdAt || 0);
    if (delta >= 0) dur.set(entries[i].seq, delta);
  }
  for (const [turn, reqs] of llm) {
    if (turn === "_orphan" || turn < (entries[0]?.seq || 0)) continue;
    const start = seqIndex.get(turn);
    if (start === undefined) {
      add(llm, "_orphan", reqs);
      continue;
    }
    let anchor = start;
    for (let i = start + 1; i < entries.length && entries[i].type !== "user"; i++)
      if (entries[i].type === "assistant") anchor = i;
    add(
      byEntry,
      entries[anchor].seq,
      reqs.sort((a, b) => (a.step || 0) - (b.step || 0)),
    );
  }
  const results = new Map<any, Row>(),
    outbound = new Map<any, Row>(),
    principalIds = new Set(),
    pairedSeqs = new Set(),
    merged = new Set(),
    units: Row[] = [];
  for (const e of entries)
    if (e.type === "tool_result" && e.payload?.callId && !results.has(e.payload.callId))
      results.set(e.payload.callId, e);
  for (const e of events) {
    if (e.deliveryId && e.type === "outbound_delivery" && !outbound.has(e.deliveryId)) outbound.set(e.deliveryId, e);
    if (e.deliveryId && e.type === "principal_delivery") principalIds.add(e.deliveryId);
  }
  entries.forEach((e, i) => {
    if (e.type !== "tool_call" && e.type !== "tool_result")
      return units.push({ kind: "entry", entry: e, llmReqs: byEntry.get(e.seq) });
    if (e.type === "tool_result" && pairedSeqs.has(e.seq)) return;
    let paired: Row | undefined;
    if (e.type === "tool_call") {
      if (e.payload?.callId) paired = results.get(e.payload.callId);
      else if (entries[i + 1]?.type === "tool_result") paired = entries[i + 1];
    }
    if (paired) pairedSeqs.add(paired.seq);
    const deliveryId = (e.type === "tool_result" ? e : paired)?.payload?.deliveryId,
      delivery = outbound.get(deliveryId);
    if (delivery) merged.add(deliveryId);
    units.push({ kind: "tool", primary: e, paired, delivery, llmReqs: byEntry.get(e.seq) });
  });
  for (const event of events)
    if (!event.deliveryId || !merged.has(event.deliveryId)) units.push({ kind: "delivery_event", event });
  const at = (unit: Row) => (unit.primary || unit.entry || unit.event)?.createdAt || 0;
  units.sort((a, b) => at(a) - at(b));
  if (llm.get("_orphan")?.length) units.push({ kind: "llm", reqs: llm.get("_orphan") });
  return {
    units,
    dur,
    principalIds,
    originPromptSeq: data.origin && !data.hasMore ? entries.find((e) => e.type === "user")?.seq : null,
  };
}
function contextStats(requests: Row[], s: Row, sections?: Row[]) {
  const latest = requests.at(-1) || { request: {} };
  sections ??= s.contextSections(s.requestBody(latest), latest.transport);
  return html`<div class="context-stats">
    ${s.metaChip((latest.model || "?") + " · " + s.fmtContextSize(latest, sections))}${s.cacheMetaItems(s.sumCacheUsage(requests))}${s.rawJsonLink(requests)}
  </div>`;
}
function begin(s: Row, shell: Row) {
  const request = ++generation,
    root = document.getElementById("view-data")!;
  root.replaceChildren();
  const draw = renderer(root);
  s.pageShell(shell);
  draw(html`<div class="detail">Loading…</div>`);
  return { request, root, draw };
}
const fetchSession = (s: Row, id: string, path: string, query = "") =>
  s.api("GET", "/api/sessions/" + encodeURIComponent(id) + path + "scope=" + encodeURIComponent(s.scope) + query);
const failed = (result: Row, what: string) =>
  html`<div class="detail">${result.data?.message || `Failed to load ${what} (${result.status}).`}</div>`;
export function requestsPanel(requests: Row[], s: Row, opts: Row = {}) {
  const host = document.createDocumentFragment(),
    draw = renderer(host as unknown as HTMLElement),
    sections: Row[][] = requests.map((q) => s.contextSections(s.requestBody(q), q.transport)),
    selected = sections.map((list) =>
      opts.selectLargest && list.length ? list.reduce((a, b) => (b.tokens > a.tokens ? b : a)).key : null,
    ),
    cache = s.sumCacheUsage(requests);
  function paint() {
    draw(
      html`<div
        class=${classMap({ llm: true, "context-turn": true, "context-page": !!opts.page, "cache-miss": !!cache && s.isStablePrefixMiss(cache) })}
      >
        ${opts.page ? nothing : html`<div class="who">${contextStats(requests, s, sections.at(-1) || [])}</div>`}
        <div class="context-details">
          ${requests.map((q, index) => {
            const list: Row[] = sections[index],
              total = list.reduce((n, section) => n + section.tokens, 0),
              chosen = list.find((section) => section.key === selected[index]);
            return html`<div class="context-request">
              ${requests.length > 1 ? html`<div class="context-request-head"><strong>${"Request " + (index + 1)}</strong><span>${(q.model || "?") + " · " + s.fmtContextSize(q, list)}</span></div>` : nothing}${q.truncated ? html`<p class="context-note">Stored payload was truncated.</p>` : nothing}
              <div class="context-overview">
                <div class="context-stack" role="group" aria-label="request context">
                  ${list.map((section) => {
                    const title =
                      section.label + " · " + s.fmtTokens(section.tokens) + (section.note ? " · " + section.note : "");
                    return html`<button
                      type="button"
                      class=${"context-segment ctx-" + (section.colorKey || section.key) + (chosen === section ? " active" : "")}
                      style=${"flex-grow:" + Math.max(section.tokens, 1) + ";flex-basis:" + (total ? Math.max(2, Math.round((section.tokens / total) * 100)) + "%" : "1%")}
                      data-tiny=${total && section.tokens / total < 0.12 ? "true" : "false"}
                      title=${title}
                      aria-label=${title}
                      aria-pressed=${String(chosen === section)}
                      @click=${() => {
                        selected[index] = section.key;
                        paint();
                      }}
                    >
                      <span>${section.label}</span><small>${"~" + s.fmtTokens(section.tokens)}</small>
                    </button>`;
                  })}
                </div>
              </div>
              <div class="context-selection">
                ${
                  chosen
                    ? html`<div class="context-section-view">
                        <div class="context-section-head">
                          <strong>${chosen.label}</strong
                          ><span>${s.fmtTokens(chosen.tokens) + (chosen.note ? " · " + chosen.note : "")}</span>
                        </div>
                        <pre>${chosen.text || "(empty)"}</pre>
                      </div>`
                    : nothing
                }
              </div>
            </div>`;
          })}
        </div>
      </div>`,
    );
  }
  paint();
  return host.firstElementChild as HTMLElement;
}
export async function contextPage(sessionId: string, turnSeq: string, s: Row) {
  const { request, draw } = begin(s, {
    back: { label: "← Back to transcript", onClick: () => history.back() },
    title: "Sent to model",
  });
  const result = await fetchSession(s, sessionId, "/llm?turnSeq=" + encodeURIComponent(turnSeq) + "&");
  if (request !== generation || !s.current(sessionId, turnSeq)) return;
  if (!result.ok) return draw(failed(result, "context"));
  const requests = (result.data.requests || []).slice().sort((a: Row, b: Row) => (a.step || 0) - (b.step || 0)),
    label = turnSeq === "orphan" ? "unattributed context" : `turn #${turnSeq}`;
  draw(
    html`<div class="detail">
      <div class="context-page-head">
        <h2>${"Sent to model · " + label + (requests.length > 1 ? " · " + requests.length + " steps" : "")}</h2>
        ${requests.length ? contextStats(requests, s) : nothing}
      </div>
      ${requests.length ? requestsPanel(requests, s, { page: true, selectLargest: true }) : html`<p class="context-empty">No context was captured for this turn.</p>`}
    </div>`,
  );
}
export async function show(sessionId: string, limit: number | undefined, expand: boolean | undefined, s: Row) {
  const back = (sessionScope?: string) => () => {
    if (history.state?.deepLink)
      s.go({ view: "history", scope: sessionScope || s.scope, session: null, historyKind: s.historyKind });
    else history.back();
  };
  const { request, root, draw } = begin(s, {
      back: { label: "← Conversations", onClick: back() },
      title: "Conversation",
      context: s.shortName(s.scope),
    }),
    reqLimit = limit || s.pageSize,
    current = () => request === generation && s.current(sessionId);
  let applyVisibility = () => {};
  const header = document.getElementById("header-controls")!;
  header.replaceChildren();
  const paintHeader = renderer(header);
  function controls() {
    paintHeader(
      html`${Object.entries({ thinking: "thinking", "tool results": "toolResults" }).map(
        ([label, key]) =>
          html`<label class="header-check"
            ><input
              type="checkbox"
              .checked=${!!s.visibility[key]}
              aria-label=${"Show " + label}
              @change=${(e: Event) => {
                s.visibility[key] = (e.target as HTMLInputElement).checked;
                applyVisibility();
              }}
            /><span class="header-check-prefix">Show </span>${label}</label
          >`,
      )}`,
    );
  }
  controls();
  const llmPromise = fetchSession(s, sessionId, "/llm?");
  const result = await fetchSession(s, sessionId, "?", "&limit=" + reqLimit);
  if (!current()) return;
  if (!result.ok) return draw(failed(result, "transcript"));
  const data = result.data,
    session = data.session || {},
    origin = data.origin,
    owner = session.scopeId?.startsWith("personal:") ? session.scopeId.slice(9) : null;
  s.pageShell({
    back: { label: "← Conversations", onClick: back(session.scopeId) },
    title: origin?.label || "Conversation",
    context:
      s.shortName(session.scopeId || s.scope) + (session.createdAt ? " · created " + s.relTime(session.createdAt) : ""),
    actions: owner ? [s.webUiAsButton(owner)] : [],
  });
  const requests: Row[] = await llmPromise.then((llm: Row) => (llm.ok ? llm.data.requests || [] : [])).catch(() => []);
  if (!current()) return;
  const { units, dur, principalIds, originPromptSeq } = prepare(data, requests),
    open = new Set<Row>(),
    bodyNodes = new Map<Row, Node>(),
    toolNodes = new Map<Row, Row>(),
    panels = new Map<Row, HTMLElement>();
  let errors: Row[] = [],
    first = 0,
    paused = false;
  const observer =
    "IntersectionObserver" in window
      ? new IntersectionObserver((entries) => entries.some((e) => e.isIntersecting) && reveal(), {
          rootMargin: "800px 0px",
        })
      : null;
  s.setObserver(observer);
  const rewind = (from: number) => {
    first = Math.max(0, from - 60);
    while (first > 0 && units[first].kind === "llm") first--;
  };
  if (observer && !expand) rewind(units.length);
  const toggle = (unit: Row) => () => {
    if (open.has(unit)) open.delete(unit);
    else open.add(unit);
    paint();
  };
  const ends = ({ primary: p, paired }: Row) => [
    p.type === "tool_call" ? p : null,
    p.type === "tool_result" ? p : paired,
  ];
  const memo = <K, V>(map: Map<K, V>, key: K, make: () => V) => {
    if (!map.has(key)) map.set(key, make());
    return map.get(key)!;
  };
  const contextButton = (turn: any, count: number) =>
    contextIcon("View context sent to the model", "View context sent to the model · " + requestCount(count), (e) => {
      e.stopPropagation();
      s.go({ view: "history", scope: s.scope, session: sessionId, turn });
    });
  const timing = (unit: Row) => {
    const [call, res] = ends(unit);
    return call && res
      ? [
          [dur.get(call.seq), "model"],
          [(res.createdAt || 0) - (call.createdAt || 0), "exec"],
        ]
      : [[dur.get((call || res)?.seq)]];
  };
  function fullTool(unit: Row) {
    const built = memo(toolNodes, unit, () =>
      s.renderToolEntry(
        ...ends(unit),
        unit.llmReqs?.length ? node(contextButton(unit.llmReqs[0].turnSeq, unit.llmReqs.length)) : null,
        s.stepDurEl(timing(unit)),
        unit.delivery || null,
      ),
    );
    built.sync?.();
    return built.block;
  }
  const cronLink = (cronOrigin: Row | null, ownerScope?: string) =>
    cronOrigin?.kind === "cron"
      ? html`<button
          type="button"
          class="link"
          @click=${() => s.go({ view: "crons", scope: cronOrigin.cron?.ownerScopeId || ownerScope || s.scope, session: null, cron: cronOrigin.cronId })}
        >
          View cron
        </button>`
      : nothing;
  const body = (entry: Row) =>
    memo(bodyNodes, entry, () => {
      const text = s.payloadText(entry.payload);
      let value: Node;
      if (entry.type === "user" && s.isXmlishText(text)) value = s.renderXmlish(text);
      else if (entry.type === "user" || entry.type === "assistant") value = s.renderMarkdown(text);
      else value = node(html`<pre>${text}</pre>`);
      if ((value as Element).tagName === "PRE") value.textContent = text;
      return value;
    });
  function unitTemplate(unit: Row) {
    if (unit.kind === "llm")
      return html`<div class="entry llm">
        <div class="who">${contextButton("orphan", unit.reqs.length)}<span class="role">captured context</span></div>
      </div>`;
    if (unit.kind === "tool") {
      const e = unit.primary,
        [call, res] = ends(unit),
        types = unit.paired ? ["tool_call", "tool_result"] : [e.type];
      if (unit.delivery) types.push("outbound_delivery");
      if (principalIds.has(unit.delivery?.deliveryId)) types.push("principal_delivery");
      const hidden = s.entryHidden(types, !!unit.delivery),
        full = fullTool(unit);
      full.classList.toggle("filtered", hidden);
      if (unit.delivery || unit.llmReqs?.length) return full;
      const cp = call?.payload,
        rp = res?.payload,
        name = s.toolName(cp, rp);
      return html`<div
        class=${classMap({ entry: true, "tool-entry": true, "tool-line-entry": true, open: open.has(unit), filtered: hidden })}
      >
        <div
          class="who tool-line"
          tabindex="0"
          role="button"
          title="Toggle full tool card"
          aria-expanded=${String(open.has(unit))}
          @click=${(e: MouseEvent) => {
            if (!(e.target as Element).closest(".copy")) toggle(unit)();
          }}
          @keydown=${activate(toggle(unit))}
        >
          <span class="tool-line-caret">${open.has(unit) ? "▾" : "▸"}</span
          ><span class="tool-label">${s.toolLabelText(name, cp, rp)}</span
          ><span class="tool-line-preview">${s.firstLine(s.toolPrimaryText(cp, rp, !!call, !!res) || "", 240)}</span
          >${s.stepDurEl(timing(unit))}<span class="when"
            >${call && res ? `#${call.seq}→#${res.seq} · ${s.fmtTime(call.createdAt)}` : `#${e.seq} · ${s.fmtTime(e.createdAt)}`}</span
          >
          <div class="meta-row">${s.toolStatusMeta(name, rp, !!res)}</div>
          ${s.copyButton("Copy", () => s.toolCopyText(call, res))}
        </div>
        ${full}
      </div>`;
    }
    if (unit.kind === "delivery_event") {
      const event = unit.event,
        outbound = event.type === "outbound_delivery",
        delivery = outbound || event.type === "principal_delivery",
        provenance = event.provenance,
        label = event.origin?.label || s.wakeOriginLabel(provenance?.trigger || provenance?.surface),
        mirror = s.slackMirrorRef(event),
        text = event.text || "",
        shown = open.has(unit) ? "Hide" : "Show";
      let deliveryState = "delivery";
      if (event.shadow) deliveryState = "shadow";
      else if (event.expiredAt) deliveryState = "dropped";
      else if (delivery) deliveryState = "delivered";
      const bodyText = [
        event.destination?.onBehalfOf ? "from " + event.destination.onBehalfOf : null,
        outbound && event.destination?.target ? "to " + event.destination.target : null,
        provenance?.fireKey || event.origin?.fireKey ? "origin " + (provenance?.fireKey || event.origin.fireKey) : null,
        outbound && event.recipientThreadRef ? "recipient thread " + event.recipientThreadRef : null,
        text,
      ]
        .filter((x) => x != null)
        .join("\n")
        .trim();
      const panel = event.llmRequests?.length ? memo(panels, unit, () => requestsPanel(event.llmRequests, s)) : null;
      panel?.classList.add("inline-context");
      panel?.classList.toggle("collapsed", !open.has(unit));
      let originLink: unknown = provenance ? s.metaChip(label) : nothing;
      if (event.sourceSession?.id)
        originLink = html`<button
          type="button"
          class="origin-link"
          title=${`Open origin session ${s.shortId(event.sourceSession.id)} · ${provenance?.fireKey || event.idempotencyKey || ""}`}
          @click=${() => s.go({ view: "history", scope: s.scope, session: event.sourceSession.id })}
        >
          ${label}
        </button>`;
      return html`<div
        class=${classMap({ entry: true, "delivery-event-entry": true, filtered: s.entryHidden([outbound ? "outbound_delivery" : "principal_delivery"], false) })}
      >
        <div class="who">
          ${event.llmRequests?.length ? contextIcon(shown + " context", shown + " context · " + requestCount(event.llmRequests.length), toggle(unit), open.has(unit)) : nothing}<span
            class="entry-label important"
            >${event.shadow || delivery ? s.deliveryLabel(event) : "Delivery event"}</span
          >${event.shadow ? html`<span class="entry-label" title="Recorded for observability, never sent to the human (shadow-mode rollout)">not sent</span>` : nothing}${!event.shadow && event.expiredAt ? html`<span class="entry-label" title="Dropped undelivered — the destination failed permanently or the message aged out">never sent</span>` : nothing}${delivery ? badge(s.deliverySurfaceLabel(event), "info") : nothing}${outbound ? nothing : originLink}${cronLink(event.origin)}${
            mirror
              ? html`<a
                  class="link"
                  href=${s.stateToUrl({ view: "slack", container: mirror.container, ts: mirror.ts })}
                  title=${"Jump to this message in the mirrored Slack channel " + mirror.container}
                  @click=${(e: MouseEvent) => {
                    if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
                    e.preventDefault();
                    s.go({ view: "slack", container: mirror.container, ts: mirror.ts });
                  }}
                  >View in Slack mirror ↗</a
                >`
              : nothing
          }<span class="when">${deliveryState + " · " + s.fmtTime(event.createdAt)}</span
          >${s.copyButton("Copy", () => text)}
        </div>
        ${panel ?? nothing}
        <pre>${bodyText}</pre>
        ${s.deliveryFileBadges(event.attachments)}
      </div>`;
    }
    const e = unit.entry,
      noise = s.entryIsNoise(e),
      isOrigin = origin && e.type === "user" && e.seq === originPromptSeq,
      text = s.payloadText(e.payload);
    let label = s.titleCase(e.type || "entry");
    if (e.type === "assistant") label = s.brandSelfLabel();
    else if (e.type === "user") label = s.payloadName(e.payload) || "User";
    if (isOrigin) label = origin.label || s.wakeOriginLabel(origin.trigger);
    const files =
      e.type === "delivery" || (e.type === "tool_result" && e.payload?.tool === "attach")
        ? s.deliveryFileBadges(e.payload?.files || [])
        : nothing;
    return html`<div
      class=${classMap({ entry: true, noise, collapsed: noise && !open.has(unit), "thinking-entry": e.type === "thinking", "message-entry": e.type === "user" || e.type === "assistant", "user-entry": e.type === "user", "assistant-entry": e.type === "assistant", "cron-prompt-entry": !!isOrigin, "system-entry": e.type === "system", filtered: s.entryHidden([e.type], false) })}
    >
      <div class="who">
        ${unit.llmReqs?.length ? contextButton(unit.llmReqs[0].turnSeq, unit.llmReqs.length) : nothing}${noise ? html`<button type="button" class="disclosure" aria-expanded=${String(open.has(unit))} aria-label=${open.has(unit) ? "Collapse entry" : "Expand entry"} title=${open.has(unit) ? "Collapse entry" : "Expand entry"} @click=${toggle(unit)}>${open.has(unit) ? "▾" : "▸"}</button>` : nothing}<span
          class=${"entry-label" + (isOrigin ? " important" : "")}
          >${label}</span
        >${isOrigin ? cronLink(origin, session.scopeId) : nothing}${e.type !== "user" ? s.stepDurEl([[dur.get(e.seq)]]) : nothing}<span
          class="when"
          >${"#" + e.seq + " · " + s.fmtTime(e.createdAt)}</span
        >${s.copyButton("Copy", () => text)}
      </div>
      ${body(e)}${files}
    </div>`;
  }
  const load = () => {
    if (first > 0) reveal();
    else void show(sessionId, reqLimit * 4, true, s);
  };
  function paint() {
    if (!current()) return;
    controls();
    const more = first === 0 || paused;
    draw(
      html`<div class="detail">
        <div>
          ${errors.length ? s.errorStripBox(errors, s.plural(errors.length, "error") + " logged in this session", 5) : nothing}
        </div>
        ${
          units.length
            ? html`<div class="transcript-stream">
                ${
                  first > 0 || data.hasMore
                    ? html`<div
                        class=${"load-earlier" + (more ? " more" : "")}
                        aria-hidden=${String(!more)}
                        role=${more ? "button" : "presentation"}
                        tabindex=${more ? 0 : -1}
                        @click=${more ? load : nothing}
                        @keydown=${more ? activate(load) : nothing}
                      >
                        ${more ? "Load earlier messages" : "Loading earlier messages…"}
                      </div>`
                    : nothing
                }${repeat(units.slice(first), (unit) => unit, unitTemplate)}
              </div>`
            : html`<p class="empty">No entries.</p>`
        }
      </div>`,
    );
  }
  function reveal() {
    if (!current() || first <= 0) return;
    observer?.disconnect();
    const pane = scroller(root),
      height = pane.scrollHeight,
      top = pane.scrollTop;
    rewind(first);
    paused = false;
    paint();
    const added = pane.scrollHeight - height;
    pane.scrollTo({ top: top + added });
    paused = !!observer && first > 0 && added <= 1;
    if (paused) paint();
    else observe();
  }
  function observe() {
    const sentinel = root.querySelector(".load-earlier");
    if (sentinel && first > 0) observer?.observe(sentinel);
  }
  applyVisibility = paint;
  paint();
  observe();
  void s
    .adminErrors("scope=" + encodeURIComponent(s.scope) + "&sessionId=" + encodeURIComponent(sessionId))
    .then((rows: Row[]) => {
      if (current()) {
        errors = rows;
        paint();
      }
    })
    .catch(() => {});
  requestAnimationFrame(() => {
    if (current()) scroller(root).scrollTo({ top: expand ? 0 : scroller(root).scrollHeight });
  });
}
