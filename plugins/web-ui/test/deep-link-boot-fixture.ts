import { browserEnv } from "./browser-env.ts";
import type { Conversation } from "../src/conv-types.ts";
import type { CoreContext, CoreSession, TranscriptPage } from "../src/core-bridge.ts";

export interface Harness {
  requests: string[];
  setTranscriptStatus: (status: number) => void;
  openSession: (session: CoreSession, prefetch?: Promise<TranscriptPage | null>) => Promise<void>;
  setConnections: (items: unknown[], status?: number) => void;
  releaseSessions: () => void;
  releaseTranscript: () => void;
  releaseApprovals: () => void;
  releaseRuntimeConfig: () => void;
  releaseRemoteSplit: () => void;
  sessionsReady: () => Promise<void>;
  refreshSessions: () => Promise<boolean>;
  boot: () => Promise<void>;
  switchView: (view: "chats" | "settings") => void;
  renderList: () => void;
  drawChatsPage: () => void;
  renderChatsPage: () => Promise<void>;
  appState: { currentView: string };
  sessionsState: { list: Array<{ id: string }>; loaded: boolean; openingKey: string | null };
  visibleConversation: () => Conversation;
  mainText: () => string;
  close: () => Promise<void>;
}

interface HarnessOptions {
  api?: (path: string, init?: RequestInit) => Response | Promise<Response> | undefined;
  path: string;
  session?: CoreSession;
  messageLink?: boolean;
  transcriptStatus?: number;
  transcriptFailures?: number;
  holdTranscript?: boolean;
  holdApprovals?: boolean;
  approvals?: (sessionId: string) => unknown[];
  holdRuntimeConfig?: boolean;
  holdRemoteSplit?: boolean;
  remoteCanvas?: unknown;
  listSessions?: unknown[];
  contexts?: CoreContext[];
  entries?: unknown[];
  savedCanvas?: boolean;
  connectionReturn?: boolean;
  slackReturn?: "success" | "expired" | "cancelled" | "wrong-account";
  returnWidget?: string;
  returnPath?: string;
  returnReplaces?: string;
  openNewChat?: boolean;
}

export const SESSION = {
  id: "sess-deep",
  threadRef: "web:tester:deep",
  scopeId: "personal:tester",
  title: "Deep linked chat",
  canContinue: true,
};

