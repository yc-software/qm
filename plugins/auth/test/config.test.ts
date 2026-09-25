import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { bootProblems, readConfig, senderAddress } from "../src/config.ts";
import { testEnv } from "./helpers.ts";

const problemsFor = (over: Record<string, string | undefined>, isProd = true): string =>
  bootProblems(readConfig(testEnv(over)), isProd).join(" | ");

test("a complete broker configuration boots", () => {
  const signing = { CORE_SIGNING_SECRET: "a".repeat(48) };
  assert.deepEqual(bootProblems(readConfig(testEnv(signing)), true), []);
  assert.deepEqual(
    bootProblems(
      readConfig(testEnv({ ...signing, AUTH_ALLOWED_EMAILS: undefined, AUTH_ALLOWED_EMAIL_DOMAIN: "example.com" })),
      true,
    ),
    [],
  );
});

test("the broker boots without email delivery while keeping its authentication requirements", () => {
  for (const transport of ["resend", "smtp"]) {
    const withoutEmail = {
      AUTH_EMAIL_TRANSPORT: transport,
      AUTH_EMAIL_FROM: undefined,
      RESEND_API_KEY: undefined,
      SMTP_HOST: undefined,
      SMTP_USERNAME: undefined,
      SMTP_PASSWORD: undefined,
      CORE_SIGNING_SECRET: "a".repeat(48),
    };
    assert.equal(problemsFor(withoutEmail), "");
    assert.match(
      problemsFor({ ...withoutEmail, AUTH_ALLOWED_EMAILS: undefined }),
      /AUTH_ALLOWED_EMAILS or AUTH_ALLOWED_EMAIL_DOMAIN is required/,
    );
    assert.match(problemsFor({ ...withoutEmail, AUTH_TOKEN_SECRET: undefined }), /AUTH_TOKEN_SECRET is required/);
  }
});

test("production refuses to start without a trust boundary", () => {
  const problems = problemsFor({ AUTH_ALLOWED_EMAILS: undefined, AUTH_ALLOWED_EMAIL_DOMAIN: undefined });
  assert.match(problems, /AUTH_ALLOWED_EMAILS or AUTH_ALLOWED_EMAIL_DOMAIN is required/);
});

test("production refuses missing or placeholder credentials and keys", () => {
  for (const [name, pattern] of [
    ["AUTH_CLIENT_ID", /AUTH_CLIENT_ID is required/],
    ["AUTH_CLIENT_SECRET", /AUTH_CLIENT_SECRET is required/],
    ["AUTH_TOKEN_SECRET", /AUTH_TOKEN_SECRET is required/],
    ["AUTH_SIGNING_JWK", /AUTH_SIGNING_JWK is required/],
  ] as const) {
    for (const value of [undefined, "", "  ", "replace-me", "TODO"]) {
      assert.match(problemsFor({ [name]: value }), pattern, `${name}=${JSON.stringify(value)}`);
    }
  }
});

test("production refuses cleartext endpoints and cleartext SMTP", () => {
  assert.match(problemsFor({ AUTH_ISSUER: "http://agent.example.test/idp" }), /AUTH_ISSUER must be https/);
  assert.match(
    problemsFor({ AUTH_REDIRECT_URI: "http://agent.example.test/auth/callback" }),
    /AUTH_REDIRECT_URI must be https/,
  );
  assert.match(
    problemsFor({
      AUTH_EMAIL_TRANSPORT: "smtp",
      SMTP_HOST: "mail.example.com",
      SMTP_USERNAME: "u",
      SMTP_PASSWORD: "p",
      SMTP_TLS: "none",
    }),
    /SMTP_TLS=none may not be used in production/,
  );
  assert.equal(bootProblems(readConfig(testEnv({ AUTH_ISSUER: "http://localhost:8099" })), false).join(" | "), "");
});

test("production requires the core signing secret that makes links single-use", () => {
  assert.match(problemsFor({}), /CORE_SIGNING_SECRET is required/);
  assert.equal(problemsFor({ CORE_SIGNING_SECRET: "a".repeat(48) }), "");
});

test("a weak or reused token secret is refused", () => {
  assert.match(problemsFor({ AUTH_TOKEN_SECRET: "short" }), /AUTH_TOKEN_SECRET must be at least 32 characters/);
  assert.match(problemsFor({ AUTH_CLIENT_SECRET: "short" }), /AUTH_CLIENT_SECRET must be at least 32 characters/);
  const shared = "0123456789abcdef0123456789abcdef";
  assert.match(
    problemsFor({ AUTH_TOKEN_SECRET: shared, AUTH_CLIENT_SECRET: shared }),
    /must differ from AUTH_TOKEN_SECRET/,
  );
});

