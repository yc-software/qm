import { html, nothing, type TemplateResult } from "lit";
import { repeat } from "lit/directives/repeat.js";
import { renderer } from "./shared.ts";
import { changedMessages, contentParts, exactText, snapshot, toolName, turnEntries } from "./agent-seat-model.ts";

type Row = Record<string, any>;

function parameterSchema(schema: any, depth = 0): TemplateResult {
  if (schema === false) return html`<p class="agent-parameter-note">No values allowed.</p>`;
  if (schema === true) return html`<p class="agent-parameter-note">Any value.</p>`;
  if (!schema || typeof schema !== "object") return html`<p class="agent-parameter-note">Schema unavailable.</p>`;
  const properties = Object.entries(schema.properties ?? {});
  const variants = schema.oneOf ?? schema.anyOf ?? schema.allOf;
  let variantLabel = "All of";
  if (schema.oneOf) variantLabel = "Exactly one of";
  else if (schema.anyOf) variantLabel = "Any of";
  return html`
    ${schema.description ? html`<p class="agent-parameter-description">${schema.description}</p>` : nothing}
    ${schema.enum ? html`<p class="agent-parameter-note">Choices: ${schema.enum.map((value: unknown) => html`<code>${JSON.stringify(value)}</code> `)}</p>` : nothing}
    ${schema.const !== undefined ? html`<p class="agent-parameter-note">Value: <code>${JSON.stringify(schema.const)}</code></p>` : nothing}
    ${schema.default !== undefined ? html`<p class="agent-parameter-note">Default: <code>${JSON.stringify(schema.default)}</code></p>` : nothing}
    ${schema.$ref ? html`<p class="agent-parameter-note">See definition: <code>${schema.$ref}</code></p>` : nothing}
    ${
      depth < 6
        ? html`
            ${
              properties.length
                ? html`<dl class="agent-parameters">
                    ${properties.map(([name, value]) => {
                      const field = value as Row;
                      let type = field?.type ?? "";
                      if (!type && field?.properties) type = "object";
                      else if (!type && field?.items) type = "array";
                      return html`<div class="agent-parameter">
                        <dt>
                          <code>${name}</code><span>${Array.isArray(type) ? type.join(" or ") : type}</span
                          ><span class="agent-parameter-required"
                            >${schema.required?.includes(name) ? "Required" : "Optional"}</span
                          >
                        </dt>
                        <dd>${parameterSchema(value, depth + 1)}</dd>
                      </div>`;
                    })}
                  </dl>`
                : nothing
            }
            ${
              schema.items != null
                ? html`<details>
                    <summary>Array items</summary>
                    ${parameterSchema(schema.items, depth + 1)}
                  </details>`
                : nothing
            }
            ${
              Array.isArray(variants)
                ? html`<details>
                    <summary>${variantLabel} ${variants.length} variants</summary>
                    ${variants.map(
                      (variant: Row, i: number) =>
                        html`<div class="agent-parameter">
                          <h4>Variant ${i + 1}</h4>
                          ${parameterSchema(variant, depth + 1)}
                        </div>`,
                    )}
                  </details>`
                : nothing
            }
          `
        : html`<p class="agent-parameter-note">Further nesting is available in the exact tool definition.</p>`
    }
    ${schema.type === "object" && !properties.length && !variants ? html`<p class="agent-parameter-note">${schema.additionalProperties === false ? "No parameters." : "No named parameters specified."}</p>` : nothing}
  `;
}

let generation = 0;
export function cancel() {
  generation++;
}

