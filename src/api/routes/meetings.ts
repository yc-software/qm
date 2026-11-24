import { setTimeout as sleep } from "node:timers/promises";
import { reportBackendError } from "../../../plugins/chassis/src/error-reporting.ts";
import { overheardItem } from "../../agent/replay.ts";
import { isValidCapabilityTimezone } from "../../auth/capability-token.ts";
import { isOverheard } from "../../sessions/items.ts";
import type { Run } from "../../runs/run-store.ts";
import { scopeId, type TurnRequest } from "../../types.ts";
import { uuidSchema } from "../../util/ids.ts";
import { readRawBody, sendJson } from "../http.ts";
import type { ApiCtx, Route } from "./route.ts";
import { isObj } from "./shared.ts";
import { transcribeUpload, voiceKey } from "./voice.ts";
import { meetingThread, webTurnBase } from "./web-turns.ts";

const CHECK_IN_MS = 120_000;
const PROMPT_CHARS = 1_000;
const PROMPT_LINES = 12;
const TEXT_BYTES = 64_000;
const START_WAIT_MS = 10_000;
const START_POLL_MS = 100;

const CHECK_IN =
  "Meeting check-in. Reply only with something worth a glance mid-meeting: a claim you checked that is wrong or materially off (what was said, what is true, the source), or context the person would want right now. One or two lines, no summaries. Otherwise end with finish_silently.";

interface Meeting {
  user: string;
  threadRef: string;
}

async function meetingsEnabled(ctx: ApiCtx): Promise<boolean> {
  const user = ctx.actor?.p;
  ctx.res.setHeader("cache-control", "no-store");
  return Boolean(
    user &&
    !ctx.actor?.imp &&
    ctx.deps.sessions &&
    ctx.deps.runs &&
    (await ctx.deps.featureFlags?.enabled("meeting_recorder", scopeId("personal", user))),
  );
}

function clock(at: number, timeZone: string | undefined, date = false): string {
  return new Intl.DateTimeFormat("en-US", {
    hour: "numeric",
    minute: "2-digit",
    ...(date ? { month: "short", day: "numeric" } : {}),
    ...(timeZone ? { timeZone } : {}),
  }).format(at);
}

function epochMs(raw: unknown): number | undefined {
  const at = Number(raw);
  return Number.isSafeInteger(at) && at > 0 ? at : undefined;
}

async function openMeeting(ctx: ApiCtx, id: unknown): Promise<Meeting | undefined> {
  if (!(await meetingsEnabled(ctx))) {
    sendJson(ctx.res, 404, {
      error: "meetings_disabled",
      message: "Meeting recording is not enabled for this account.",
    });
    return undefined;
  }
  const parsed = uuidSchema.safeParse(id);
  if (!parsed.success) {
    sendJson(ctx.res, 400, { error: "bad_request", message: "The meeting id must be a UUID." });
    return undefined;
  }
  const user = ctx.actor!.p;
  return { user, threadRef: meetingThread(user, parsed.data.toLowerCase()) };
}

async function meetingTurn(ctx: ApiCtx, meeting: Meeting, text: string): Promise<TurnRequest> {
  return webTurnBase(ctx, meeting.user, { kind: "dm", threadRef: meeting.threadRef }, meeting.threadRef, text);
}

async function wake(ctx: ApiCtx, meeting: Meeting, text: string, extra: Partial<TurnRequest>): Promise<string | null> {
  const result = await ctx.app.turn({ ...(await meetingTurn(ctx, meeting, text)), ...extra, async: true });
  return result.status === "refused" ? (result.reason ?? "refused") : null;
}

