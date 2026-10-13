import { createHash } from "node:crypto";
import type { IncomingMessage } from "node:http";
import { PayloadTooLargeError } from "../../chassis/src/http.ts";
import { voiceEnabled } from "./live-voice.ts";

export const MAX_DICTATION_BYTES = 10 * 1024 * 1024;
export const dictationFormats: Record<string, string> = {
  "audio/mp4": "m4a",
  "audio/m4a": "m4a",
  "audio/mpeg": "mp3",
  "audio/wav": "wav",
  "audio/webm": "webm",
};

export interface SpeechToTextProvider {
  name: string;
  transcribe(input: {
    audio: Uint8Array;
    mimeType: string;
    user: string;
    org: string;
    signal: AbortSignal;
  }): Promise<string>;
}

export function speechToTextProvider(
  env: NodeJS.ProcessEnv = process.env,
  request: typeof fetch = fetch,
): SpeechToTextProvider | undefined {
  if (!env.OPENAI_API_KEY?.trim()) return;
  const apiKey = env.OPENAI_API_KEY.trim();
  const model = "gpt-transcribe";
  return {
    name: "OpenAI",
    async transcribe({ audio, mimeType, user, org, signal }) {
      const extension = dictationFormats[mimeType];
      if (!extension || audio.byteLength === 0 || audio.byteLength > MAX_DICTATION_BYTES)
        throw new Error("Invalid audio");
      const form = new FormData();
      form.set("model", model);
      form.set("file", new Blob([Uint8Array.from(audio)], { type: mimeType }), `dictation.${extension}`);
      const response = await request("https://api.openai.com/v1/audio/transcriptions", {
        method: "POST",
        redirect: "error",
        signal: AbortSignal.any([signal, AbortSignal.timeout(60_000)]),
        headers: {
          authorization: `Bearer ${apiKey}`,
          "OpenAI-Safety-Identifier": createHash("sha256")
            .update(JSON.stringify([org, user]))
            .digest("hex"),
        },
        body: form,
      });
      if (!response.ok) throw new Error(`Transcription provider returned HTTP ${response.status}`);
      const result = (await response.json()) as { text?: unknown };
      if (typeof result.text !== "string" || result.text.length > 100_000) throw new Error("Invalid transcript");
      return result.text.trim();
    },
  };
}

export function dictationEnabled(user: string, env: NodeJS.ProcessEnv = process.env): boolean {
  return voiceEnabled(user, env);
}

export async function readDictation(req: IncomingMessage): Promise<Uint8Array> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += bytes.length;
    if (size > MAX_DICTATION_BYTES) throw new PayloadTooLargeError();
    chunks.push(bytes);
  }
  return Buffer.concat(chunks);
}
