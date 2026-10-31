import assert from "node:assert/strict";
import { test } from "node:test";
import type { SurfaceCoreClient } from "../src/api/surface-core-client.ts";
import { DISCORD_RUN_RECOVERY_GRACE_MS } from "../src/discord/deliveries.ts";
import { runDiscordTurn, type ReplyChannel, type StatusMessage } from "../src/discord/turn-flow.ts";
import type { TurnResult } from "../src/types.ts";

interface Log {
  sent: string[];
  edits: string[];
  deleted: number;
  files: string[];
}

function channel(log: Log): ReplyChannel {
  return {
    async send(content, files): Promise<StatusMessage> {
      log.sent.push(content);
      for (const f of files ?? []) log.files.push(f.name);
      return {
        id: "s1",
        edit: async (c: string) => {
          if (c === "") throw new Error("Cannot send an empty message");
          log.edits.push(c);
        },
        delete: async () => {
          log.deleted += 1;
        },
      };
    },
    typing: async () => {},
  };
}

function core(opts: {
  submit?: () => Promise<TurnResult>;
  wait?: () => Promise<TurnResult | null>;
  snapshots?: string[];
}): SurfaceCoreClient {
  const snaps = [...(opts.snapshots ?? [])];
  return {
    submitTurn: opts.submit ?? (async () => ({ status: "queued", runId: "r1" })),
    waitRun: opts.wait ?? (async () => ({ status: "ok", reply: "done" })),
    streamSnapshot: () => snaps.shift() ?? null,
    readBlob: async (id: string) => Buffer.from(id),
    readFileArtifact: async () => Buffer.from(""),
    reportRunEditRef: async () => {},
    ackRunDelivery: async () => {},
  } as unknown as SurfaceCoreClient;
}

const body = {
  actor: { externalId: "discord:1" },
  conversation: { kind: "dm" as const, threadRef: "discord:dm:c" },
  text: "hi",
};
const baseBody = {
  ...body,
  deliveryTarget: "c1",
};
const fresh = (): Log => ({ sent: [], edits: [], deleted: 0, files: [] });
const allowAll = async () => true;

test("posts a working message, then edits it into the final reply", async () => {
  const log = fresh();
  await runDiscordTurn({
    core: core({}),
    channel: channel(log),
    body,
    mode: "stream",
    inFlightRuns: new Set(),
    mayPost: allowAll,
  });
  assert.deepEqual(log.sent, ["⚙ Working…"]);
  assert.equal(log.edits.at(-1), "done");
});

test("streams partial text into the status message while the run is live", async () => {
  const log = fresh();
  const slowWait = () =>
    new Promise<TurnResult>((r) => setTimeout(() => r({ status: "ok", reply: "final answer" }), 60));
  await runDiscordTurn({
    core: core({ wait: slowWait, snapshots: ["par", "partial"] }),
    channel: channel(log),
    body,
    mode: "stream",
    inFlightRuns: new Set(),
    streamIntervalMs: 10,
    mayPost: allowAll,
  });
  assert.ok(log.edits.includes("par"));
  assert.ok(log.edits.includes("partial"));
  assert.equal(log.edits.at(-1), "final answer");
});

test("long replies edit the first chunk and send the rest", async () => {
  const log = fresh();
  const reply = `${"a ".repeat(1500)}\n\n${"b ".repeat(1500)}`;
  await runDiscordTurn({
    core: core({ wait: async () => ({ status: "ok", reply }) }),
    channel: channel(log),
    body,
    mode: "stream",
    inFlightRuns: new Set(),
    mayPost: allowAll,
  });
  assert.ok(log.sent.length >= 3, `sent ${log.sent.length}`);
  for (const s of [...log.sent, ...log.edits]) assert.ok(s.length <= 2000);
  assert.ok(log.sent.slice(1).some((s) => s.includes("b b")));
});

test("a submit error replaces the working message with the failure text", async () => {
  const log = fresh();
  const submit = async (): Promise<TurnResult> => {
    throw new Error("core down");
  };
  await runDiscordTurn({
    core: core({ submit }),
    channel: channel(log),
    body,
    mode: "stream",
    inFlightRuns: new Set(),
    mayPost: allowAll,
  });
  assert.equal(log.edits.at(-1), "Something went wrong on my end and I couldn't finish that. Try again in a moment.");
});

test("a stalled run replaces the working message with the failure text", async () => {
  const log = fresh();
  const wait = async (): Promise<TurnResult | null> => {
    throw Object.assign(new Error("stalled"), { code: "run_stalled" });
  };
  await runDiscordTurn({
    core: core({ wait }),
    channel: channel(log),
    body,
    mode: "stream",
    inFlightRuns: new Set(),
    mayPost: allowAll,
  });
  assert.equal(log.edits.at(-1), "Something went wrong on my end and I couldn't finish that. Try again in a moment.");
});

