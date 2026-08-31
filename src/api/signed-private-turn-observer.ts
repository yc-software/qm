import { isStrongSigningSecret } from "../auth/source-auth.ts";
import { signedRequestHeaders } from "../auth/source-auth-sign.ts";
import {
  snapshotPrivateTurnObservation,
  type PrivateTurnObservation,
  type PrivateTurnObservationSink,
} from "./private-turn-observer.ts";

interface SignedPrivateTurnObserverOptions {
  endpoint: string;
  signingSecret: string;
  fetch?: typeof fetch;
  now?: () => number;
}

export function privateTurnObserverSignaturePayload(idempotencyKey: string, body: string): string {
  return `${idempotencyKey}\n${body}`;
}

export function createSignedPrivateTurnObserver(options: SignedPrivateTurnObserverOptions): PrivateTurnObservationSink {
  let endpoint: URL;
  try {
    endpoint = new URL(options.endpoint);
  } catch {
    throw new TypeError("private turn observer endpoint must be an HTTPS URL");
  }
  if (
    endpoint.protocol !== "https:" ||
    endpoint.username ||
    endpoint.password ||
    endpoint.hash ||
    endpoint.hostname.endsWith(".")
  ) {
    throw new TypeError("private turn observer endpoint must be an HTTPS URL without credentials or a fragment");
  }
  if (!isStrongSigningSecret(options.signingSecret)) {
    throw new TypeError("private turn observer signing secret must contain at least 32 characters");
  }
  const request = options.fetch ?? fetch;
  const now = options.now ?? Date.now;
  const pathWithQuery = `${endpoint.pathname}${endpoint.search}`;
  const inFlight = new Map<string, { body: string; pending: Promise<"accepted" | "duplicate" | "unconfirmed"> }>();
  return Object.freeze({
    observe(input: PrivateTurnObservation, delivery?: { signal?: AbortSignal }) {
      const observation = snapshotPrivateTurnObservation(input);
      const body = JSON.stringify(observation);
      const existing = inFlight.get(observation.eventRef);
      if (existing) {
        if (existing.body !== body) {
          throw new TypeError("private turn observer identity is already bound to a different observation");
        }
        return existing.pending;
      }
      const headers = signedRequestHeaders(
        options.signingSecret,
        "POST",
        pathWithQuery,
        privateTurnObserverSignaturePayload(observation.eventRef, body),
        { "content-type": "application/json", "x-idempotency-key": observation.eventRef },
        Math.floor(now() / 1_000),
      );
      const pending: Promise<"accepted" | "duplicate" | "unconfirmed"> = (async () => {
        const response = await request(endpoint, {
          method: "POST",
          headers,
          body,
          redirect: "error",
          signal: delivery?.signal,
        });
        await response.body?.cancel().catch(() => undefined);
        if (response.status === 208 || response.status === 409) return "duplicate";
        if (response.status === 200 || response.status === 201 || response.status === 202 || response.status === 204) {
          return "accepted";
        }
        return "unconfirmed";
      })();
      inFlight.set(observation.eventRef, { body, pending });
      const release = () => {
        if (inFlight.get(observation.eventRef)?.pending === pending) inFlight.delete(observation.eventRef);
      };
      void pending.then(release, release);
      return pending;
    },
  });
}
