import { html, nothing, render } from "lit";
import { api, withBase } from "./core-bridge";
import { appState } from "./shell-state";
import { errMessage } from "../../chassis/src/errors";
import { deepLinkPath, parseDeepLink, UI_BASE } from "./deep-link";
import "./board.css";

interface Candidate {
  id: string;
  name: string;
  version: number;
  character: Record<string, unknown>;
}
interface Message {
  id: string;
  senderId: string;
  senderName: string;
  text: string;
  audience: string;
  recipientIds: string[];
  replyTo: string | null;
  threadId: string;
  createdAt: number;
  sequence: number;
}
interface Detail {
  message: Message & { candidates: Candidate[] };
  deliveries: Array<{
    id: string;
    recipientId: string;
    state: string;
    attempts: number;
    createdAt: number;
    updatedAt: number;
    reason?: string | null;
    sessionId?: string;
    runId?: string | null;
    runStatus?: string | null;
  }>;
}
interface Page {
  messages: Message[];
  nextCursor: number;
  hasMore: boolean;
}
interface Preview {
  candidates: Candidate[];
  recipientIds: string[];
}
interface TreeNode {
  peer: { id: string; parentId: string | null; name: string; state: string; character: Record<string, unknown> };
  count: number;
  cap: number;
  sessionId?: string;
  spawn?: { state: string; attempts: number; updatedAt: number; reason: string | null };
}
interface Tree {
  nodes: TreeNode[];
  manageable: boolean;
}

const filterNames = [
  ["text", "Search messages"],
  ["senderId", "Sender ID"],
  ["recipientId", "Intended recipient ID"],
  ["threadId", "Reply thread ID"],
] as const;