test("failed and null results also end in the failure text", async () => {
  for (const r of [{ status: "failed" } as TurnResult, null]) {
    const log = fresh();
    await runDiscordTurn({
      core: core({ wait: async () => r }),
      channel: channel(log),
      body,
      mode: "stream",
      inFlightRuns: new Set(),
      mayPost: allowAll,
    });
    assert.equal(log.edits.at(-1), "Something went wrong on my end and I couldn't finish that. Try again in a moment.");
  }
});

test("silent and steered turns remove the working message", async () => {
  const log1 = fresh();
  await runDiscordTurn({
    core: core({ wait: async () => ({ status: "silent" }) }),
    channel: channel(log1),
    body,
    mode: "stream",
    inFlightRuns: new Set(),
    mayPost: allowAll,
  });
  assert.equal(log1.deleted, 1);
  const log2 = fresh();
  await runDiscordTurn({
    core: core({ submit: async () => ({ status: "queued", runId: "r", steered: true }) }),
    channel: channel(log2),
    body,
    mode: "stream",
    inFlightRuns: new Set(),
    mayPost: allowAll,
  });
  assert.equal(log2.deleted, 1);
});

test("refusals and pending approvals are explained in place", async () => {
  const log1 = fresh();
  await runDiscordTurn({
    core: core({ wait: async () => ({ status: "refused", reason: "internal-only" }) }),
    channel: channel(log1),
    body,
    mode: "stream",
    inFlightRuns: new Set(),
    mayPost: allowAll,
  });
  assert.match(log1.edits.at(-1)!, /internal-only/);
  const log2 = fresh();
  await runDiscordTurn({
    core: core({
      wait: async () => ({ status: "pending_approval", adminUrl: "https://qm/x" }),
    }),
    channel: channel(log2),
    body,
    mode: "stream",
    inFlightRuns: new Set(),
    mayPost: allowAll,
  });
  assert.match(log2.edits.at(-1)!, /https:\/\/qm\/x/);
});

test("outbound files are sent after the text", async () => {
  const log = fresh();
  const wait = async (): Promise<TurnResult> => ({
    status: "ok",
    reply: "here",
    attachments: [{ name: "r.csv", mimetype: "text/csv", sizeBytes: 3, blobId: "b" }],
  });
  await runDiscordTurn({
    core: core({ wait }),
    channel: channel(log),
    body,
    mode: "stream",
    inFlightRuns: new Set(),
    mayPost: allowAll,
  });
  assert.deepEqual(log.files, ["r.csv"]);
});

test("a files-only reply deletes the working message and sends the files", async () => {
  const log = fresh();
  const wait = async (): Promise<TurnResult> => ({
    status: "ok",
    attachments: [{ name: "r.csv", mimetype: "text/csv", sizeBytes: 3, blobId: "b" }],
  });
  await runDiscordTurn({
    core: core({ wait }),
    channel: channel(log),
    body,
    mode: "stream",
    inFlightRuns: new Set(),
    mayPost: allowAll,
  });
  assert.equal(log.deleted, 1);
  assert.deepEqual(log.files, ["r.csv"]);
  assert.ok(!log.edits.includes("Something went wrong on my end and I couldn't finish that. Try again in a moment."));
});

test("in stream mode, reportRunEditRef is called with the status message id and ackRunDelivery after delivery", async () => {
  const calls: string[] = [];
  const log: Log = { sent: [], edits: [], deleted: 0, files: [] };
  const inFlight = new Set<string>();
  const c = {
    ...core({}),
    reportRunEditRef: async (runId: string, ref: string) => void calls.push(`ref:${runId}:${ref}`),
    ackRunDelivery: async (runId: string) => void calls.push(`ack:${runId}:${inFlight.has(runId)}`),
    waitRun: async () => {
      calls.push(`waiting:${inFlight.has("r1")}`);
      return { status: "ok", reply: "done" } as TurnResult;
    },
  } as unknown as SurfaceCoreClient;
  await runDiscordTurn({
    core: c,
    channel: channel(log),
    body: baseBody,
    mode: "stream",
    inFlightRuns: inFlight,
    mayPost: allowAll,
  });
  assert.deepEqual(calls, ["ref:r1:s1", "waiting:true", "ack:r1:true"]);
  assert.equal(inFlight.size, 0);
});

test("a failed run-delivery ack is retried and the delivered reply is not turned into a failure", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const log = fresh();
  let attempts = 0;
  const c = {
    ...core({}),
    ackRunDelivery: async () => {
      attempts += 1;
      if (attempts < 3) throw new Error("core unreachable");
    },
  } as unknown as SurfaceCoreClient;
  let settled = false;
  const turn = runDiscordTurn({
    core: c,
    channel: channel(log),
    body: baseBody,
    mode: "stream",
    inFlightRuns: new Set(),
    mayPost: allowAll,
  }).then(() => void (settled = true));
  while (!settled) {
    await new Promise((r) => setImmediate(r));
    t.mock.timers.tick(30_000);
  }
  await turn;
  assert.equal(attempts, 3);
  assert.equal(log.edits.at(-1), "done");
});