export async function show(root: HTMLElement, sessionId: string, s: Row, initialTurn?: string) {
  const run = ++generation;
  const [requestedTurn, requestedSeq] = (initialTurn ?? "").split(":");
  const targetSeq = requestedSeq != null && /^\d+$/.test(requestedSeq) ? Number(requestedSeq) : null;
  let focusedSeq: number | null = null;
  const alive = () =>
    run === generation && s.current(sessionId, initialTurn == null ? "agent" : "agent:" + initialTurn);
  root.replaceChildren();
  const paint = renderer(root);
  let requests: Row[] = [];
  let data: Row = {};
  let index = 0;
  let selectedTool = 0;
  let error = "";
  let loading = true;
  let revealed = 1;
  let selection = 0;
  const turns = new Map<string, Row[]>();
  const path = "/api/sessions/" + encodeURIComponent(sessionId);
  const query = "scope=" + encodeURIComponent(s.scope);
  const route = (id: string) => ({ view: "history", scope: s.scope, session: id, turn: "agent" });
  s.pageShell({
    title: "Be the agent",
    back: { label: "← Transcript", onClick: () => s.go({ ...route(sessionId), turn: null }) },
  });
  document.getElementById("header-controls")?.replaceChildren();

  async function select(next: number, focus: number | null = null) {
    index = next;
    selectedTool = 0;
    focusedSeq = focus;
    const events = turnEntries(data.entries || [], requests[next]?.turnSeq ?? null);
    revealed = focus == null ? 1 : Math.max(1, events.findIndex((entry) => entry.seq === focus) + 1);
    error = "";
    const ticket = ++selection;
    const request = requests[index];
    if (!request) return draw();
    const turn = String(request.turnSeq ?? "orphan");
    loading = true;
    draw();
    try {
      if (!turns.has(turn)) {
        const result = await s.api("GET", path + "/llm?" + query + "&turnSeq=" + encodeURIComponent(turn));
        if (!alive() || ticket !== selection) return;
        if (!result.ok) throw new Error(result.data?.message || `Could not load this turn (${result.status}).`);
        turns.set(turn, result.data.requests || []);
      }
      const records = new Map(turns.get(turn)!.map((row: Row) => [row.id, row]));
      requests = requests.map((row) => records.get(row.id) ?? row);
      if (!records.has(request.id)) throw new Error("This capture is no longer available. Reload the session.");
    } catch (cause) {
      if (alive() && ticket === selection) error = cause instanceof Error ? cause.message : String(cause);
    } finally {
      if (alive() && ticket === selection) {
        loading = false;
        draw();
      }
    }
  }

  function draw() {
    const request = requests[index];
    const current = request ? snapshot(request) : null;
    const previousRecord = requests[index - 1];
    const previous =
      previousRecord && (previousRecord.promptEnvelope != null || previousRecord.request != null)
        ? snapshot(previousRecord)
        : null;
    const additions =
      current && previous ? changedMessages(current.conversation, previous.conversation) : new Set<number>();
    const tool = current?.tools[selectedTool];
    const transcript = request ? turnEntries(data.entries || [], request.turnSeq) : [];
    paint(
      html`<div class="agent-seat">
        ${error ? html`<p role="alert">${error}</p>` : nothing}
        <div class="agent-seat-toolbar">
          <button
            type="button"
            aria-label="Return to transcript"
            title="Return to transcript"
            @click=${() => s.go({ ...route(sessionId), turn: null })}
          >
            ↖
          </button>
          <button
            type="button"
            aria-label="Previous model call"
            title="Previous model call"
            ?disabled=${index <= 0 || loading}
            @click=${() => void select(index - 1)}
          >
            ←
          </button>
          <button
            type="button"
            aria-label="Next model call"
            title="Next model call"
            ?disabled=${index >= requests.length - 1 || loading}
            @click=${() => void select(index + 1)}
          >
            →
          </button>
        </div>
        ${loading ? html`<p role="status">Loading…</p>` : nothing}
        ${!loading && !requests.length && !error ? html`<p>No model requests were captured.</p>` : nothing}
        ${
          !loading && !error && current
            ? html`
                ${current.truncated ? html`<p class="agent-seat-warning">This capture is truncated. Some input is unavailable.</p>` : nothing}
                <div class="agent-seat-layout">
                  <section class="agent-seat-context" aria-label="Captured context">
                    <div class="agent-seat-scroll">
                      ${
                        current.blocks.length
                          ? current.blocks.map(
                              (block) =>
                                html`<section class="agent-seat-block">
                                  ${contentParts(block.value).map((text) => html`<pre class="agent-seat-prose">${text}</pre>`)}
                                </section>`,
                            )
                          : html`<p>No system prompt was captured.</p>`
                      }
                      ${repeat(
                        current.conversation,
                        (_, i) => request.id + ":" + i,
                        (message, i) =>
                          html`<section class=${"agent-seat-block" + (additions.has(i) ? " agent-seat-added" : "")}>
                            ${contentParts(message.content ?? message).map((text) => html`<pre>${text}</pre>`)}
                            <details>
                              <summary aria-label="Full message fields" title="Full message fields">⋯</summary>
                              <pre>${exactText(message)}</pre>
                            </details>
                          </section>`,
                      )}
                      ${
                        !current.conversation.length
                          ? html`<div class="agent-seat-gap">
                              <p>
                                This record contains no conversation messages. The session transcript below is separate
                                evidence; it does not establish the exact history, compaction, or injections sent on
                                this call.
                              </p>
                            </div>`
                          : nothing
                      }
                    </div>
                  </section>
                  <aside class="agent-seat-tools" aria-label="Captured tools">
                    <div class="agent-seat-tool-list" aria-label="Tools">
                      ${current.tools.map(
                        (item, i) =>
                          html`<button
                            type="button"
                            aria-pressed=${selectedTool === i ? "true" : "false"}
                            @click=${() => {
                              selectedTool = i;
                              draw();
                            }}
                          >
                            ${toolName(item, i)}
                          </button>`,
                      )}
                    </div>
                    ${
                      tool
                        ? html`<div class="agent-seat-tool-detail">
                            <pre class="agent-seat-prose">${tool.description}</pre>
                            ${
                              tool.parameters != null
                                ? html`<section class="agent-parameter-section" aria-label="Tool parameters">
                                    ${parameterSchema(tool.parameters)}
                                  </section>`
                                : nothing
                            }
                            <details>
                              <summary aria-label="Exact tool definition" title="Exact tool definition">⋯</summary>
                              <pre>${exactText(tool.raw)}</pre>
                            </details>
                          </div>`
                        : html`<p>No tool schemas were captured. This does not mean the agent had no tools.</p>`
                    }
                  </aside>
                </div>
                <div class="agent-seat-evidence">
                  <div class="agent-seat-toolbar">
                    <button
                      type="button"
                      aria-label="Previous recorded event"
                      title="Previous recorded event"
                      ?disabled=${revealed <= 1}
                      @click=${() => {
                        revealed--;
                        draw();
                      }}
                    >
                      ←
                    </button>
                    <button
                      type="button"
                      aria-label="Reveal next recorded event"
                      title="Reveal next recorded event"
                      ?disabled=${revealed >= transcript.length}
                      @click=${() => {
                        revealed++;
                        draw();
                      }}
                    >
                      →
                    </button>
                    <span
                      >Recorded turn · ${Math.min(revealed, transcript.length)} / ${transcript.length} events · not a
                      per-call replay</span
                    >
                  </div>
                  <div class="agent-seat-transcript" aria-live="polite">
                    ${
                      transcript.length
                        ? transcript.slice(0, revealed).map(
                            (entry) =>
                              html`<section
                                class=${"agent-seat-block" + (entry.seq === focusedSeq ? " agent-seat-focused" : "")}
                                aria-current=${entry.seq === focusedSeq ? "step" : nothing}
                              >
                                <pre>${exactText(entry.payload)}</pre>
                              </section>`,
                          )
                        : html`<p>The transcript for this turn is not in the loaded history.</p>`
                    }
                  </div>
                  ${
                    data.hasMore
                      ? html`<button
                          type="button"
                          @click=${async () => {
                            const ticket = selection;
                            try {
                              const result = await s.api("GET", path + "?" + query + "&limit=50000");
                              if (!alive() || ticket !== selection) return;
                              if (!result.ok)
                                throw new Error(result.data?.message || "Could not load earlier transcript.");
                              data = result.data;
                              draw();
                            } catch (cause) {
                              if (!alive() || ticket !== selection) return;
                              error = cause instanceof Error ? cause.message : String(cause);
                              draw();
                            }
                          }}
                        >
                          Load earlier transcript
                        </button>`
                      : nothing
                  }
                </div>
                <details class="agent-seat-raw">
                  <summary aria-label="Capture metadata and raw request" title="Capture metadata and raw request">
                    ⋯
                  </summary>
                  <pre>${exactText(request)}</pre>
                </details>
              `
            : nothing
        }
      </div>`,
    );
  }
  draw();
  try {
    const [meta, transcript] = await Promise.all([
      s.api("GET", path + "/llm?" + query),
      s.api("GET", path + "?" + query + "&limit=500"),
    ]);
    if (!alive()) return;
    if (!meta.ok) throw new Error(meta.data?.message || `Could not load session (${meta.status}).`);
    if (!transcript.ok)
      throw new Error(transcript.data?.message || `Could not load transcript (${transcript.status}).`);
    data = transcript.data;
    requests = (meta.data.requests || [])
      .slice()
      .sort((a: Row, b: Row) => a.createdAt - b.createdAt || a.step - b.step);
    if (requests.length) {
      if (targetSeq != null && !data.entries?.some((entry: Row) => entry.seq === targetSeq) && data.hasMore) {
        const full = await s.api("GET", path + "?" + query + "&limit=50000");
        if (!alive()) return;
        if (!full.ok) throw new Error("Could not load the selected event.");
        data = full.data;
      }
      const turn = requestedTurn || String(requests.at(-1)!.turnSeq ?? "orphan");
      const start = requests.findIndex((request) => String(request.turnSeq ?? "orphan") === turn);
      if (start < 0) {
        index = -1;
        throw new Error(`No model request was captured for turn #${turn}. Choose another model call above.`);
      }
      const event = targetSeq == null ? null : data.entries?.find((entry: Row) => entry.seq === targetSeq);
      if (targetSeq != null && !event) throw new Error(`Sequence #${targetSeq} is not in the loaded transcript.`);
      const preceding =
        event?.createdAt == null
          ? -1
          : requests.findLastIndex(
              (request) => String(request.turnSeq ?? "orphan") === turn && request.createdAt <= event.createdAt,
            );
      await select(preceding < 0 ? start : preceding, targetSeq);
      if (alive()) root.querySelector(".agent-seat-focused")?.scrollIntoView?.({ block: "nearest" });
    } else {
      loading = false;
      draw();
    }
  } catch (cause) {
    if (!alive()) return;
    error = cause instanceof Error ? cause.message : String(cause);
    loading = false;
    draw();
  }
}