export async function renderBoardPage(request: typeof api = api): Promise<void> {
  if (!appState.mainEl) return;
  const host = document.createElement("section");
  host.className = "pane agent-board";
  appState.mainEl.replaceChildren(host);
  const messages = new Map<string, Message>();
  let cursor = 0;
  let more = false;
  let busy = false;
  let generation = 0;
  let notice = "";
  let connectionNotice = "";
  let selected = parseDeepLink(UI_BASE, location.pathname, location.search).item;
  let detail: Detail | null = null;
  let detailRequest = 0;
  let expression = '.[] | select(.group == "new-feature" and .role == "worker")';
  let preview: Preview | null = null;
  let treeRoot = "";
  let tree: Tree | null = null;
  let controlling = false;
  const filters = new URLSearchParams();
  const active = () => host.isConnected && appState.currentView === "board";
  const json = (value: unknown) => JSON.stringify(value, null, 2);
  const stamp = (at: number) => new Date(at).toLocaleString();
  const permalink = (id: string) => deepLinkPath(UI_BASE, "board", null, null, id);
  async function loadTree(id: string): Promise<void> {
    if (treeRoot !== id) tree = null;
    treeRoot = id;
    try {
      const result = await request<Tree>(`/api/peers/${encodeURIComponent(id)}/subtree`);
      if (treeRoot === id && active()) tree = result;
    } catch (error) {
      notice = errMessage(error);
    }
    paint();
  }
  async function control(id: string, action: string, subtree: boolean): Promise<void> {
    if (controlling) return;
    controlling = true;
    paint();
    try {
      await request(`/api/peers/${encodeURIComponent(id)}/lifecycle`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action, subtree }),
      });
      notice = `${action} requested for ${subtree ? "subtree" : "agent"}. History and capacity counts are preserved.`;
      await loadTree(treeRoot);
    } catch (error) {
      notice = errMessage(error);
    } finally {
      controlling = false;
      paint();
    }
  }
  function treeNode(node: TreeNode): ReturnType<typeof html> {
    return html`<li class="board-tree-node">
      <strong>${node.peer.name}</strong> · ${node.peer.state} · ${node.count}/${node.cap} descendants
      ${node.peer.state === "deleted" ? html`<p>${node.spawn && node.spawn.state !== "ready" ? "Session deleted; unfinished spawn reservation still occupies an ancestor slot." : "Session deleted; ancestry retained for surviving descendants."}</p>` : nothing}
      ${
        node.spawn
          ? html`<p>
                Provisioning: ${node.spawn.state} · ${node.spawn.attempts} attempts · ${stamp(node.spawn.updatedAt)}
              </p>
              ${node.spawn.reason ? html`<p role="status">${node.spawn.reason.replaceAll("_", " ")}</p>` : nothing}`
          : nothing
      }
      <small>${node.peer.id}</small>
      ${node.sessionId ? html`<a href=${withBase(`/s/${encodeURIComponent(node.sessionId)}`)}>Open session activity</a>` : nothing}
      <details>
        <summary>Character</summary>
        <pre>${json(node.peer.character)}</pre>
      </details>
      ${
        tree?.manageable
          ? html`<form
              class="board-tree-controls"
              @submit=${(event: SubmitEvent) => {
                event.preventDefault();
                const action = (event.submitter as HTMLButtonElement)?.value;
                if (action)
                  void control(
                    node.peer.id,
                    action,
                    new FormData(event.currentTarget as HTMLFormElement).has("subtree"),
                  );
              }}
            >
              <label><input type="checkbox" name="subtree" /> Include descendants</label>
              ${["pause", "resume", "stop"].map((action) => html`<button class="btn" type="submit" value=${action} ?disabled=${controlling || node.peer.state === "archived" || node.peer.state === "deleted"}>${action}</button>`)}
            </form>`
          : nothing
      }
      <ul>
        ${tree?.nodes.filter((child) => child.peer.parentId === node.peer.id).map(treeNode)}
      </ul>
    </li>`;
  }

  async function select(id: string): Promise<void> {
    selected = id;
    detail = null;
    history.replaceState(history.state, "", permalink(id));
    paint();
    const applied = await loadDetail();
    if (applied === detailRequest && selected === id && active())
      host.querySelector<HTMLElement>("#board-inspector-heading")?.focus();
  }
  async function loadDetail(): Promise<number | null> {
    const id = selected;
    if (!id) return null;
    const version = ++detailRequest;
    let applied = false;
    try {
      const result = await request<Detail>(`/api/peer-messages/${encodeURIComponent(id)}`);
      if (selected === id && active() && version === detailRequest) {
        detail = result;
        applied = true;
      }
    } catch (error) {
      if (selected === id && version === detailRequest) notice = errMessage(error);
    }
    paint();
    return applied ? version : null;
  }
  async function refresh(reset = false): Promise<void> {
    if (!active()) return;
    if (reset) {
      generation++;
      messages.clear();
      cursor = 0;
      more = false;
    } else if (busy) return;
    const version = generation;
    busy = true;
    paint();
    const query = new URLSearchParams(filters);
    query.set("after", String(cursor));
    query.set("limit", "50");
    try {
      const page = await request<Page>(`/api/peer-messages?${query}`);
      if (!active() || version !== generation) return;
      for (const message of page.messages) messages.set(message.id, message);
      cursor = page.nextCursor;
      more = page.hasMore;
      connectionNotice = "";
    } catch (error) {
      if (version === generation)
        connectionNotice = `Connection interrupted: ${errMessage(error)}. Retrying from the last cursor.`;
    } finally {
      if (version === generation) {
        busy = false;
        paint();
      }
    }
  }
  async function evaluate(): Promise<void> {
    const input = expression;
    try {
      const result = await request<Preview>("/api/peer-messages/preview", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ audience: input }),
      });
      if (expression === input) preview = result;
      notice = "";
    } catch (error) {
      notice = errMessage(error);
    }
    paint();
  }
  function paint(): void {
    if (!active()) return;
    render(
      html` <header>
          <h1 class="pane-title">Agent board</h1>
          <p>
            Public within this organization. Intended audiences control notifications, not visibility. Reading never
            wakes agents.
          </p>
        </header>
        <form
          class="board-filters"
          @submit=${(event: SubmitEvent) => {
            event.preventDefault();
            const values = new FormData(event.currentTarget as HTMLFormElement);
            for (const [key] of filterNames) {
              const value = String(values.get(key) ?? "").trim();
              if (value) filters.set(key, value);
              else filters.delete(key);
            }
            void refresh(true);
          }}
        >
          ${filterNames.map(([key, label]) => html`<label>${label}<input name=${key} type=${key === "text" ? "search" : "text"} /></label>`)}
          <button class="btn" type="submit">Apply filters</button>
        </form>
        ${connectionNotice ? html`<p role="status">${connectionNotice}</p>` : nothing}
        ${
          notice
            ? html`<div role="status">
                <p>${notice}</p>
                <button
                  class="btn"
                  @click=${() => {
                    notice = "";
                    paint();
                  }}
                >
                  Dismiss notice
                </button>
              </div>`
            : nothing
        }
        <section aria-label="Spawn tree">
          <h2>Spawn tree</h2>
          <form
            class="board-filters"
            @submit=${(event: SubmitEvent) => {
              event.preventDefault();
              const id = String(new FormData(event.currentTarget as HTMLFormElement).get("agent") ?? "").trim();
              if (id) void loadTree(id);
            }}
          >
            <label>Agent or subtree root ID<input name="agent" .value=${treeRoot} required /></label>
            <button class="btn" type="submit">Inspect subtree</button>
          </form>
          <p>
            All descendants count, including idle and archived agents. Stopping an agent does not stop its descendants
            unless selected.
          </p>
          ${
            tree
              ? html` <ul class="board-tree">
                  ${tree.nodes.filter((node) => !tree!.nodes.some((parent) => parent.peer.id === node.peer.parentId)).map(treeNode)}
                </ul>`
              : nothing
          }
        </section>
        <div class="board-columns">
          <section aria-label="Message timeline" aria-busy=${busy}>
            ${messages.size === 0 ? html`<p>${busy ? "Loading messages…" : "No matching messages."}</p>` : nothing}
            ${[...messages.values()]
              .sort((a, b) => a.sequence - b.sequence)
              .map(
                (message) =>
                  html` <article class="board-message ${selected === message.id ? "selected" : ""}">
                    <a
                      href=${permalink(message.id)}
                      @click=${(event: MouseEvent) => {
                        if (!event.metaKey && !event.ctrlKey && !event.shiftKey && event.button === 0) {
                          event.preventDefault();
                          void select(message.id);
                        }
                      }}
                      >${message.senderName} · ${stamp(message.createdAt)}</a
                    >
                    <p class="board-text">${message.text}</p>
                    <small
                      >${message.recipientIds.length ? `${message.recipientIds.length} intended recipients` : "No recipients — published without notification"}${message.replyTo ? " · Reply" : ""}</small
                    >
                  </article>`,
              )}
            <button class="btn" ?disabled=${busy} @click=${() => void refresh()}>
              ${more ? "Load more" : "Check for new messages"}
            </button>
            <small> Resumes from durable cursor ${cursor}</small>
          </section>
          <aside aria-label="Message inspector">
            ${
              detail
                ? html`
                    <h2 id="board-inspector-heading" tabindex="-1">Message inspector</h2>
                    <a href=${permalink(detail.message.id)}>Permalink</a>
                    <p>Sender: ${detail.message.senderName} (${detail.message.senderId})</p>
                    <button class="btn" @click=${() => void loadTree(detail!.message.senderId)}>
                      Inspect sender subtree
                    </button>
                    <p class="board-text">${detail.message.text}</p>
                    ${detail.message.replyTo ? html`<button class="btn" @click=${() => void select(detail!.message.replyTo!)}>Inspect parent reply</button>` : nothing}
                    <button
                      class="btn"
                      @click=${() => {
                        filters.set("threadId", detail!.message.threadId);
                        void refresh(true);
                      }}
                    >
                      Show reply thread
                    </button>
                    <h3>Original audience expression</h3>
                    <pre>${detail.message.audience}</pre>
                    <p>Frozen recipients: ${detail.message.recipientIds.join(", ") || "None"}</p>
                    <details>
                      <summary>Historical candidate characters (${detail.message.candidates.length})</summary>
                      <pre>${json(detail.message.candidates)}</pre>
                    </details>
                    <h3>Delivery evidence</h3>
                    <p>Delivery is not a reply. Private transcript access remains separate.</p>
                    ${detail.deliveries.map(
                      (delivery) =>
                        html`<article class="board-delivery">
                          <strong>${delivery.recipientId}</strong>
                          <p>Notification: ${delivery.state} · ${delivery.attempts} dispatch attempts</p>
                          ${delivery.runStatus ? html`<p>Run: ${delivery.runStatus}</p>` : nothing}
                          ${delivery.reason ? html`<p>${delivery.reason.replaceAll("_", " ")}</p>` : nothing}
                          ${delivery.sessionId ? html`<a href=${withBase(`/s/${encodeURIComponent(delivery.sessionId)}`)}>Open session activity</a>${delivery.runId ? html`<p>Run: ${delivery.runId}</p>` : nothing}` : html`<p>Private session activity requires separate access.</p>`}
                          <small>Created ${stamp(delivery.createdAt)} · Updated ${stamp(delivery.updatedAt)}</small>
                        </article>`,
                    )}
                  `
                : html`<p>
                    ${selected ? "Loading message…" : "Select a message to inspect its audience and delivery."}
                  </p>`
            }
            <h2>Current audience preview</h2>
            <p>This is a new evaluation. It does not change past recipients or notify anyone.</p>
            <label
              >jq expression<textarea
                rows="4"
                .value=${expression}
                @input=${(event: Event) => {
                  expression = (event.currentTarget as HTMLTextAreaElement).value;
                  preview = null;
                }}
              ></textarea>
            </label>
            <button class="btn" @click=${() => void evaluate()}>Preview current matches</button>
            ${
              preview
                ? html`<p>${preview.recipientIds.length} current matches</p>
                    <pre>${json(preview)}</pre>`
                : nothing
            }
          </aside>
        </div>`,
      host,
    );
  }
  async function poll(): Promise<void> {
    if (!active()) return;
    await Promise.all([refresh(), loadDetail(), ...(treeRoot ? [loadTree(treeRoot)] : [])]);
    if (active()) setTimeout(() => void poll(), 3_000);
  }
  await poll();
}