export async function harness(opts: HarnessOptions): Promise<Harness> {
  const session = opts.session ?? SESSION;
  let transcriptStatus = opts.transcriptStatus;
  const requests: string[] = [];
  const inFlight = new Set<Promise<Response>>();
  const env = await browserEnv({
    dom: { url: `http://localhost${opts.path}` },
    html: '<!doctype html><div id="app"></div>',
    fetch: (input, init) => {
      const answer = respond(input, init);
      inFlight.add(answer);
      void answer.finally(() => inFlight.delete(answer)).catch(() => {});
      return answer;
    },
  });
  const { dom, vite } = env;
  if (opts.savedCanvas)
    dom.window.localStorage.setItem(
      "web-ui:split-canvas:v1",
      JSON.stringify({
        v: 1,
        active: true,
        root: {
          kind: "split",
          a: { kind: "leaf", threadRef: "web:tester:old-a" },
          b: { kind: "leaf", threadRef: "web:tester:old-b" },
        },
      }),
    );
  if (opts.slackReturn)
    dom.window.sessionStorage.setItem(
      "qm-slack-account",
      JSON.stringify({
        user: opts.slackReturn === "wrong-account" ? "test:other" : "test:tester",
        state: "qa-slack-nonce",
        ticket: "signed-test-ticket",
        expiresAt: Date.now() + (opts.slackReturn === "expired" ? -60000 : 60000),
      }),
    );
  let connectedItems: unknown[] = opts.connectionReturn ? [{ id: "ca_test", toolkit: "gmail" }] : [];
  let connectedStatus = 200;
  if (opts.connectionReturn)
    dom.window.sessionStorage.setItem(
      "qm-connection-return:test:tester",
      JSON.stringify({
        state: "return-nonce",
        user: "test:tester",
        path: opts.returnPath ?? "/s/sess-deep",
        service: { id: "gmail", name: "Gmail" },
        accountId: "ca_test",
        ...(opts.returnReplaces ? { replaces: opts.returnReplaces } : {}),
        widget: opts.returnWidget ?? "settings",
        expiresAt: Date.now() + 60000,
        picker: { query: "mail", expanded: true },
        scrollTop: 0,
      }),
    );
  dom.window.HTMLElement.prototype.scrollIntoView = function () {
    this.setAttribute("data-scrolled", "true");
  };
  let releaseSessions = (): void => {};
  let releaseTranscript = (): void => {};
  let releaseApprovals = (): void => {};
  let releaseRuntimeConfig = (): void => {};
  let releaseRemoteSplit = (): void => {};
  const runtimeHeld = new Promise<void>((resolve) => (releaseRuntimeConfig = resolve));
  const remoteSplitHeld = new Promise<void>((resolve) => (releaseRemoteSplit = resolve));
  const approvalsHeld = new Promise<void>((resolve) => (releaseApprovals = resolve));
  const sessionsHeld = new Promise<void>((resolve) => (releaseSessions = resolve));
  const transcriptHeld = new Promise<void>((resolve) => (releaseTranscript = resolve));
  let failuresLeft = opts.transcriptFailures ?? (opts.transcriptStatus ? Number.POSITIVE_INFINITY : 0);
  const respond = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const path = String(input);
    requests.push(path);
    const custom = opts.api?.(path, init);
    if (custom) return custom;
    if (path === "/me")
      return Response.json({
        user: "tester",
        org: "test",
        permissions: [],
      });
    if (path === "/api/composio/slack/complete")
      return Response.json({ connected: true, user: "Alice", workspace: "Acme" });
    if (path === "/api/composio/slack") return Response.json({ connected: false, workspaceInstalled: true });
    if (path.startsWith("/api/composio/connections"))
      return Response.json({ items: connectedItems, nextCursor: null }, { status: connectedStatus });
    if (path.startsWith("/api/composio/toolkits"))
      return Response.json({ items: [{ id: "gmail", name: "Gmail", description: "Email" }], nextCursor: null });
    if (path.startsWith("/api/runtime-config")) {
      if (opts.holdRuntimeConfig) await runtimeHeld;
      return Response.json({
        scopeId: new URL(path, "http://localhost").searchParams.get("scopeId") ?? "personal:tester",
        approvedHarnesses: [],
        modelsByHarness: {},
        modelCatalog: {},
        orgDefault: { harnessId: "pi", modelId: "m", revision: 1 },
        scopeOverride: null,
        effective: { harnessId: "pi", modelId: "m" },
        upgradeAvailable: false,
      });
    }
    if (path.startsWith("/api/ui-state?key=open-new-chat")) {
      return Response.json({ value: opts.openNewChat ?? null, updatedAt: opts.openNewChat ? 1 : 0 });
    }
    if (path.startsWith("/api/ui-state")) {
      if (opts.holdRemoteSplit) await remoteSplitHeld;
      return Response.json({ value: opts.remoteCanvas ?? null, updatedAt: opts.remoteCanvas ? 1 : 0 });
    }
    if (path.startsWith("/api/sessions/") && path.includes("/approvals")) {
      if (opts.holdApprovals) await approvalsHeld;
      const sessionId = decodeURIComponent(path.split("/")[3] ?? "");
      return Response.json({ approvals: opts.approvals?.(sessionId) ?? [] });
    }
    if (path.startsWith("/api/sessions/") && path.endsWith("/children")) {
      const all = (opts.listSessions ?? []) as CoreSession[];
      const below = new Set([decodeURIComponent(path.split("/")[3] ?? "")]);
      for (let grew = true; grew;) {
        grew = false;
        for (const row of all)
          if (row.parentSessionId && below.has(row.parentSessionId) && !below.has(row.id)) {
            below.add(row.id);
            grew = true;
          }
      }
      return Response.json({ sessions: all.filter((row) => row.parentSessionId && below.has(row.id)) });
    }
    if (path.startsWith("/api/sessions/row?")) {
      const params = new URL(path, "http://test").searchParams;
      const row = ((opts.listSessions ?? []) as CoreSession[]).find(
        (candidate) => candidate.id === params.get("id") || candidate.threadRef === params.get("threadRef"),
      );
      return row ? Response.json({ session: row }) : Response.json({ error: "not_found" }, { status: 404 });
    }
    if (path.startsWith(`/api/sessions/${session.id}`)) {
      if (opts.holdTranscript) await transcriptHeld;
      if (failuresLeft > 0) {
        failuresLeft--;
        return Response.json({ error: "not_found" }, { status: transcriptStatus ?? 500 });
      }
      if (opts.messageLink) {
        const older = path.includes("beforeSeq=");
        const seqs = older ? [10, 11] : [80, 81];
        return Response.json({
          session,
          entries: seqs.map((seq) => ({
            seq,
            type: seq % 2 ? "assistant" : "user",
            createdAt: Date.now(),
            payload: { text: `Linked QA message ${seq}` },
          })),
          earlierEntries: older ? 0 : 80,
        });
      }
      return Response.json({ session, entries: opts.entries ?? [] });
    }
    if (path.startsWith("/api/sessions?")) {
      await sessionsHeld;
      return Response.json(
        sessionPage((opts.listSessions ?? []) as CoreSession[], new URL(path, "http://test").searchParams),
      );
    }
    return Response.json({ contexts: opts.contexts ?? [], items: [], crons: [] });
  };

  const shell = await vite.ssrLoadModule("/src/shell.ts");
  const sessions = await vite.ssrLoadModule("/src/sessions.ts");
  const conversations = await vite.ssrLoadModule("/src/conversations.ts");
  const split = await vite.ssrLoadModule("/src/split.ts");
  return {
    requests,
    setTranscriptStatus: (status) => {
      transcriptStatus = status;
      failuresLeft = status === 200 ? 0 : Number.POSITIVE_INFINITY;
    },
    openSession: sessions.openSession as Harness["openSession"],
    setConnections: (items, status = 200) => {
      connectedItems = items;
      connectedStatus = status;
    },
    releaseSessions,
    releaseTranscript,
    releaseApprovals,
    releaseRuntimeConfig,
    releaseRemoteSplit,
    sessionsReady: sessions.sessionsReady as () => Promise<void>,
    refreshSessions: sessions.refreshSessions as () => Promise<boolean>,
    boot: shell.boot as () => Promise<void>,
    switchView: shell.switchView as Harness["switchView"],
    renderList: sessions.renderList as () => void,
    drawChatsPage: sessions.drawChatsPage as () => void,
    renderChatsPage: sessions.renderChatsPage as () => Promise<void>,
    appState: shell.appState as Harness["appState"],
    sessionsState: sessions.sessionsState as Harness["sessionsState"],
    visibleConversation: () =>
      conversations
        .allConversations()
        .find((conv: { state: { host: HTMLElement | null } }) => conv.state.host?.isConnected) ??
      conversations.mainConversation(),
    mainText: () => dom.window.document.querySelector(".main")?.textContent ?? "",
    close: async () => {
      split.exitSplitIfActive();
      for (const conversation of conversations.allConversations()) conversations.disposeConversation(conversation);
      releaseSessions();
      releaseTranscript();
      releaseApprovals();
      releaseRuntimeConfig();
      releaseRemoteSplit();
      for (let drain = 0; drain < 5 && inFlight.size; drain++) {
        await Promise.allSettled(inFlight);
        await new Promise((resolve) => setTimeout(resolve, 0));
      }
      await env.close();
    },
  };
}

