import { randomUUID } from "node:crypto";
import fs from "node:fs";
import { chmod, mkdir, readdir, rm, stat } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { finished } from "node:stream/promises";
import { readBodyBytes, PayloadTooLargeError, relayStream } from "../../../plugins/chassis/src/http.ts";
import { reportBackendError } from "../../../plugins/chassis/src/error-reporting.ts";
import { errChain } from "../../../plugins/chassis/src/errors.ts";
import { orgId } from "../../config.ts";
import { MAX_BLOB_BYTES } from "../../persistence/blob-transfer.ts";
import { createLiveVoice, dictationFormats, LIVE_MODEL, transcribe, VoiceProviderError } from "../../voice/voice.ts";
import { extendBodyDeadline, sendJson } from "../http.ts";
import type { ApiCtx, Route } from "./route.ts";

const TRANSCRIBE_TIMEOUT_MS = 600_000;
const LIVE_SESSION_TIMEOUT_MS = 25_000;
const MAX_RETRY_AFTER_S = 3600;
const REJECTED_STATUSES = new Set([400, 401, 403, 404, 422]);

const SPOOL_DIR = join(tmpdir(), "qm-dictation");
const STALE_SPOOL_MS = 3_600_000;

export async function sweepDictationSpool(nowMs = Date.now()): Promise<void> {
  const names = await readdir(SPOOL_DIR).catch(() => []);
  for (const name of names) {
    const file = join(SPOOL_DIR, name);
    const info = await stat(file).catch(() => null);
    if (info && nowMs - info.mtimeMs > STALE_SPOOL_MS) await rm(file, { force: true }).catch(() => undefined);
  }
}

async function spool(req: IncomingMessage, signal: AbortSignal): Promise<{ file: string; size: number }> {
  await mkdir(SPOOL_DIR, { recursive: true, mode: 0o700 });
  await chmod(SPOOL_DIR, 0o700);
  const file = join(SPOOL_DIR, randomUUID());
  const out = fs.createWriteStream(file, { mode: 0o600 });
  let received = 0;
  req.on("data", (chunk: Buffer) => {
    received += chunk.length;
    if (received > MAX_BLOB_BYTES) out.destroy(new PayloadTooLargeError());
  });
  try {
    relayStream(req, out, { onError: (error) => out.destroy(error) });
    await finished(out, { signal });
  } catch (error) {
    out.destroy();
    await rm(file, { force: true }).catch(() => undefined);
    throw error;
  }
  return { file, size: out.bytesWritten };
}

function reportVoiceError(error: unknown, code: string, aborted = false): void {
  const detail = { ...(error instanceof VoiceProviderError ? error.detail : {}), aborted };
  console.error(`[voice] ${code}: ${errChain(error)} ${JSON.stringify(detail)}`);
  if (!aborted) reportBackendError(error, code, detail);
}

export function voiceKey(ctx: ApiCtx): string | undefined {
  ctx.res.setHeader("cache-control", "no-store");
  return ctx.actor?.imp ? undefined : ctx.deps.openaiApiKey?.trim() || undefined;
}

type UploadKind = "voice" | "dictation" | "meeting";

interface Caller {
  user: string;
  org: string;
  apiKey: string;
  signal: AbortSignal;
}

function meetingFailure(res: ServerResponse, provider: VoiceProviderError | undefined): boolean {
  const status = provider?.status;
  if (status === 401 || status === 403 || status === 404 || provider?.code === "insufficient_quota") {
    sendJson(res, 403, {
      error: "transcription_refused",
      message: "OpenAI refused this instance's transcription requests, so the meeting cannot be transcribed.",
    });
    return true;
  }
  if (status !== undefined && REJECTED_STATUSES.has(status)) {
    sendJson(res, 422, {
      error: "segment_rejected",
      message: "OpenAI rejected this part of the recording. Retrying will not help.",
    });
    return true;
  }
  return false;
}

function providerFailure(res: ServerResponse, error: unknown, kind: UploadKind): void {
  const provider = error instanceof VoiceProviderError ? error : undefined;
  const dictation = kind !== "voice";
  if (provider?.status === 429 && provider.code !== "insufficient_quota") {
    if (provider.retryAfterS !== undefined)
      res.setHeader("retry-after", String(Math.min(provider.retryAfterS, MAX_RETRY_AFTER_S)));
    return sendJson(res, 429, {
      error: "provider_rate_limit",
      message: "OpenAI is rate limiting requests. Try again shortly.",
    });
  }
  if (dictation && provider?.status === 413)
    return sendJson(res, 413, { error: "audio_too_large", message: "OpenAI says this recording is too large." });
  if (
    dictation &&
    provider?.status === 400 &&
    (provider.code === "unsupported_format" || (provider.code === "invalid_value" && provider.param === "file"))
  )
    return sendJson(res, 400, { error: "invalid_audio", message: "OpenAI could not read this recording." });
  if (kind === "meeting" && meetingFailure(res, provider)) return;
  if (provider?.status !== undefined && REJECTED_STATUSES.has(provider.status))
    return sendJson(res, 502, {
      error: dictation ? "dictation_rejected" : "voice_rejected",
      message: "OpenAI rejected the request. Retrying will not help.",
    });
  return dictation
    ? sendJson(res, 503, {
        error: "dictation_unavailable",
        message: "Could not transcribe the recording. Please try again.",
      })
    : sendJson(res, 503, { error: "voice_unavailable", message: "Voice could not connect. Please try again." });
}