async function startMeeting(ctx: ApiCtx): Promise<void> {
  const p = isObj(ctx.body) ? ctx.body : {};
  const meeting = await openMeeting(ctx, p.id);
  if (!meeting) return;
  const startedAt = epochMs(p.startedAt);
  const timezone = p.timezone;
  if (!startedAt || !isValidCapabilityTimezone(timezone))
    return sendJson(ctx.res, 400, { error: "bad_request", message: "startedAt and a valid timezone are required." });
  const app = typeof p.app === "string" && p.app.trim() ? p.app.trim() : undefined;
  const spawned = await ctx.app.spawnSession(meeting.user, {
    scopeId: scopeId("personal", meeting.user),
    threadRef: meeting.threadRef,
    title: `${app ? `${app} meeting` : "Meeting"} · ${clock(startedAt, timezone, true)}`,
  });
  if (!spawned) return sendJson(ctx.res, 403, { error: "forbidden" });
  const at = clock(startedAt, timezone);
  const refused = await wake(
    ctx,
    meeting,
    `The recording started${app ? ` in ${app}` : ""} at ${at} (${timezone}). Find the calendar event happening now (title, attendees, agenda) and anything relevant to it, then reply with a one-to-three-line brief: what the meeting is, who is in it, and what is worth knowing going in.`,
    {
      displayText: ["Recording started", app, at].filter(Boolean).join(" · "),
      timezone,
      midTurn: "queue",
      skipMemory: true,
      idempotencyKey: `${meeting.threadRef}:start`,
    },
  );
  if (refused) return sendJson(ctx.res, 403, { error: "refused", message: refused });
  let started: Run | null = null;
  for (let waited = 0; waited < START_WAIT_MS; waited += START_POLL_MS) {
    started = await ctx.deps.runs!.getByDedupKey(`${meeting.threadRef}:start`);
    if (!started || started.turnUserSeq !== null || started.status === "done" || started.status === "failed") break;
    await sleep(START_POLL_MS);
  }
  return sendJson(ctx.res, 201, {
    path: `/s/${encodeURIComponent(spawned.session.id)}`,
    prompt: started ? transcriptionPrompt(started, []) : "",
  });
}

function transcriptionPrompt(started: Run, recent: string[]): string {
  const brief = (started.result?.reply ?? "").slice(0, PROMPT_CHARS / 2);
  const tail = [...new Set(recent)].join("\n").slice(-(PROMPT_CHARS - brief.length));
  return [brief, tail].filter(Boolean).join("\n");
}

async function heardText(ctx: ApiCtx, prompt: string): Promise<string | null | undefined> {
  if (ctx.req.headers["content-type"]?.split(";")[0]?.trim() !== "application/json") {
    const key = voiceKey(ctx);
    if (key) return transcribeUpload(ctx, key, prompt, "meeting");
    sendJson(ctx.res, 403, {
      error: "transcription_unavailable",
      message: "This server has no OpenAI key, so meetings can only be transcribed on the Mac.",
    });
    return undefined;
  }
  const body: unknown = await readRawBody(ctx.req, TEXT_BYTES)
    .then(JSON.parse)
    .catch(() => undefined);
  if (isObj(body) && typeof body.text === "string") return body.text.trim();
  sendJson(ctx.res, 400, { error: "bad_request", message: "A segment transcribed on the Mac needs its text." });
  return undefined;
}

async function meetingSpeech(ctx: ApiCtx): Promise<void> {
  const meeting = await openMeeting(ctx, ctx.params.id);
  if (!meeting) return;
  const sessions = ctx.deps.sessions!;
  const speaker = ctx.url.searchParams.get("speaker");
  const at = epochMs(ctx.url.searchParams.get("at"));
  if ((speaker !== "me" && speaker !== "others") || !at)
    return sendJson(ctx.res, 400, {
      error: "bad_request",
      message: "speaker must be me or others, and at a time in epoch milliseconds.",
    });
  const [session, started] = await Promise.all([
    sessions.getByThread(meeting.threadRef),
    ctx.deps.runs!.getByDedupKey(`${meeting.threadRef}:start`),
  ]);
  if (!session || !started) return sendJson(ctx.res, 404, { error: "not_found" });
  const recent = (await sessions.getItems(session.id, { limit: PROMPT_LINES, messagesOnly: true }))
    .filter(isOverheard)
    .map((item) => item.text ?? "");
  const text = await heardText(ctx, transcriptionPrompt(started, recent));
  if (text === undefined) return;
  const prompt = transcriptionPrompt(started, text ? [...recent, text] : recent);
  if (!text) return sendJson(ctx.res, 200, { text: "", prompt });
  const stored = await sessions.appendDelivery(
    { sessionId: session.id },
    overheardItem({
      overheard: true,
      ts: `${(at / 1000).toFixed(3)}:${speaker}`,
      name: speaker === "me" ? ctx.actor!.n?.trim() || "Me" : "Others",
      text,
    }),
  );
  if (stored) await afterSpeech(ctx, meeting, session.id, started);
  return sendJson(ctx.res, 200, { text, prompt });
}

