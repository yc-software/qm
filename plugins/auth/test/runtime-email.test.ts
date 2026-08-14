import assert from "node:assert/strict";
import test from "node:test";
import type { AuthEmailSettings } from "../../chassis/src/auth-email.ts";
import { readConfig } from "../src/config.ts";
import type { Mailer, OutgoingEmail } from "../src/email.ts";
import { AuthEmailRuntime, redactAuthEmailError } from "../src/runtime-email.ts";
import { testEnv } from "./helpers.ts";

const managed = (version: string, domain = "example.com") => ({
  managed: true,
  active: true,
  version,
  settings: {
    transport: "resend" as const,
    from: "QM <no-reply@example.com>",
    access: { mode: "domain" as const, domain },
    resend: { apiKey: `key-${version}` },
  },
});

function runtime(input: {
  responses: Array<Response | Error>;
  env?: Record<string, string | undefined>;
  events?: string[];
}) {
  const events = input.events ?? [];
  const responses = [...input.responses];
  const mailers = new Map<string, Mailer>();
  const mailerFactory = (settings: AuthEmailSettings): Mailer => {
    const identity = settings.transport === "smtp" ? settings.smtp.host : settings.resend.apiKey;
    const mailer = {
      async verify() {
        events.push(`verify:${identity}`);
        return "accepted";
      },
      async send(message: OutgoingEmail) {
        events.push(`send:${identity}:${message.to}`);
        return "message-id";
      },
    };
    mailers.set(identity, mailer);
    return mailer;
  };
  return new AuthEmailRuntime({
    cfg: readConfig(testEnv(input.env ?? {})),
    production: true,
    coreApiUrl: "http://core.test",
    signingSecret: "core-signing-secret",
    fetchImpl: async () => {
      const next = responses.shift();
      if (next instanceof Error) throw next;
      return next ?? new Response("unavailable", { status: 503 });
    },
    mailerFactory,
  });
}

test("missing email credentials start unconfigured while managed settings hot-switch by version", async () => {
  const email = runtime({
    env: {
      AUTH_ALLOWED_EMAILS: undefined,
      AUTH_ALLOWED_EMAIL_DOMAIN: undefined,
      AUTH_EMAIL_FROM: undefined,
      RESEND_API_KEY: undefined,
    },
    responses: [
      Response.json({ managed: false, active: false }),
      Response.json(managed("v1")),
      Response.json(managed("v2", "new.example.com")),
    ],
  });

  await email.refresh();
  assert.deepEqual(email.status(), { state: "unconfigured", source: "absent" });
  await email.refresh();
  assert.equal(email.current()?.version, "v1");
  assert.equal(email.status().state, "ready");
  await email.refresh();
  assert.equal(email.current()?.version, "v2");
  assert.deepEqual(email.current()?.settings.access, { mode: "domain", domain: "new.example.com" });
});

test("a Core outage preserves the last valid version and reports degraded state", async () => {
  const email = runtime({ responses: [Response.json(managed("v1")), new Error("network down")] });
  await email.refresh();
  await email.refresh();

  assert.equal(email.current()?.version, "v1");
  assert.equal(email.status().state, "degraded");
  assert.match(email.status().message ?? "", /network down/);
});

test("overlapping refresh requests share one in-flight fetch and cannot complete out of order", async () => {
  let release!: (response: Response) => void;
  let calls = 0;
  const firstResponse = new Promise<Response>((resolve) => (release = resolve));
  const email = new AuthEmailRuntime({
    cfg: readConfig(testEnv({})),
    production: true,
    coreApiUrl: "http://core.test",
    signingSecret: "core-signing-secret",
    fetchImpl: async () => {
      calls += 1;
      return calls === 1 ? firstResponse : Response.json(managed("v2"));
    },
    mailerFactory: () => ({
      async verify() {
        return "accepted";
      },
      async send() {
        return "message-id";
      },
    }),
  });

  const first = email.refresh();
  const overlapping = email.refresh();
  assert.equal(calls, 1);
  release(Response.json(managed("v1")));
  await Promise.all([first, overlapping]);
  assert.equal(email.current()?.version, "v1");
  await email.refresh();
  assert.equal(calls, 2);
  assert.equal(email.current()?.version, "v2");
});

test("candidate validation checks credentials and delivers to the allowed administrator without activating it", async () => {
  const events: string[] = [];
  const email = runtime({ responses: [Response.json(managed("active"))], events });
  await email.refresh();
  const candidate = managed("candidate").settings;

  await email.validate(candidate, "admin@example.com");
  assert.deepEqual(events.slice(-2), ["verify:key-candidate", "send:key-candidate:admin@example.com"]);
  assert.equal(email.current()?.version, "active");
  await assert.rejects(() => email.validate(candidate, "admin@elsewhere.test"), /must remain allowed/);
});

test("deployment fallback is tested through the same verification and delivery path", async () => {
  const events: string[] = [];
  const email = runtime({ responses: [], events });
  await email.validateEnvironment("admin@example.com");
  assert.deepEqual(events.slice(-2), ["verify:re_test_key", "send:re_test_key:admin@example.com"]);
});

test("email failures redact credentials before they reach status, responses, or logs", () => {
  const settings = managed("sensitive").settings;
  const message = redactAuthEmailError(new Error(`request failed with ${settings.resend.apiKey}`), settings);
  assert.equal(message, "request failed with [redacted]");
  assert.doesNotMatch(message, /key-sensitive/);
});