test("the in-process reply acks its run delivery only after it was delivered", async () => {
  const calls: string[] = [];
  const log: Log = { sent: [], edits: [], deleted: 0, files: [] };
  const broken: ReplyChannel = {
    ...channel(log),
    async send() {
      return {
        id: "s1",
        edit: async () => {
          throw new Error("discord down");
        },
        delete: async () => {},
      };
    },
  };
  const c = {
    ...core({}),
    reportRunEditRef: async () => {},
    ackRunDelivery: async () => void calls.push("ack"),
  } as unknown as SurfaceCoreClient;
  await runDiscordTurn({
    core: c,
    channel: broken,
    body: baseBody,
    mode: "stream",
    inFlightRuns: new Set(),
    mayPost: allowAll,
  });
  assert.deepEqual(calls, []);
});

test("spine mode posts nothing itself when the agent spoke through deliveries", async () => {
  const log: Log = { sent: [], edits: [], deleted: 0, files: [] };
  const c = { ...core({ wait: async () => ({ status: "silent" }) }) } as unknown as SurfaceCoreClient;
  await runDiscordTurn({
    core: c,
    channel: channel(log),
    body: baseBody,
    mode: "spine",
    ownedRuns: new Set(),
    mayPost: allowAll,
  });
  assert.deepEqual(log.sent, []);
});

test("spine mode keeps an ok run owned until the recovery grace passes, whatever the outcome", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const log: Log = { sent: [], edits: [], deleted: 0, files: [] };
  const results: TurnResult[] = [
    { status: "ok", reply: "done" },
    { status: "ok" },
    { status: "pending_approval" },
    { status: "silent" },
  ];
  for (const result of results) {
    const ownedRuns = new Set<string>();
    const c = core({ wait: async () => result });
    await runDiscordTurn({
      core: c,
      channel: channel(log),
      body: baseBody,
      mode: "spine",
      ownedRuns,
      mayPost: allowAll,
    });
    assert.deepEqual([...ownedRuns], ["r1"]);
    t.mock.timers.tick(DISCORD_RUN_RECOVERY_GRACE_MS);
    assert.equal(ownedRuns.size, 0);
  }
});

test("spine mode posts a refusal, because core has nothing to deliver", async () => {
  const log: Log = { sent: [], edits: [], deleted: 0, files: [] };
  const c = {
    ...core({
      submit: async () => ({
        status: "refused",
        reason: "internal-only: shared audience includes a non-internal participant",
      }),
    }),
  } as unknown as SurfaceCoreClient;
  await runDiscordTurn({
    core: c,
    channel: channel(log),
    body: baseBody,
    mode: "spine",
    ownedRuns: new Set(),
    mayPost: allowAll,
  });
  assert.deepEqual(log.sent, [
    "I can't answer here: people outside the organization can read this channel. Ask me in a private channel or a DM.",
  ]);
});

test("a guest appears before the spine refusal post → no reason or adminUrl text is posted", async () => {
  const log: Log = { sent: [], edits: [], deleted: 0, files: [] };
  const c = {
    ...core({
      submit: async () => ({
        status: "refused",
        reason: "secret reason that should not leak",
        adminUrl: "https://qm/admin/private",
      }),
    }),
  } as unknown as SurfaceCoreClient;
  await runDiscordTurn({
    core: c,
    channel: channel(log),
    body: baseBody,
    mode: "spine",
    ownedRuns: new Set(),
    mayPost: async () => false,
  });
  assert.deepEqual(log.sent, ["I can't post this reply here right now."]);
  assert.equal(
    log.sent.some((s) => s.includes("secret reason") || s.includes("admin/private")),
    false,
  );
});

test("a guest appears before the spine approval post → the approval text and adminUrl are not posted", async () => {
  const log: Log = { sent: [], edits: [], deleted: 0, files: [] };
  const c = {
    ...core({
      submit: async () => ({
        status: "pending_approval",
        adminUrl: "https://qm/admin/private",
        pendingApprovals: [{ requestId: "A1", command: "rm", reason: "needs approval" }],
      }),
    }),
  } as unknown as SurfaceCoreClient;
  await runDiscordTurn({
    core: c,
    channel: channel(log),
    body: baseBody,
    mode: "spine",
    ownedRuns: new Set(),
    mayPost: async () => false,
  });
  assert.deepEqual(log.sent, ["I can't post this reply here right now."]);
});

test("a guest appears before the spine failure post → the neutral text is posted", async () => {
  const log: Log = { sent: [], edits: [], deleted: 0, files: [] };
  const c = {
    ...core({
      submit: async () => {
        throw new Error("down");
      },
    }),
  } as unknown as SurfaceCoreClient;
  await runDiscordTurn({
    core: c,
    channel: channel(log),
    body: baseBody,
    mode: "spine",
    ownedRuns: new Set(),
    mayPost: async () => false,
  });
  assert.deepEqual(log.sent, ["I can't post this reply here right now."]);
});

