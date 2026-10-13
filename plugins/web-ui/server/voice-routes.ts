import type { IncomingMessage, ServerResponse } from "node:http";
import { json, readBody as readBodyCapped, PayloadTooLargeError } from "../../chassis/src/http.ts";
import { coreClaimStore, withinRateLimit } from "../../chassis/src/claims.ts";
import { reportBackendError } from "../../chassis/src/error-reporting.ts";
import {
  dictationEnabled,
  dictationFormats,
  MAX_DICTATION_BYTES,
  readDictation,
  speechToTextProvider,
} from "./speech-to-text.ts";
import { createLiveVoice, voiceEnabled, voiceOriginAllowed } from "./live-voice.ts";

export async function handleVoiceRoute(
  req: IncomingMessage,
  res: ServerResponse,
  path: string,
  identity: { user: string; impersonator: string | null; portalVerified: boolean },
  config: { core: string; secret: string | undefined; org: string; publicUrl: string },
): Promise<void> {
  const { user } = identity;
  const method = req.method;
  const { core: CORE, secret: CORE_SIGNING_SECRET, org: ORG, publicUrl: PUBLIC_URL } = config;
  if (path === "/api/dictation" && method === "GET") {
    res.setHeader("cache-control", "no-store");
    const enabled = dictationEnabled(user) && !identity.impersonator;
    return json(res, 200, { enabled, provider: enabled ? speechToTextProvider()!.name : null });
  }
  if (path === "/api/dictation" && method === "POST") {
    res.setHeader("cache-control", "no-store");
    if (!dictationEnabled(user) || identity.impersonator)
      return json(res, 404, { error: "dictation_disabled", message: "Dictation is not enabled for this account." });
    if (!voiceOriginAllowed(req.headers.origin, PUBLIC_URL, identity.portalVerified))
      return json(res, 403, { error: "unexpected_origin" });
    const mimeType = req.headers["content-type"]?.split(";")[0]?.trim() ?? "";
    if (!Object.hasOwn(dictationFormats, mimeType)) return json(res, 415, { error: "unsupported_audio" });
    if (Number(req.headers["content-length"]) > MAX_DICTATION_BYTES)
      return json(res, 413, { error: "audio_too_large" });
    const controller = new AbortController();
    const disconnect = () => {
      if (!res.writableEnded) controller.abort();
    };
    res.once("close", disconnect);
    try {
      const allowed = await withinRateLimit(coreClaimStore(CORE, CORE_SIGNING_SECRET, "dictation"), {
        secret: CORE_SIGNING_SECRET!,
        kind: "dictation",
        value: `${ORG}:${user}`,
        limit: 60,
        windowS: 3600,
        nowMs: Date.now(),
      });
      if (!allowed)
        return json(res, 429, {
          error: "dictation_rate_limit",
          message: "Dictation limit reached. Try again next hour.",
        });
      const audio = await readDictation(req);
      if (!audio.byteLength) return json(res, 400, { error: "empty_audio" });
      const text = await speechToTextProvider()!.transcribe({
        audio,
        mimeType,
        user,
        org: ORG,
        signal: controller.signal,
      });
      return json(res, 200, { text });
    } catch (error) {
      reportBackendError(error);
      if (controller.signal.aborted) return;
      if (error instanceof PayloadTooLargeError) return json(res, 413, { error: "audio_too_large" });
      return json(res, 503, {
        error: "dictation_unavailable",
        message: "Could not transcribe the recording. Please try again.",
      });
    } finally {
      res.off("close", disconnect);
    }
  }
  if (path === "/api/voice" && method === "GET") {
    res.setHeader("cache-control", "no-store");
    return json(res, 200, {
      enabled: voiceEnabled(user) && !identity.impersonator,
      model: "gpt-live-1",
    });
  }
  if (path === "/api/voice/sessions" && method === "POST") {
    res.setHeader("cache-control", "no-store");
    if (!voiceEnabled(user) || identity.impersonator) return json(res, 404, { error: "voice_disabled" });
    if (!voiceOriginAllowed(req.headers.origin, PUBLIC_URL, identity.portalVerified))
      return json(res, 403, { error: "unexpected_origin" });
    const raw = await readBodyCapped(req, 65_536);
    let body: { sdp?: unknown } | null;
    try {
      body = JSON.parse(raw) as { sdp?: unknown } | null;
    } catch {
      return json(res, 400, { error: "invalid_offer" });
    }
    if (typeof body?.sdp !== "string" || !body.sdp.startsWith("v=0") || body.sdp.length > 60_000)
      return json(res, 400, { error: "invalid_offer" });
    try {
      const allowed = await withinRateLimit(coreClaimStore(CORE, CORE_SIGNING_SECRET, "voice"), {
        secret: CORE_SIGNING_SECRET!,
        kind: "voice-session",
        value: `${ORG}:${user}`,
        limit: 6,
        windowS: 3600,
        nowMs: Date.now(),
      });
      if (!allowed)
        return json(res, 429, {
          error: "voice_rate_limit",
          message: "Voice session limit reached. Try again next hour.",
        });
      const session = await createLiveVoice(body.sdp, user, ORG, process.env.OPENAI_API_KEY!);
      return json(res, 201, session);
    } catch (error) {
      reportBackendError(error);
      return json(res, 503, {
        error: "voice_unavailable",
        message: "Voice could not connect. Check the deployment's OpenAI access and try again.",
      });
    }
  }
  return json(res, 405, { error: "method_not_allowed" });
}