async function afterSpeech(ctx: ApiCtx, meeting: Meeting, sessionId: string, started: Run): Promise<void> {
  const runs = ctx.deps.runs!;
  const [inFlight, stopped] = await Promise.all([
    runs.inFlightForThread(meeting.threadRef),
    runs.getByDedupKey(`${meeting.threadRef}:stop`),
  ]);
  if (!inFlight.some((run) => run.status === "running"))
    ctx.deps.sessionStateBus?.emit({
      threadRef: meeting.threadRef,
      sessionId,
      participants: [meeting.user],
      state: "idle",
      at: Date.now(),
    });
  const slot = Math.floor((Date.now() - started.createdAt) / CHECK_IN_MS);
  if (stopped || slot < 1 || inFlight.some((run) => run.status === "pending")) return;
  const { deliveryTarget: _web, clientSurface: _client, ...checkIn } = await meetingTurn(ctx, meeting, CHECK_IN);
  const result = await ctx.app.turn({
    ...checkIn,
    surface: "meeting",
    origin: { kind: "automation" },
    idempotencyKey: `${meeting.threadRef}:check-in:${slot}`,
    async: true,
  });
  if (result.status === "refused")
    reportBackendError(new Error(`meeting check-in refused: ${result.reason}`), "meeting_check_in_refused", {
      threadRef: meeting.threadRef,
    });
}

async function stopMeeting(ctx: ApiCtx): Promise<void> {
  const meeting = await openMeeting(ctx, ctx.params.id);
  if (!meeting) return;
  const endedAt = epochMs(isObj(ctx.body) ? ctx.body.endedAt : undefined);
  if (!endedAt) return sendJson(ctx.res, 400, { error: "bad_request", message: "endedAt is required." });
  const started = await ctx.deps.runs!.getByDedupKey(`${meeting.threadRef}:start`);
  if (!started) return sendJson(ctx.res, 404, { error: "not_found" });
  const timezone = started.request.timezone;
  const at = clock(endedAt, timezone);
  const refused = await wake(
    ctx,
    meeting,
    `The recording stopped at ${at}. Write the meeting up: a short summary, decisions, action items with owners, and a "Checked" list of the claims you verified or could not verify, with sources. Attach a corrected transcript as a Markdown file: fix misheard names and terms from context, and attribute speakers where the evidence supports it.`,
    {
      displayText: `Recording stopped · ${at}`,
      ...(timezone ? { timezone } : {}),
      midTurn: "queue",
      skipMemory: true,
      idempotencyKey: `${meeting.threadRef}:stop`,
    },
  );
  if (refused) return sendJson(ctx.res, 403, { error: "refused", message: refused });
  return sendJson(ctx.res, 202, {});
}

const route = (method: string, path: string, handle: Route<ApiCtx>["handle"]): Route<ApiCtx> => ({
  method,
  path,
  browser: true,
  actor: "person",
  auth: "source",
  handle,
});

export const meetingRoutes: ReadonlyArray<Route<ApiCtx>> = [
  route("GET", "/v1/web/meetings", async (ctx) => sendJson(ctx.res, 200, { enabled: await meetingsEnabled(ctx) })),
  route("POST", "/v1/web/meetings", startMeeting),
  { ...route("POST", "/v1/web/meetings/:id/speech", meetingSpeech), streamBody: true },
  route("POST", "/v1/web/meetings/:id/stop", stopMeeting),
];