test("a turn waiting on an approval points to the DM buttons and keeps the web link", async () => {
  const log: Log = { sent: [], edits: [], deleted: 0, files: [] };
  const c = {
    ...core({
      wait: async () => ({
        status: "pending_approval",
        adminUrl: "https://qm/x",
        pendingApprovals: [{ requestId: "A1", command: "ls", reason: "r" }],
      }),
    }),
    reportRunEditRef: async () => {},
    ackRunDelivery: async () => {},
  } as unknown as SurfaceCoreClient;
  await runDiscordTurn({
    core: c,
    channel: channel(log),
    body: baseBody,
    mode: "stream",
    inFlightRuns: new Set(),
    mayPost: allowAll,
  });
  assert.equal(
    log.edits.at(-1),
    "This needs your approval — I sent you the buttons in a direct message. If they don't arrive, approve it in the QM web app: https://qm/x",
  );
});

test("spine mode posts the same approval pointer in the thread", async () => {
  const log: Log = { sent: [], edits: [], deleted: 0, files: [] };
  const c = {
    ...core({
      wait: async () => ({
        status: "pending_approval",
        adminUrl: "https://qm/x",
        pendingApprovals: [{ requestId: "A1", command: "ls", reason: "r" }],
      }),
    }),
  } as unknown as SurfaceCoreClient;
  await runDiscordTurn({
    core: c,
    channel: channel(log),
    body: baseBody,
    mode: "spine",
    ownedRuns: new Set(),
    mayPost: allowAll,
  });
  assert.deepEqual(log.sent, [
    "This needs your approval — I sent you the buttons in a direct message. If they don't arrive, approve it in the QM web app: https://qm/x",
  ]);
});

test("onSettled receives the run's final result once, and is never called on a submit failure", async () => {
  const log: Log = { sent: [], edits: [], deleted: 0, files: [] };
  const calls: Array<[string, string]> = [];
  const base = { reportRunEditRef: async () => {}, ackRunDelivery: async () => {} };
  const accepted = { ...core({}), ...base } as unknown as SurfaceCoreClient;
  const refusedAfterQueue = {
    ...core({ wait: async () => ({ status: "refused", reason: "nope" }) }),
    ...base,
  } as unknown as SurfaceCoreClient;
  const refused = {
    ...core({ submit: async () => ({ status: "refused", reason: "nope" }) }),
    ...base,
  } as unknown as SurfaceCoreClient;
  const broken = {
    ...core({
      submit: async () => {
        throw new Error("down");
      },
    }),
    ...base,
  } as unknown as SurfaceCoreClient;
  for (const [name, c] of [
    ["accepted", accepted],
    ["refusedAfterQueue", refusedAfterQueue],
    ["refused", refused],
    ["broken", broken],
  ] as const)
    await runDiscordTurn({
      core: c,
      channel: channel(log),
      body: baseBody,
      mode: "stream",
      inFlightRuns: new Set(),
      mayPost: allowAll,
      onSettled: async (r) => void calls.push([name, r.status]),
    });
  assert.deepEqual(calls, [
    ["accepted", "ok"],
    ["refusedAfterQueue", "refused"],
    ["refused", "refused"],
  ]);
});

test("onAccepted runs once core queues the turn, before the result, and not on a refusal or failure", async () => {
  const log: Log = { sent: [], edits: [], deleted: 0, files: [] };
  const calls: string[] = [];
  const mk = (c: SurfaceCoreClient, name: string) =>
    runDiscordTurn({
      core: c,
      channel: channel(log),
      body: baseBody,
      mode: "stream",
      inFlightRuns: new Set(),
      mayPost: allowAll,
      onAccepted: async () => void calls.push(`${name}:accepted`),
      onSettled: async (r) => void calls.push(`${name}:${r.status}`),
    });
  await mk(core({}), "queued");
  await mk(core({ submit: async () => ({ status: "refused", reason: "no" }) }), "refused");
  assert.deepEqual(calls, ["queued:accepted", "queued:ok", "refused:refused"]);
});

test("a guest-gate stop mid-run still settles with the run result and posts nothing to the channel", async () => {
  const log = fresh();
  const settled: string[] = [];
  let calls = 0;
  const c = core({
    wait: () =>
      new Promise<TurnResult>((r) => setTimeout(() => r({ status: "refused", reason: "approval denied for x" }), 80)),
    snapshots: ["safe snapshot", "leaked after guest"],
  });
  await runDiscordTurn({
    core: c,
    channel: channel(log),
    body,
    mode: "stream",
    inFlightRuns: new Set(),
    streamIntervalMs: 10,
    mayPost: async () => {
      calls += 1;
      return calls <= 2;
    },
    onSettled: async (r) => void settled.push(`${r.status}:${r.reason}`),
  });
  assert.deepEqual(settled, ["refused:approval denied for x"]);
  assert.deepEqual(log.sent, ["⚙ Working…"]);
  assert.ok(!log.edits.includes("leaked after guest"));
  assert.equal(log.edits.at(-1), "I can't post this reply here right now.");
});

