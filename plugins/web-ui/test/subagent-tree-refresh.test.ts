import assert from "node:assert/strict";
import test, { mock } from "node:test";
import type { CoreSession } from "../src/core-bridge.ts";
import { harness } from "./deep-link-boot-fixture.ts";

type Listener = (event: { data: string }) => void;

class FakeEventSource {
  static last: FakeEventSource | null = null;
  onopen: (() => void) | null = null;
  readonly listeners = new Map<string, Listener[]>();
  constructor() {
    FakeEventSource.last = this;
  }
  addEventListener(name: string, listener: Listener): void {
    this.listeners.set(name, [...(this.listeners.get(name) ?? []), listener]);
  }
  close(): void {}
  state(threadRef: string, state: string): void {
    for (const listener of this.listeners.get("session_state") ?? [])
      listener({ data: JSON.stringify({ threadRef, state, at: Date.now() }) });
  }
}

function row(id: string, parentSessionId?: string, extra: Partial<CoreSession> = {}): CoreSession {
  return {
    id,
    threadRef: parentSessionId ? `agent:main:subagent:${id}` : `web:tester:${id}`,
    scopeId: "personal:tester",
    type: "dm",
    title: id,
    createdAt: 1_000,
    ...(parentSessionId ? { parentSessionId } : {}),
    ...extra,
  };
}

test("an open chat refetches its subagent tree only for events inside that tree, coalescing bursts", async () => {
  const root = row("root");
  const sessions = [root, row("child-1", "root"), row("other"), row("other-child", "other")];
  const h = await harness({ path: `/s/${root.id}`, session: root, listSessions: sessions });
  Object.defineProperty(globalThis, "EventSource", { configurable: true, writable: true, value: FakeEventSource });
  const realTimeout = globalThis.setTimeout;
  let mocked = false;
  const settle = async (): Promise<void> => {
    for (let i = 0; i < 5; i++) await new Promise((resolve) => realTimeout(resolve, 5));
  };
  const until = async (check: () => boolean, label: string): Promise<void> => {
    for (let i = 0; i < 200; i++) {
      if (check()) return;
      if (mocked) mock.timers.tick(0);
      await settle();
    }
    assert.fail(`condition did not settle: ${label}`);
  };
  const count = (fragment: string): number => h.requests.filter((path) => path.includes(fragment)).length;
  const children = (): number => count("/api/sessions/root/children");
  const listed = (id: string): CoreSession | undefined =>
    (h.sessionsState.list as CoreSession[]).find((r) => r.id === id);
  try {
    await h.boot();
    h.releaseSessions();
    await h.sessionsReady();
    await until(() => FakeEventSource.last !== null && children() === 1, "stream and initial children");
    mock.timers.enable({ apis: ["setTimeout", "Date"], now: Date.now() });
    mocked = true;
    const stream = FakeEventSource.last!;

    stream.state("agent:main:subagent:other-child", "working");
    stream.state("web:tester:other", "working");
    await until(() => count("threadRef=agent%3Amain%3Asubagent%3Aother-child") > 0, "unseen thread lookup");
    mock.timers.tick(10_000);
    await settle();
    assert.equal(children(), 1);

    sessions.push(row("child-2", "root", { working: true }));
    stream.state("agent:main:subagent:child-2", "working");
    await until(() => listed("child-2") !== undefined, "new subagent row");
    assert.equal(children(), 2);

    for (let i = 0; i < 10; i++) stream.state("agent:main:subagent:child-1", "working");
    sessions[1] = { ...sessions[1]!, title: "child-1 finished" };
    stream.state("agent:main:subagent:child-1", "idle");
    await settle();
    assert.equal(children(), 2);
    mock.timers.tick(2_000);
    await until(() => listed("child-1")?.title === "child-1 finished", "trailing refresh lands the final state");
    mock.timers.tick(10_000);
    await settle();
    assert.equal(children(), 3);
  } finally {
    mock.timers.reset();
    await h.close();
  }
});
