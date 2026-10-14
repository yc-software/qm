import { randomUUID } from "node:crypto";
import { createWriteStream } from "node:fs";
import { mkdir, readdir, rm, stat } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pipeline } from "node:stream/promises";
import { json, readBodyBytes, PayloadTooLargeError } from "../../chassis/src/http.ts";
import { reportBackendError } from "../../chassis/src/error-reporting.ts";
import { errChain } from "../../chassis/src/errors.ts";
import {
  createLiveVoice,
  dictationFormats,
  LIVE_MODEL,
  openaiKey,
  transcribe,
  voiceEnabled,
  voiceRequestAllowed,
  VoiceProviderError,
} from "./voice.ts";

const TRANSCRIBE_TIMEOUT_MS = 600_000;
const LIVE_SESSION_TIMEOUT_MS = 25_000;
const MAX_RETRY_AFTER_S = 3600;

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
  await mkdir(SPOOL_DIR, { recursive: true });
  const file = join(SPOOL_DIR, randomUUID());
  const out = createWriteStream(file);
  try {
    await pipeline(req, out, { signal });
  } catch (error) {
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

export async function handleVoiceRoute(
  req: IncomingMessage,
  res: ServerResponse,
  path: string,
  identity: { user: string; impersonator: string | null; portalVerified: boolean },
  config: { org: string; publicUrl: string },
): Promise<void> {
  const { user } = identity;
  const enabled = voiceEnabled(user) && !identity.impersonator;
  res.setHeader("cache-control", "no-store");
  if (req.method === "GET" && path === "/api/dictation")
    return json(res, 200, { enabled, provider: enabled ? "OpenAI" : null });
  if (req.method === "GET" && path === "/api/voice") return json(res, 200, { enabled, model: LIVE_MODEL });
  if (req.method !== "POST" || path === "/api/voice") return json(res, 405, { error: "method_not_allowed" });

  const dictation = path === "/api/dictation";
  if (!enabled)
    return dictation
      ? json(res, 404, { error: "dictation_disabled", message: "Dictation is not enabled for this account." })
      : json(res, 404, { error: "voice_disabled" });
  if (!voiceRequestAllowed(req, config.publicUrl, identity.portalVerified))
    return json(res, 403, { error: "unexpected_origin" });
  const mimeType = req.headers["content-type"]?.split(";")[0]?.trim() ?? "";
  let sdp = "";
  if (dictation) {
    if (!Object.hasOwn(dictationFormats, mimeType)) return json(res, 415, { error: "unsupported_audio" });
  } else {
    let offer: { sdp?: unknown } | null;
    try {
      offer = JSON.parse((await readBodyBytes(req, 65_536)).toString("utf8")) as { sdp?: unknown } | null;
    } catch (error) {
      if (error instanceof PayloadTooLargeError) {
        res.setHeader("connection", "close");
        return json(res, 413, { error: "offer_too_large" });
      }
      return json(res, 400, { error: "invalid_offer" });
    }
    if (typeof offer?.sdp !== "string" || !offer.sdp.startsWith("v=0") || offer.sdp.length > 60_000)
      return json(res, 400, { error: "invalid_offer" });
    sdp = offer.sdp;
  }

  const controller = new AbortController();
  const disconnect = () => {
    if (!res.writableEnded) controller.abort();
  };
  res.once("close", disconnect);
  try {
    const caller = (timeoutMs: number) => ({
      user,
      org: config.org,
      apiKey: openaiKey()!,
      signal: AbortSignal.any([controller.signal, AbortSignal.timeout(timeoutMs)]),
    });
    if (!dictation) return json(res, 201, await createLiveVoice(sdp, caller(LIVE_SESSION_TIMEOUT_MS)));
    let audio: { file: string; size: number };
    try {
      audio = await spool(req, controller.signal);
    } catch (error) {
      reportVoiceError(error, "dictation_upload", controller.signal.aborted);
      if (controller.signal.aborted) return;
      return (error as NodeJS.ErrnoException).code === "ENOSPC"
        ? json(res, 503, { error: "dictation_unavailable", message: "The server is out of space for recordings." })
        : json(res, 400, { error: "upload_failed" });
    }
    let text: string | null = null;
    try {
      if (audio.size) text = await transcribe(audio.file, audio.size, mimeType, caller(TRANSCRIBE_TIMEOUT_MS));
    } finally {
      await rm(audio.file, { force: true }).catch((error: unknown) => reportVoiceError(error, "dictation_cleanup"));
    }
    return text === null ? json(res, 400, { error: "empty_audio" }) : json(res, 200, { text });
  } catch (error) {
    reportVoiceError(error, dictation ? "dictation_provider" : "voice_provider", controller.signal.aborted);
    if (controller.signal.aborted) return;
    const provider = error instanceof VoiceProviderError ? error : undefined;
    if (provider?.status === 429 && provider.code !== "insufficient_quota") {
      if (provider.retryAfterS !== undefined)
        res.setHeader("retry-after", String(Math.min(provider.retryAfterS, MAX_RETRY_AFTER_S)));
      return json(res, 429, {
        error: "provider_rate_limit",
        message: "OpenAI is rate limiting requests. Try again shortly.",
      });
    }
    if (dictation && provider?.status === 413) return json(res, 413, { error: "audio_too_large" });
    if (
      dictation &&
      provider?.status === 400 &&
      (provider.code === "unsupported_format" || provider.code === "invalid_value")
    )
      return json(res, 400, { error: "invalid_audio", message: "OpenAI could not read this recording." });
    if (provider?.status !== undefined && provider.status >= 400 && provider.status < 500 && provider.status !== 429)
      return json(res, 502, { error: dictation ? "dictation_rejected" : "voice_rejected" });
    return dictation
      ? json(res, 503, {
          error: "dictation_unavailable",
          message: "Could not transcribe the recording. Please try again.",
        })
      : json(res, 503, { error: "voice_unavailable", message: "Voice could not connect. Please try again." });
  } finally {
    res.off("close", disconnect);
  }
}