test("waitRun rejecting after acceptance settles with failed and posts the failure text", async () => {
  const log = fresh();
  const events: string[] = [];
  await runDiscordTurn({
    core: core({
      wait: async () => {
        throw new Error("run lost");
      },
    }),
    channel: channel(log),
    body,
    mode: "stream",
    inFlightRuns: new Set(),
    mayPost: allowAll,
    onAccepted: async () => void events.push("accepted"),
    onSettled: async (r) => void events.push(r.status),
  });
  assert.deepEqual(events, ["accepted", "failed"]);
  assert.equal(log.edits.at(-1), "Something went wrong on my end and I couldn't finish that. Try again in a moment.");
});

test("a throwing refusal edit on the pre-stream gate still settles with the real run result", async () => {
  const settled: string[] = [];
  const inFlight = new Set<string>();
  let heldDuringWait = false;
  const ch: ReplyChannel = {
    async send(): Promise<StatusMessage> {
      return {
        id: "s1",
        edit: async () => {
          throw new Error("message deleted");
        },
        delete: async () => {},
      };
    },
    typing: async () => {},
  };
  await runDiscordTurn({
    core: core({
      wait: async () => {
        heldDuringWait = inFlight.has("r1");
        return { status: "refused", reason: "approval denied for x" };
      },
    }),
    channel: ch,
    body,
    mode: "stream",
    inFlightRuns: inFlight,
    mayPost: async () => false,
    onSettled: async (r) => void settled.push(`${r.status}:${r.reason}`),
  });
  assert.deepEqual(settled, ["refused:approval denied for x"]);
  assert.equal(heldDuringWait, true);
});

test("a plain turn whose gate refuses before streaming does not wait for the run", async () => {
  const log = fresh();
  let waited = false;
  await runDiscordTurn({
    core: core({
      wait: async () => {
        waited = true;
        return { status: "ok", reply: "x" };
      },
    }),
    channel: channel(log),
    body,
    mode: "stream",
    inFlightRuns: new Set(),
    mayPost: async () => false,
  });
  assert.equal(waited, false);
});

test("a gate that refuses before streaming still settles with the run result", async () => {
  const log = fresh();
  const settled: string[] = [];
  await runDiscordTurn({
    core: core({ wait: async () => ({ status: "ok", reply: "secret" }) }),
    channel: channel(log),
    body,
    mode: "stream",
    inFlightRuns: new Set(),
    mayPost: async () => false,
    onSettled: async (r) => void settled.push(r.status),
  });
  assert.deepEqual(settled, ["ok"]);
  assert.ok(!log.edits.includes("secret"));
});

test("a guest reader appearing mid-stream stops streaming and replaces status with refusal", async () => {
  const log = fresh();
  let calls = 0;
  let runDeliveryAcked = false;
  const slowWait = () =>
    new Promise<TurnResult>((r) => setTimeout(() => r({ status: "ok", reply: "secret model output" }), 80));
  const c = {
    ...core({ wait: slowWait, snapshots: ["safe snapshot", "leaked after guest"] }),
    ackRunDelivery: async () => {
      runDeliveryAcked = true;
    },
  } as unknown as SurfaceCoreClient;
  await runDiscordTurn({
    core: c,
    channel: channel(log),
    body,
    mode: "stream",
    inFlightRuns: new Set(),
    streamIntervalMs: 10,
    mayPost: async () => {
      calls += 1;
      return calls <= 2;
    },
  });
  assert.ok(log.edits.includes("safe snapshot"));
  assert.ok(!log.edits.includes("leaked after guest"));
  assert.ok(!log.edits.includes("secret model output"));
  assert.equal(log.edits.at(-1), "I can't post this reply here right now.");
  assert.equal(runDeliveryAcked, false);
});

test("unknown readers before streaming means no model text is posted and no edit ref reported", async () => {
  const log = fresh();
  let reportedRef = false;
  let runDeliveryAcked = false;
  const c = {
    ...core({ wait: async () => ({ status: "ok", reply: "secret answer" }) }),
    reportRunEditRef: async () => {
      reportedRef = true;
    },
    ackRunDelivery: async () => {
      runDeliveryAcked = true;
    },
  } as unknown as SurfaceCoreClient;
  await runDiscordTurn({
    core: c,
    channel: channel(log),
    body,
    mode: "stream",
    inFlightRuns: new Set(),
    mayPost: async () => false,
  } as never);
  assert.equal(reportedRef, false);
  assert.equal(runDeliveryAcked, false);
  assert.ok(!log.edits.includes("secret answer"));
  assert.equal(log.edits.at(-1), "I can't post this reply here right now.");
});

test("a DM stream with always-allowing gate is unaffected", async () => {
  const log = fresh();
  await runDiscordTurn({
    core: core({ wait: async () => ({ status: "ok", reply: "dm reply" }) }),
    channel: channel(log),
    body,
    mode: "stream",
    inFlightRuns: new Set(),
    mayPost: async () => true,
  } as never);
  assert.equal(log.edits.at(-1), "dm reply");
});