async function callProvider(
  ctx: ApiCtx,
  apiKey: string,
  kind: UploadKind,
  work: (caller: (timeoutMs: number) => Caller, clientGone: AbortSignal) => Promise<void>,
): Promise<void> {
  const { res } = ctx;
  const controller = new AbortController();
  const finished = new AbortController();
  const disconnect = () => {
    if (!res.writableEnded) controller.abort();
  };
  res.once("close", disconnect);
  try {
    await work(
      (timeoutMs) => ({
        user: ctx.actor!.p,
        org: orgId(),
        apiKey,
        signal: AbortSignal.any([controller.signal, finished.signal, AbortSignal.timeout(timeoutMs)]),
      }),
      controller.signal,
    );
  } catch (error) {
    reportVoiceError(error, kind === "voice" ? "voice_provider" : "dictation_provider", controller.signal.aborted);
    if (!controller.signal.aborted) providerFailure(res, error, kind);
  } finally {
    finished.abort();
    res.off("close", disconnect);
  }
}

export async function transcribeUpload(
  ctx: ApiCtx,
  apiKey: string,
  prompt?: string,
  kind: UploadKind = "dictation",
): Promise<string | null | undefined> {
  const { req, res } = ctx;
  const mimeType = req.headers["content-type"]?.split(";")[0]?.trim() ?? "";
  if (!Object.hasOwn(dictationFormats, mimeType)) {
    sendJson(res, 415, { error: "unsupported_audio" });
    return undefined;
  }
  extendBodyDeadline(req, TRANSCRIBE_TIMEOUT_MS);
  let text: string | null | undefined;
  await callProvider(ctx, apiKey, kind, async (caller, clientGone) => {
    let audio: { file: string; size: number };
    try {
      audio = await spool(req, clientGone);
    } catch (error) {
      if (error instanceof PayloadTooLargeError) {
        res.setHeader("connection", "close");
        return sendJson(res, 413, { error: "payload_too_large", message: error.message });
      }
      reportVoiceError(error, "dictation_upload", clientGone.aborted);
      if (clientGone.aborted) return;
      return sendJson(res, 503, {
        error: "dictation_unavailable",
        message: "The server could not store the recording.",
      });
    }
    try {
      text = audio.size
        ? await transcribe(audio.file, audio.size, mimeType, caller(TRANSCRIBE_TIMEOUT_MS), prompt)
        : null;
    } finally {
      await rm(audio.file, { force: true }).catch((error: unknown) => reportVoiceError(error, "dictation_cleanup"));
    }
  });
  return text;
}

async function dictate(ctx: ApiCtx): Promise<void> {
  const apiKey = voiceKey(ctx);
  if (!apiKey)
    return sendJson(ctx.res, 404, {
      error: "dictation_disabled",
      message: "Dictation is not enabled for this account.",
    });
  const text = await transcribeUpload(ctx, apiKey);
  if (text === undefined) return;
  return text === null ? sendJson(ctx.res, 400, { error: "empty_audio" }) : sendJson(ctx.res, 200, { text });
}

async function liveVoice(ctx: ApiCtx): Promise<void> {
  const { req, res } = ctx;
  const apiKey = voiceKey(ctx);
  if (!apiKey) return sendJson(res, 404, { error: "voice_disabled" });
  let offer: { sdp?: unknown } | null;
  try {
    offer = JSON.parse((await readBodyBytes(req, 65_536)).toString("utf8")) as { sdp?: unknown } | null;
  } catch (error) {
    if (error instanceof PayloadTooLargeError) {
      res.setHeader("connection", "close");
      return sendJson(res, 413, { error: "offer_too_large" });
    }
    return sendJson(res, 400, { error: "invalid_offer" });
  }
  const sdp = offer?.sdp;
  if (typeof sdp !== "string" || !sdp.startsWith("v=0") || sdp.length > 60_000)
    return sendJson(res, 400, { error: "invalid_offer" });
  return callProvider(ctx, apiKey, "voice", async (caller) =>
    sendJson(res, 201, await createLiveVoice(sdp, caller(LIVE_SESSION_TIMEOUT_MS))),
  );
}

export const voiceRoutes: ReadonlyArray<Route<ApiCtx>> = [
  {
    method: "GET",
    path: "/v1/web/dictation",
    browser: true,
    actor: "person",
    auth: "source",
    handle: (ctx) => {
      const enabled = Boolean(voiceKey(ctx));
      sendJson(ctx.res, 200, { enabled, provider: enabled ? "OpenAI" : null });
    },
  },
  {
    method: "POST",
    path: "/v1/web/dictation",
    browser: true,
    actor: "person",
    auth: "source",
    streamBody: true,
    handle: dictate,
  },
  {
    method: "GET",
    path: "/v1/web/voice",
    browser: true,
    actor: "person",
    auth: "source",
    handle: (ctx) => sendJson(ctx.res, 200, { enabled: Boolean(voiceKey(ctx)), model: LIVE_MODEL }),
  },
  {
    method: "POST",
    path: "/v1/web/voice/sessions",
    browser: true,
    actor: "person",
    auth: "source",
    streamBody: true,
    handle: liveVoice,
  },
];