function sessionPage(all: CoreSession[], params: URLSearchParams) {
  const activity = (row: CoreSession): number => row.lastActivityAt ?? row.createdAt ?? 0;
  const archived = params.get("status") === "archived";
  const before = params.get("before");
  const limit = Number(params.get("limit") ?? 50);
  let rows = all
    .filter((row) => !row.parentSessionId && Boolean(row.archived) === archived)
    .filter((row) => !params.get("q") || (row.title ?? "").toLowerCase().includes(params.get("q")!.toLowerCase()))
    .filter((row) => !params.get("scope") || row.scopeId === params.get("scope"))
    .filter((row) => params.get("status") !== "waiting" || row.awaitingInput)
    .sort((a, b) => activity(b) - activity(a) || (b.id < a.id ? -1 : 1));
  const pinned = !before && !archived ? rows.filter((row) => row.pinned) : undefined;
  if (!archived) rows = rows.filter((row) => !row.pinned);
  if (before) {
    const dot = before.indexOf(".");
    const [at, id] = [Number(before.slice(0, dot)), before.slice(dot + 1)];
    rows = rows.filter((row) => activity(row) < at || (activity(row) === at && row.id < id));
  }
  const sessions = rows.slice(0, limit);
  const last = sessions[sessions.length - 1];
  return {
    sessions,
    ...(pinned ? { pinned, hasArchived: all.some((row) => row.archived) } : {}),
    nextCursor: rows.length > limit && last ? `${activity(last)}.${last.id}` : null,
  };
}