test("a throw from onSettled logs the failure, reports the edit ref, and continues the stream", async () => {
  const log = fresh();
  let reportedRef = false;
  const c = {
    ...core({ wait: async () => ({ status: "ok", reply: "stream completed" }) }),
    reportRunEditRef: async () => {
      reportedRef = true;
    },
  } as unknown as SurfaceCoreClient;
  await runDiscordTurn({
    core: c,
    channel: channel(log),
    body,
    mode: "stream",
    inFlightRuns: new Set(),
    mayPost: async () => true,
    onSettled: async () => {
      throw new Error("settle failed");
    },
  } as never);
  assert.equal(reportedRef, true);
  assert.equal(log.edits.at(-1), "stream completed");
  assert.ok(!log.edits.includes("Something went wrong on my end and I couldn't finish that. Try again in a moment."));
});

test("with overlapping ticks, where mayPost resolves true slowly for tick A and false quickly for tick B, the last edit is the refusal text and no model text follows it", async () => {
  const log = fresh();
  let resolveMayPostA!: (val: boolean) => void;
  const mayPostPromiseA = new Promise<boolean>((r) => {
    resolveMayPostA = r;
  });
  let resolveWait!: (result: TurnResult) => void;
  const waitPromise = new Promise<TurnResult>((r) => {
    resolveWait = r;
  });

  const ch: ReplyChannel = {
    async send(content, files): Promise<StatusMessage> {
      log.sent.push(content);
      for (const f of files ?? []) log.files.push(f.name);
      return {
        id: "s1",
        edit: async (c: string) => {
          if (c === "") throw new Error("Cannot send an empty message");
          log.edits.push(c);
          if (c === "I can't post this reply here right now.") resolveWait({ status: "ok", reply: "done" });
        },
        delete: async () => {
          log.deleted += 1;
        },
      };
    },
    typing: async () => {},
  };

  let mayPostCalls = 0;
  const turnPromise = runDiscordTurn({
    core: core({ wait: () => waitPromise, snapshots: ["snapshot a", "snapshot b"] }),
    channel: ch,
    body,
    mode: "stream",
    inFlightRuns: new Set(),
    streamIntervalMs: 5,
    mayPost: async () => {
      mayPostCalls++;
      if (mayPostCalls === 1) return true;
      if (mayPostCalls === 2) return mayPostPromiseA;
      return false;
    },
  });

  await new Promise((r) => setTimeout(r, 25));
  resolveMayPostA(true);
  await turnPromise;
  await new Promise((r) => setTimeout(r, 10));

  assert.equal(log.edits.at(-1), "I can't post this reply here right now.");
  assert.ok(
    !log.edits.slice(log.edits.lastIndexOf("I can't post this reply here right now.") + 1).includes("snapshot a"),
  );
});

test("a tick still in flight when waitRun resolves makes no edit after streamRun returns", async () => {
  const log = fresh();
  let resolveMayPost!: (val: boolean) => void;
  const mayPostPromise = new Promise<boolean>((r) => {
    resolveMayPost = r;
  });
  let resolveWait!: (result: TurnResult) => void;
  const waitPromise = new Promise<TurnResult>((r) => {
    resolveWait = r;
  });

  let mayPostCalls = 0;
  const turnPromise = runDiscordTurn({
    core: core({
      wait: () => waitPromise,
      snapshots: ["preview-mid-stream"],
    }),
    channel: channel(log),
    body,
    mode: "stream",
    inFlightRuns: new Set(),
    streamIntervalMs: 5,
    mayPost: async () => {
      mayPostCalls++;
      if (mayPostCalls === 1) return true;
      if (mayPostCalls === 2) return mayPostPromise;
      return true;
    },
  });

  await new Promise((r) => setTimeout(r, 20));
  assert.equal(mayPostCalls, 2);

  resolveWait({ status: "ok", reply: "final answer" });
  await new Promise((r) => setTimeout(r, 10));

  resolveMayPost(true);
  await turnPromise;
  await new Promise((r) => setTimeout(r, 10));

  assert.equal(log.edits.at(-1), "final answer");
  assert.ok(!log.edits.includes("preview-mid-stream"));
});

