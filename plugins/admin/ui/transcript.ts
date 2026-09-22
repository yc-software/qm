import { html, nothing } from "lit";
import { classMap } from "lit/directives/class-map.js";
import { repeat } from "lit/directives/repeat.js";
import { node, renderer, badge } from "./shared.ts";
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
export function prepare(data: Row, requests: Row[]) {
  const entries: Row[] = data.entries || [],
    events: Row[] = data.deliveryEvents || [],
    llm = new Map<any, Row[]>(),
    byEntry = new Map<any, Row[]>(),
    dur = new Map<number, number>();
  for (const req of requests) {
    const key = req.turnSeq ?? "_orphan";
    if (!llm.has(key)) llm.set(key, []);
    llm.get(key)!.push(req);
  }
  for (let i = 1; i < entries.length; i++) {
    const delta = (entries[i].createdAt || 0) - (entries[i - 1].createdAt || 0);
    if (delta >= 0) dur.set(entries[i].seq, delta);
  }
  const seqIndex = new Map(entries.map((e, i) => [e.seq, i]));
  for (const [turn, reqs] of llm) {
    if (turn === "_orphan" || turn < (entries[0]?.seq || 0)) continue;
    const start = seqIndex.get(turn);
    if (start === undefined) {
      llm.set("_orphan", [...(llm.get("_orphan") || []), ...reqs]);
      continue;
    }
    let stop = entries.findIndex((e, i) => i > start && e.type === "user");
    if (stop < 0) stop = entries.length;
    let anchor = start;
    for (let i = stop - 1; i > start; i--)
      if (entries[i].type === "assistant") {
        anchor = i;
        break;
      }
    byEntry.set(entries[anchor].seq, [
      ...(byEntry.get(entries[anchor].seq) || []),
      ...reqs.slice().sort((a, b) => (a.step || 0) - (b.step || 0)),
    ]);
  }
  const results = new Map<any, Row>(),
    outbound = new Map<any, Row>(),
    principalIds = new Set(),
    pairedSeqs = new Set(),
    merged = new Set();
  for (const e of entries)
    if (e.type === "tool_result" && e.payload?.callId && !results.has(e.payload.callId))
      results.set(e.payload.callId, e);
  for (const e of events) {
    if (e.deliveryId && e.type === "outbound_delivery" && !outbound.has(e.deliveryId)) outbound.set(e.deliveryId, e);
    if (e.deliveryId && e.type === "principal_delivery") principalIds.add(e.deliveryId);
  }
  const units: Row[] = [];
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i];
    if (e.type === "soul") continue;
    if (e.type === "tool_call" || e.type === "tool_result") {
      if (e.type === "tool_result" && pairedSeqs.has(e.seq)) continue;
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
    } else units.push({ kind: "entry", entry: e, llmReqs: byEntry.get(e.seq) });
  }
  for (const event of events)
    if (!event.deliveryId || !merged.has(event.deliveryId)) units.push({ kind: "delivery_event", event });
  units.sort(
    (a, b) => ((a.primary || a.entry || a.event)?.createdAt || 0) - ((b.primary || b.entry || b.event)?.createdAt || 0),
  );
  if (llm.get("_orphan")?.length) units.push({ kind: "llm", reqs: llm.get("_orphan") });
  return {
    units,
    dur,
    principalIds,
    originPromptSeq: data.origin && !data.hasMore ? entries.find((e) => e.type === "user")?.seq : null,
  };
}
export function requestsPanel(requests: Row[], s: Row, opts: Row = {}) {
  const host = document.createDocumentFragment(),
    draw = renderer(host as unknown as HTMLElement);
  let open = !!opts.embedded;
  const sections = requests.map((q) => s.contextSections(s.requestBody(q), q.transport));
  const selected = sections.map((list: Row[]) =>
    opts.selectLargest && list.length ? list.reduce((a, b) => (b.tokens > a.tokens ? b : a)).key : null,
  );
  const latest = requests.at(-1) || { request: {} },
    latestSections = opts.latestSections || sections.at(-1) || [],
    cache = s.sumCacheUsage(requests);
  const stats = () =>
    html`<div class="context-stats">
      ${s.metaChip((latest.model || "?") + " · " + s.fmtContextSize(latest, latestSections))}${s.cacheMetaItems(cache)}${s.rawJsonLink(requests)}
    </div>`;
  function paint() {
    draw(
      html`<div
        class=${classMap({ entry: !opts.embedded, collapsed: !open, llm: true, "context-turn": true, "context-page": !!opts.page, "cache-miss": !!cache && s.isStablePrefixMiss(cache) })}
      >
        ${
          opts.page
            ? nothing
            : html`<div class="who">
                ${
                  opts.embedded
                    ? nothing
                    : html`<button
                          type="button"
                          class="disclosure"
                          aria-expanded=${String(open)}
                          aria-label=${open ? "Collapse model context" : "Expand model context"}
                          title=${open ? "Collapse model context" : "Expand model context"}
                          @click=${() => {
                            open = !open;
                            paint();
                          }}
                        >
                          ${open ? "▾" : "▸"}</button
                        ><span class="role">sent to model</span>`
                }${stats()}
              </div>`
        }
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
  const request = ++generation,
    root = document.getElementById("view-data")!;
  root.replaceChildren();
  const draw = renderer(root);
  s.pageShell({ back: { label: "← Back to transcript", onClick: () => history.back() }, title: "Sent to model" });
  draw(html`<div class="detail">Loading…</div>`);
  const result = await s.api(
    "GET",
    "/api/sessions/" +
      encodeURIComponent(sessionId) +
      "/llm?turnSeq=" +
      encodeURIComponent(turnSeq) +
      "&scope=" +
      encodeURIComponent(s.scope),
  );
  if (request !== generation || !s.current(sessionId, turnSeq)) return;
  if (!result.ok)
    return draw(
      html`<div class="detail">${result.data?.message || `Failed to load context (${result.status}).`}</div>`,
    );
  const requests = (result.data.requests || []).slice().sort((a: Row, b: Row) => (a.step || 0) - (b.step || 0)),
    label = turnSeq === "orphan" ? "unattributed context" : `turn #${turnSeq}`,
    latest = requests.at(-1),
    sections = latest ? s.contextSections(s.requestBody(latest), latest.transport) : [];
  draw(
    html`<div class="detail">
      <div class="context-page-head">
        <h2>${"Sent to model · " + label + (requests.length > 1 ? " · " + requests.length + " steps" : "")}</h2>
        ${requests.length ? html`<div class="context-stats">${s.metaChip((latest.model || "?") + " · " + s.fmtContextSize(latest, sections))}${s.cacheMetaItems(s.sumCacheUsage(requests))}${s.rawJsonLink(requests)}</div>` : nothing}
      </div>
      ${requests.length ? requestsPanel(requests, s, { embedded: true, page: true, selectLargest: true, latestSections: sections }) : html`<p class="context-empty">No context was captured for this turn.</p>`}
    </div>`,
  );
}
export async function show(sessionId: string, limit: number | undefined, expand: boolean | undefined, s: Row) {
  const request = ++generation,
    root = document.getElementById("view-data")!,
    reqLimit = limit || s.pageSize;
  root.replaceChildren();
  const draw = renderer(root),
    current = () => request === generation && s.current(sessionId);
  const back = (sessionScope?: string) => () => {
    if (history.state?.deepLink)
      s.go({ view: "history", scope: sessionScope || s.scope, session: null, historyKind: s.historyKind });
    else history.back();
  };
  s.pageShell({
    back: { label: "← Conversations", onClick: back() },
    title: "Conversation",
    context: s.shortName(s.scope),
  });
  let applyVisibility = () => {};
  const header = document.getElementById("header-controls")!;
  header.replaceChildren();
  const paintHeader = renderer(header);
  function controls() {
    paintHeader(
      html`${[
        ["thinking", "thinking"],
        ["tool results", "toolResults"],
      ].map(
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
  draw(html`<div class="detail">Loading…</div>`);
  const llmPromise = s.api(
    "GET",
    "/api/sessions/" + encodeURIComponent(sessionId) + "/llm?scope=" + encodeURIComponent(s.scope),
  );
  const result = await s.api(
    "GET",
    "/api/sessions/" + encodeURIComponent(sessionId) + "?scope=" + encodeURIComponent(s.scope) + "&limit=" + reqLimit,
  );
  if (!current()) return;
  if (!result.ok)
    return draw(
      html`<div class="detail">${result.data?.message || `Failed to load transcript (${result.status}).`}</div>`,
    );
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
  let requests: Row[] = [];
  try {
    const llm = await llmPromise;
    if (llm.ok) requests = llm.data.requests || [];
  } catch {
    requests = [];
  }
  if (!current()) return;
  const { units, dur, principalIds, originPromptSeq } = prepare(data, requests),
    open = new Set<Row>(),
    bodyNodes = new Map<Row, Node>(),
    toolNodes = new Map<Row, Row>(),
    panels = new Map<Row, Node>();
  let errors: Row[] = [],
    first = 0,
    paused = false;
  const observer =
    "IntersectionObserver" in window
      ? new IntersectionObserver(
          (entries) => {
            if (entries.some((e) => e.isIntersecting)) reveal();
          },
          { rootMargin: "800px 0px" },
        )
      : null;
  s.setObserver(observer);
  if (observer && !expand) {
    first = Math.max(0, units.length - 60);
    while (first > 0 && units[first].kind === "llm") first--;
  }
  const contextButton = (turn: any, count: number) =>
    html`<button
      type="button"
      class="context-icon"
      aria-label="View context sent to the model"
      title=${"View context sent to the model · " + count + " request" + (count === 1 ? "" : "s")}
      @click=${(e: Event) => {
        e.stopPropagation();
        s.go({ view: "history", scope: s.scope, session: sessionId, turn });
      }}
    >
      ${brain}
    </button>`;
  const timing = (unit: Row) => {
    const call = unit.primary.type === "tool_call" ? unit.primary : null,
      res = unit.primary.type === "tool_result" ? unit.primary : unit.paired;
    return call && res
      ? [
          [dur.get(call.seq), "model"],
          [(res.createdAt || 0) - (call.createdAt || 0), "exec"],
        ]
      : [[dur.get((call || res)?.seq)]];
  };
  function fullTool(unit: Row) {
    if (!toolNodes.has(unit)) {
      const call = unit.primary.type === "tool_call" ? unit.primary : null,
        res = unit.primary.type === "tool_result" ? unit.primary : unit.paired;
      toolNodes.set(
        unit,
        s.renderToolEntry(
          call,
          res,
          unit.llmReqs?.length ? node(contextButton(unit.llmReqs[0].turnSeq, unit.llmReqs.length)) : null,
          s.stepDurEl(timing(unit)),
          unit.delivery || null,
        ),
      );
    }
    const built = toolNodes.get(unit)!;
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
  function body(entry: Row) {
    if (!bodyNodes.has(entry)) {
      const text = s.payloadText(entry.payload);
      let value: Node;
      if (entry.type === "user" && s.isXmlishText(text)) value = s.renderXmlish(text);
      else if (entry.type === "user" || entry.type === "assistant") value = s.renderMarkdown(text);
      else value = node(html`<pre>${text}</pre>`);
      if ((value as Element).tagName === "PRE") value.textContent = text;
      bodyNodes.set(entry, value);
    }
    return bodyNodes.get(entry);
  }
  function unitTemplate(unit: Row) {
    if (unit.kind === "llm")
      return html`<div class="entry llm">
        <div class="who">${contextButton("orphan", unit.reqs.length)}<span class="role">captured context</span></div>
      </div>`;
    if (unit.kind === "tool") {
      const e = unit.primary,
        call = e.type === "tool_call" ? e : null,
        res = e.type === "tool_result" ? e : unit.paired,
        types = unit.paired ? ["tool_call", "tool_result"] : [e.type];
      if (unit.delivery) {
        types.push("outbound_delivery");
        if (principalIds.has(unit.delivery.deliveryId)) types.push("principal_delivery");
      }
      const hidden = s.entryHidden(types, !!unit.delivery),
        full = fullTool(unit);
      full.classList.toggle("filtered", hidden);
      if (unit.delivery || unit.llmReqs?.length) return full;
      const cp = call?.payload,
        rp = res?.payload,
        name = s.toolName(cp, rp),
        toggle = () => {
          if (open.has(unit)) open.delete(unit);
          else open.add(unit);
          paint();
        };
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
            if (!(e.target as Element).closest(".copy")) toggle();
          }}
          @keydown=${(e: KeyboardEvent) => {
            if (e.key === "Enter" || e.key === " ") {
              e.preventDefault();
              toggle();
            }
          }}
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
        text = event.text || "";
      let deliveryState = "delivery";
      if (event.shadow) deliveryState = "shadow";
      else if (event.expiredAt) deliveryState = "dropped";
      else if (delivery) deliveryState = "delivered";
      const bodyText = [
        event.destination?.onBehalfOf ? "from " + event.destination.onBehalfOf : null,
        outbound && event.destination?.target ? "to " + event.destination.target : null,
        event.provenance?.fireKey || event.origin?.fireKey
          ? "origin " + (event.provenance?.fireKey || event.origin.fireKey)
          : null,
        outbound && event.recipientThreadRef ? "recipient thread " + event.recipientThreadRef : null,
        text,
      ]
        .filter((x) => x != null)
        .join("\n")
        .trim();
      if (event.llmRequests?.length && !panels.has(unit))
        panels.set(unit, requestsPanel(event.llmRequests, s, { embedded: true }));
      let originLink: unknown = nothing;
      if (provenance) originLink = s.metaChip(label);
      if (event.sourceSession?.id)
        originLink = html`<button
          type="button"
          class="origin-link"
          title=${`Open origin session ${s.shortId(event.sourceSession.id)} · ${provenance?.fireKey || event.idempotencyKey || ""}`}
          @click=${() => s.go({ view: "history", scope: s.scope, session: event.sourceSession.id })}
        >
          ${label}
        </button>`;
      const toggle = () => {
        if (open.has(unit)) open.delete(unit);
        else open.add(unit);
        paint();
      };
      return html`<div
        class=${classMap({ entry: true, "delivery-event-entry": true, filtered: s.entryHidden([outbound ? "outbound_delivery" : "principal_delivery"], false) })}
      >
        <div class="who">
          ${event.llmRequests?.length ? html`<button type="button" class=${"context-icon" + (open.has(unit) ? " active" : "")} aria-expanded=${String(open.has(unit))} aria-label=${(open.has(unit) ? "Hide" : "Show") + " context"} title=${(open.has(unit) ? "Hide" : "Show") + " context · " + event.llmRequests.length + " request" + (event.llmRequests.length === 1 ? "" : "s")} @click=${toggle}>${brain}</button>` : nothing}<span
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
        ${panels.has(unit) ? panelVisibility(panels.get(unit)!, open.has(unit)) : nothing}
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
    const toggle = () => {
      if (open.has(unit)) open.delete(unit);
      else open.add(unit);
      paint();
    };
    const files =
      e.type === "delivery" || (e.type === "tool_result" && e.payload?.tool === "attach")
        ? s.deliveryFileBadges(e.payload?.files || [])
        : nothing;
    return html`<div
      class=${classMap({ entry: true, noise, collapsed: noise && !open.has(unit), "thinking-entry": e.type === "thinking", "message-entry": e.type === "user" || e.type === "assistant", "user-entry": e.type === "user", "assistant-entry": e.type === "assistant", "cron-prompt-entry": !!isOrigin, "system-entry": e.type === "soul" || e.type === "system", filtered: s.entryHidden([e.type], false) })}
    >
      <div class="who">
        ${unit.llmReqs?.length ? contextButton(unit.llmReqs[0].turnSeq, unit.llmReqs.length) : nothing}${noise ? html`<button type="button" class="disclosure" aria-expanded=${String(open.has(unit))} aria-label=${open.has(unit) ? "Collapse entry" : "Expand entry"} title=${open.has(unit) ? "Collapse entry" : "Expand entry"} @click=${toggle}>${open.has(unit) ? "▾" : "▸"}</button>` : nothing}<span
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
  function panelVisibility(panel: Node, visible: boolean) {
    (panel as HTMLElement).classList.add("inline-context");
    (panel as HTMLElement).classList.toggle("collapsed", !visible);
    return panel;
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
                        @keydown=${(e: KeyboardEvent) => {
                          if (more && (e.key === "Enter" || e.key === " ")) {
                            e.preventDefault();
                            load();
                          }
                        }}
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
    const height = document.body.scrollHeight,
      top = window.scrollY;
    first = Math.max(0, first - 60);
    while (first > 0 && units[first].kind === "llm") first--;
    paused = false;
    paint();
    const added = document.body.scrollHeight - height;
    window.scrollTo({ top: top + added });
    if (first > 0 && observer) {
      if (added > 1) observe();
      else {
        paused = true;
        paint();
      }
    }
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
    if (current()) window.scrollTo({ top: expand ? 0 : document.body.scrollHeight });
  });
}