test("missing any email credential disables delivery without preventing startup", () => {
  const settings = {
    SMTP_HOST: "smtp.example.com",
    SMTP_USERNAME: "u",
    SMTP_PASSWORD: "p",
    CORE_SIGNING_SECRET: "a".repeat(48),
  };
  for (const transport of ["resend", "smtp"]) {
    const complete = { ...settings, AUTH_EMAIL_TRANSPORT: transport };
    assert.equal(problemsFor(complete), "");
    const credentials = transport === "resend" ? ["RESEND_API_KEY"] : ["SMTP_HOST", "SMTP_USERNAME", "SMTP_PASSWORD"];
    for (const name of ["AUTH_EMAIL_FROM", ...credentials]) {
      for (const value of [undefined, "", "  "]) {
        assert.equal(problemsFor({ ...complete, [name]: value }), "", `${transport}: ${name}=${JSON.stringify(value)}`);
      }
    }
  }
});

test("malformed allowlists and senders are refused", () => {
  assert.match(problemsFor({ AUTH_ALLOWED_EMAILS: "not-an-email" }), /valid, non-placeholder email addresses/);
  assert.match(
    problemsFor({ AUTH_ALLOWED_EMAILS: undefined, AUTH_ALLOWED_EMAIL_DOMAIN: "nodot" }),
    /valid, non-placeholder email domain/,
  );
  assert.match(problemsFor({ AUTH_EMAIL_FROM: "qm <not-an-address>" }), /verified sender address/);
  assert.match(problemsFor({ AUTH_EMAIL_FROM: "replace-me" }), /verified sender address/);
  assert.match(problemsFor({ RESEND_API_KEY: "replace-me" }), /RESEND_API_KEY is required/);
});

test("oversized token lifetimes are refused", () => {
  assert.match(problemsFor({ AUTH_LINK_TTL_S: "7200" }), /AUTH_LINK_TTL_S must be at most 3600/);
  assert.match(problemsFor({ AUTH_CODE_TTL_S: "1200" }), /AUTH_CODE_TTL_S must be at most 600/);
  assert.match(problemsFor({ AUTH_ACCESS_TTL_S: "1200" }), /AUTH_ACCESS_TTL_S must be at most 600/);
  assert.match(problemsFor({ AUTH_REQUEST_TTL_S: "7200" }), /AUTH_REQUEST_TTL_S must be at most 3600/);
});

test("a rate limit that core could not honour is refused at boot rather than silently suppressing every sign-in", () => {
  assert.match(
    problemsFor({ AUTH_SEND_LIMIT_PER_EMAIL: "500" }),
    /AUTH_SEND_LIMIT_PER_EMAIL must be a whole number between 1 and 64/,
  );
  assert.match(
    problemsFor({ AUTH_SEND_LIMIT_PER_IP: "1000000000" }),
    /AUTH_SEND_LIMIT_PER_IP must be a whole number between 1 and 64/,
  );
  assert.match(problemsFor({ AUTH_SEND_WINDOW_S: "86400" }), /AUTH_SEND_WINDOW_S must be at most 3600/);
  assert.equal(problemsFor({ AUTH_SEND_LIMIT_PER_IP: "64", CORE_SIGNING_SECRET: "a".repeat(48) }), "");
});

test("senderAddress unwraps a display name", () => {
  assert.equal(senderAddress("qm <no-reply@example.com>"), "no-reply@example.com");
  assert.equal(senderAddress(" no-reply@example.com "), "no-reply@example.com");
});

test("the issuer path drives the public form action", () => {
  assert.equal(readConfig(testEnv()).publicPath, "/idp");
  assert.equal(readConfig(testEnv({ AUTH_ISSUER: "https://agent.example.test" })).publicPath, "");
});

test("`node src/index.ts` refuses to boot on a placeholder configuration and serves /healthz once fixed", async () => {
  const base = {
    ...process.env,
    ...testEnv({ CORE_SIGNING_SECRET: "a".repeat(48) }),
    NODE_ENV: "production",
  } as NodeJS.ProcessEnv;
  const refuses = spawnSync(
    process.execPath,
    ["--input-type=module", "-e", "import('./src/index.ts').then(m => m.bootChecks())"],
    {
      cwd: process.cwd(),
      env: { ...base, AUTH_CLIENT_SECRET: "replace-me" },
      encoding: "utf8",
    },
  );
  assert.notEqual(refuses.status, 0);
  assert.match(refuses.stderr, /AUTH_CLIENT_SECRET is required/);

  const PORT = "18299";
  for (const email of [{}, { AUTH_EMAIL_FROM: undefined, RESEND_API_KEY: undefined }, { RESEND_API_KEY: undefined }]) {
    const child = spawnSync(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `import('./src/index.ts').then(async (m) => { await m.startServer(); const r = await fetch('http://127.0.0.1:${PORT}/healthz'); console.log(r.status); process.exit(0); })`,
      ],
      { cwd: process.cwd(), env: { ...base, ...email, PORT }, encoding: "utf8" },
    );
    assert.equal(child.status, 0, child.stderr);
    assert.match(child.stdout, /200/);
    assert.match(child.stdout, /sign-in broker on/);
    if ("RESEND_API_KEY" in email) assert.match(child.stdout, /email not configured/);
  }
});