test("the gate allows every stream tick, then refuses at the final check", async () => {
  const log = fresh();
  let guestJoined = false;
  let runDeliveryAcked = false;
  const longReply = `secret final reply\n\n${"extra chunk ".repeat(200)}`;
  const c = {
    ...core({
      wait: async () => {
        await new Promise((r) => setTimeout(r, 15));
        guestJoined = true;
        return {
          status: "ok",
          reply: longReply,
          attachments: [{ name: "secret.csv", mimetype: "text/csv", sizeBytes: 5, blobId: "b" }],
        };
      },
      snapshots: ["preview 1"],
    }),
    ackRunDelivery: async () => {
      runDeliveryAcked = true;
    },
  } as unknown as SurfaceCoreClient;

  await runDiscordTurn({
    core: c,
    channel: channel(log),
    body,
    mode: "stream",
    inFlightRuns: new Set(),
    streamIntervalMs: 5,
    mayPost: async () => !guestJoined,
  });

  assert.ok(log.edits.includes("preview 1"));
  assert.ok(!log.edits.some((e) => e.includes("secret final reply")));
  assert.equal(log.edits.at(-1), "I can't post this reply here right now.");
  assert.deepEqual(log.files, []);
  assert.deepEqual(log.sent, ["⚙ Working…"]);
  assert.equal(runDeliveryAcked, false);
});

test("a continuation whose queued result carries no runId with a refusing gate posts no model text", async () => {
  const log = fresh();
  await runDiscordTurn({
    core: core({
      submit: async () => ({ status: "ok", reply: "secret continuation" }),
    }),
    channel: channel(log),
    body,
    mode: "stream",
    inFlightRuns: new Set(),
    mayPost: async () => false,
  });
  assert.equal(log.edits.at(-1), "I can't post this reply here right now.");
  assert.ok(!log.edits.includes("secret continuation"));
});

test("while one tick's mayPost is pending, further intervals do not call mayPost again", async () => {
  const log = fresh();
  let releaseMayPost!: () => void;
  const mayPostDeferred = new Promise<void>((r) => (releaseMayPost = r));
  let releaseWait!: (r: TurnResult) => void;
  const waitDeferred = new Promise<TurnResult>((r) => (releaseWait = r));
  let mayPostCalls = 0;
  const snapshots = ["preview 1", "preview 2", "preview 3"];

  const turn = runDiscordTurn({
    core: core({
      wait: () => waitDeferred,
      snapshots,
    }),
    channel: channel(log),
    body,
    mode: "stream",
    inFlightRuns: new Set(),
    streamIntervalMs: 5,
    mayPost: async () => {
      mayPostCalls++;
      if (mayPostCalls === 2) {
        await mayPostDeferred;
      }
      return true;
    },
  });

  try {
    await new Promise((r) => setTimeout(r, 25));
    assert.equal(mayPostCalls, 2);
  } finally {
    releaseMayPost();
    releaseWait({ status: "ok", reply: "done" });
    await turn.catch(() => {});
  }
});

test("streamRun does not resolve before an in-flight tick's edit settles", async () => {
  const edits: string[] = [];
  let releaseEdit!: () => void;
  const editDeferred = new Promise<void>((r) => (releaseEdit = r));
  let releaseWait!: (r: TurnResult) => void;
  const waitDeferred = new Promise<TurnResult>((r) => (releaseWait = r));

  const ch: ReplyChannel = {
    async send() {
      return {
        id: "s1",
        edit: async (content: string) => {
          if (content === "preview-tick") {
            await editDeferred;
          }
          edits.push(content);
        },
        delete: async () => {},
      };
    },
    typing: async () => {},
  };

  const turn = runDiscordTurn({
    core: core({
      wait: () => waitDeferred,
      snapshots: ["preview-tick"],
    }),
    channel: ch,
    body,
    mode: "stream",
    inFlightRuns: new Set(),
    streamIntervalMs: 5,
    mayPost: allowAll,
  });

  try {
    await new Promise((r) => setTimeout(r, 15));
    releaseWait({ status: "ok", reply: "final answer" });
    await new Promise((r) => setTimeout(r, 10));
    releaseEdit();
    await turn;
    assert.deepEqual(edits, ["preview-tick", "final answer"]);
  } finally {
    releaseEdit();
    releaseWait({ status: "ok", reply: "final answer" });
    await turn.catch(() => {});
  }
});

test("stream mode applies a detect-time react outcome and drops the status message", async () => {
  const log = fresh();
  const reacted: (readonly string[])[] = [];
  await runDiscordTurn({
    core: core({ wait: async () => ({ status: "react", reactions: ["tada", "eyes"] }) }),
    channel: channel(log),
    body,
    mode: "stream",
    inFlightRuns: new Set(),
    mayPost: allowAll,
    onReact: async (names) => {
      reacted.push(names);
    },
  });
  assert.deepEqual(reacted, [["tada", "eyes"]]);
  assert.equal(log.deleted, 1);
  assert.ok(!log.edits.includes("(no response)"));
});

test("spine mode reacts only when posting is allowed", async () => {
  const reacted: (readonly string[])[] = [];
  const run = async (mayPost: () => Promise<boolean>) => {
    await runDiscordTurn({
      core: core({ submit: async () => ({ status: "react", reactions: ["tada"] }) }),
      channel: channel(fresh()),
      body: baseBody,
      mode: "spine",
      ownedRuns: new Set(),
      mayPost,
      onReact: async (names) => {
        reacted.push(names);
      },
    });
  };
  await run(allowAll);
  await run(async () => false);
  assert.deepEqual(reacted, [["tada"]]);
});

