import type { IncomingMessage, ServerResponse } from "node:http";
import { json, readBodyBytes, PayloadTooLargeError } from "../../chassis/src/http.ts";
import { coreClaimStore, withinRateLimit } from "../../chassis/src/claims.ts";
import { reportBackendError } from "../../chassis/src/error-reporting.ts";
import { errMessage } from "../../chassis/src/errors.ts";
import {
  createLiveVoice,
  dictationFormats,
  LIVE_MODEL,
  MAX_DICTATION_BYTES,
  openaiKey,
  transcribe,
  voiceEnabled,
  voiceRequestAllowed,
  VoiceProviderError,
} from "./voice.ts";

const BODY_READ_TIMEOUT_MS = 30_000;

function causes(error: unknown): string {
  const chain: string[] = [];
  for (let e: unknown = error; e instanceof Error && chain.length < 4; e = e.cause) {
    const code = (e as { code?: unknown }).code;
    chain.push(`${e.name}: ${errMessage(e)}${typeof code === "string" ? ` (${code})` : ""}`);
  }
  return chain.length ? chain.join(" <- ") : errMessage(error);
}

function reportVoiceError(error: unknown, code: string, aborted = false): void {
  const detail = { ...(error instanceof VoiceProviderError ? error.detail : {}), aborted };
  console.error(`[voice] ${code}: ${causes(error)} ${JSON.stringify(detail)}`);
  reportBackendError(error, code, detail);
}

export async function handleVoiceRoute(
  req: IncomingMessage,
  res: ServerResponse,
  path: string,
  identity: { user: string; impersonator: string | null; portalVerified: boolean },
  config: { core: string; secret: string | undefined; org: string; publicUrl: string },
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
    let allowed: boolean;
    try {
      allowed = await withinRateLimit(coreClaimStore(config.core, config.secret, dictation ? "dictation" : "voice"), {
        secret: config.secret!,
        kind: dictation ? "dictation" : "voice-session",
        value: `${config.org}:${user}`,
        limit: dictation ? 60 : 6,
        windowS: 3600,
        nowMs: Date.now(),
      });
    } catch (error) {
      reportVoiceError(error, dictation ? "dictation_rate_limit_store" : "voice_rate_limit_store");
      res.setHeader("retry-after", "30");
      return json(res, 503, { error: "rate_limit_unavailable", message: "Voice is temporarily unavailable." });
    }
    if (!allowed)
      return dictation
        ? json(res, 429, { error: "dictation_rate_limit", message: "Dictation limit reached. Try again next hour." })
        : json(res, 429, { error: "voice_rate_limit", message: "Voice session limit reached. Try again next hour." });

    const caller = {
      user,
      org: config.org,
      apiKey: openaiKey()!,
      signal: AbortSignal.any([controller.signal, AbortSignal.timeout(dictation ? 60_000 : 25_000)]),
    };
    if (!dictation) return json(res, 201, await createLiveVoice(sdp, caller));
    const readTimer = setTimeout(() => req.destroy(), BODY_READ_TIMEOUT_MS);
    let audio: Buffer;
    try {
      audio = await readBodyBytes(req, MAX_DICTATION_BYTES);
    } catch (error) {
      if (error instanceof PayloadTooLargeError) {
        res.setHeader("connection", "close");
        return json(res, 413, { error: "audio_too_large" });
      }
      if (!controller.signal.aborted) reportVoiceError(error, "dictation_upload");
      return controller.signal.aborted ? undefined : json(res, 400, { error: "upload_failed" });
    } finally {
      clearTimeout(readTimer);
    }
    if (!audio.byteLength) return json(res, 400, { error: "empty_audio" });
    return json(res, 200, { text: await transcribe(audio, mimeType, caller) });
  } catch (error) {
    reportVoiceError(error, dictation ? "dictation_provider" : "voice_provider", controller.signal.aborted);
    if (controller.signal.aborted) return;
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