test("an unprompted stream turn posts no working message and stays quiet on failure", async () => {
  const log = fresh();
  await runDiscordTurn({
    core: core({ wait: async () => ({ status: "failed" }) }),
    channel: channel(log),
    body: { ...body, unprompted: true },
    mode: "stream",
    inFlightRuns: new Set(),
    mayPost: allowAll,
  });
  assert.deepEqual([log.sent, log.edits], [[], []]);
});

test("an unprompted stream turn still posts a real reply", async () => {
  const log = fresh();
  await runDiscordTurn({
    core: core({ wait: async () => ({ status: "ok", reply: "hello" }) }),
    channel: channel(log),
    body: { ...body, unprompted: true },
    mode: "stream",
    inFlightRuns: new Set(),
    mayPost: allowAll,
  });
  assert.deepEqual(log.sent, ["hello"]);
});

test("an unprompted spine turn posts nothing on refusal, approval or failure", async () => {
  for (const submit of [
    async () => ({ status: "refused" as const, reason: "no" }),
    async () => ({ status: "pending_approval" as const }),
    async (): Promise<TurnResult> => {
      throw new Error("down");
    },
  ]) {
    const log = fresh();
    await runDiscordTurn({
      core: core({ submit }),
      channel: channel(log),
      body: { ...baseBody, unprompted: true },
      mode: "spine",
      ownedRuns: new Set(),
      mayPost: allowAll,
    });
    assert.deepEqual(log.sent, []);
  }
});

function typingChannel(counter: { n: number }): ReplyChannel {
  return {
    send: async () => ({ id: "s1", edit: async () => {}, delete: async () => {} }),
    typing: async () => {
      counter.n += 1;
    },
  };
}

test("spine typing for an unprompted turn starts only once the reply begins", async () => {
  const typed = { n: 0 };
  let beforeReplying = -1;
  const c = {
    ...core({}),
    waitRun: async (_id: string, hooks?: { onReplying?: () => void }) => {
      beforeReplying = typed.n;
      hooks?.onReplying?.();
      return { status: "silent" };
    },
  } as unknown as SurfaceCoreClient;
  await runDiscordTurn({
    core: c,
    channel: typingChannel(typed),
    body: { ...baseBody, unprompted: true },
    mode: "spine",
    ownedRuns: new Set(),
    mayPost: allowAll,
  });
  assert.equal(beforeReplying, 0);
  assert.equal(typed.n, 1);
});

test("spine typing for an unprompted turn the agent declines never shows", async () => {
  const typed = { n: 0 };
  await runDiscordTurn({
    core: core({ wait: async () => ({ status: "silent" }) }),
    channel: typingChannel(typed),
    body: { ...baseBody, unprompted: true },
    mode: "spine",
    ownedRuns: new Set(),
    mayPost: allowAll,
  });
  assert.equal(typed.n, 0);
});

test("spine typing for a prompted turn starts immediately", async () => {
  const typed = { n: 0 };
  await runDiscordTurn({
    core: core({ wait: async () => ({ status: "silent" }) }),
    channel: typingChannel(typed),
    body: baseBody,
    mode: "spine",
    ownedRuns: new Set(),
    mayPost: allowAll,
  });
  assert.equal(typed.n, 1);
});

test("a spine turn calls onNoReply for every outcome except ok, including failed and null results", async () => {
  const outcomes: Array<[string, TurnResult | null, boolean]> = [
    ["ok", { status: "ok", reply: "hi" }, false],
    ["failed", { status: "failed" }, true],
    ["null", null, true],
    ["silent", { status: "silent" }, true],
  ];
  for (const [name, result, expected] of outcomes) {
    let calls = 0;
    await runDiscordTurn({
      core: core({ wait: async () => result }),
      channel: channel(fresh()),
      body: { ...baseBody, unprompted: true },
      mode: "spine",
      ownedRuns: new Set(),
      mayPost: allowAll,
      onNoReply: async () => void (calls += 1),
    });
    assert.equal(calls > 0, expected, name);
  }
});

test("a spine turn whose wait throws keeps the thread, because the run is still live", async () => {
  let calls = 0;
  await runDiscordTurn({
    core: core({
      wait: async () => {
        throw new Error("stall budget");
      },
    }),
    channel: channel(fresh()),
    body: { ...baseBody, unprompted: true },
    mode: "spine",
    ownedRuns: new Set(),
    mayPost: allowAll,
    onNoReply: async () => void (calls += 1),
  });
  assert.equal(calls, 0);
});

test("a spine turn whose submit throws calls onNoReply, because no run exists", async () => {
  let calls = 0;
  await runDiscordTurn({
    core: core({
      submit: async () => {
        throw new Error("down");
      },
    }),
    channel: channel(fresh()),
    body: { ...baseBody, unprompted: true },
    mode: "spine",
    ownedRuns: new Set(),
    mayPost: allowAll,
    onNoReply: async () => void (calls += 1),
  });
  assert.equal(calls, 1);
});
