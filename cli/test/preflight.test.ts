import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server, type Socket } from "node:net";
import type { QmConfig } from "../src/config.ts";
import { CliError } from "../src/log.ts";
import {
  emailTransportConfigured,
  emailTransportPreflight,
  flySandboxTokenPreflight,
  nodeEngineProblem,
  smtpVerify,
  SmtpRejectedError,
} from "../src/preflight.ts";

const CONFIG: QmConfig = {
  contract: 1,
  orgId: "acme",
  publicUrl: "http://localhost:8080",
  target: "docker",
  services: ["core", "auth"],
  plugins: [],
  skills: [],
  env: {},
  imageOverrides: {},
  sandbox: { app: "acme-sandboxes" },
};

async function quietAsync(fn: () => Promise<void>): Promise<string[]> {
  const lines: string[] = [];
  const log = console.log,
    warnFn = console.warn;
  console.log = (...args: unknown[]): void => void lines.push(args.join(" "));
  console.warn = (...args: unknown[]): void => void lines.push(args.join(" "));
  try {
    await fn();
    return lines;
  } finally {
    console.log = log;
    console.warn = warnFn;
  }
}

test("nodeEngineProblem accepts a satisfying version and rejects an older one", () => {
  assert.equal(nodeEngineProblem(">=24.15.0", "package.json", "v24.15.0"), undefined);
  assert.equal(nodeEngineProblem(">=24.0.0", "package.json", "v24.13.0"), undefined);
  const problem = nodeEngineProblem(">=24.15.0", "the repo package.json", "v24.13.0");
  assert.ok(problem?.includes("v24.13.0"));
  assert.ok(problem?.includes(">=24.15.0"));
  assert.ok(problem?.includes("the repo package.json"));
});

test("fly sandbox preflight fails with the exact fix when the token cannot reach the app", async () => {
  const secrets = new Map([["FLY_SANDBOX_API_TOKEN", "fm2_dead"]]);
  const fetchImpl = (async () => new Response("not found", { status: 404 })) as typeof fetch;
  await assert.rejects(
    () => flySandboxTokenPreflight({ ...CONFIG, flyOrg: "personal" }, secrets, fetchImpl),
    (e: unknown) => {
      assert.ok(e instanceof CliError);
      assert.ok(e.message.includes("fly apps create acme-sandboxes --org personal"));
      assert.ok(e.message.includes("fly tokens create deploy -a acme-sandboxes"));
      return true;
    },
  );
});

test("fly sandbox preflight passes a live token and skips when no token is present", async () => {
  const fetchImpl = (async () => new Response("{}", { status: 200 })) as typeof fetch;
  const lines = await quietAsync(() =>
    flySandboxTokenPreflight(CONFIG, new Map([["FLY_SANDBOX_API_TOKEN", "fm2_ok"]]), fetchImpl),
  );
  assert.ok(lines.some((line) => line.includes("FLY_SANDBOX_API_TOKEN ok")));
  const skipped = await quietAsync(() =>
    flySandboxTokenPreflight(CONFIG, new Map(), (async () => {
      throw new Error("must not be called");
    }) as typeof fetch),
  );
  assert.deepEqual(skipped, []);
});

test("fly sandbox preflight warns instead of failing when the Fly API is unreachable", async () => {
  const fetchImpl = (async () => {
    throw new Error("network is down");
  }) as typeof fetch;
  const lines = await quietAsync(() =>
    flySandboxTokenPreflight(CONFIG, new Map([["FLY_SANDBOX_API_TOKEN", "fm2_x"]]), fetchImpl),
  );
  assert.ok(lines.some((line) => line.includes("could not verify FLY_SANDBOX_API_TOKEN")));
});

interface FakeSmtp {
  server: Server;
  port: number;
  close: () => Promise<void>;
}

function fakeSmtp(password: string): Promise<FakeSmtp> {
  const server = createServer((socket: Socket) => {
    socket.write("220 fake ESMTP\r\n");
    let buffer = "";
    socket.on("data", (chunk: Buffer) => {
      buffer += chunk.toString("utf8");
      let index: number;
      while ((index = buffer.indexOf("\r\n")) !== -1) {
        const line = buffer.slice(0, index);
        buffer = buffer.slice(index + 2);
        if (line.startsWith("EHLO")) socket.write("250-fake\r\n250 AUTH PLAIN LOGIN\r\n");
        else if (line.startsWith("AUTH PLAIN")) {
          const decoded = Buffer.from(line.slice("AUTH PLAIN ".length), "base64").toString("utf8");
          socket.write(decoded === `\0user\0${password}` ? "235 ok\r\n" : "535 auth failed\r\n");
        } else if (line === "QUIT") {
          socket.write("221 bye\r\n");
          socket.end();
        } else socket.write("502 what\r\n");
      }
    });
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      resolve({
        server,
        port: typeof address === "object" && address ? address.port : 0,
        close: () => new Promise((done) => server.close(() => done())),
      });
    });
  });
}

test("smtpVerify authenticates without sending mail and rejects bad credentials", async () => {
  const smtp = await fakeSmtp("right");
  try {
    await smtpVerify({ host: "127.0.0.1", port: smtp.port, username: "user", password: "right", tls: "none" });
    await assert.rejects(
      () => smtpVerify({ host: "127.0.0.1", port: smtp.port, username: "user", password: "wrong", tls: "none" }),
      SmtpRejectedError,
    );
  } finally {
    await smtp.close();
  }
});

test("email preflight fails check on rejected SMTP credentials and warns on stray transport vars", async () => {
  const smtp = await fakeSmtp("right");
  const config = {
    ...CONFIG,
    env: { auth: { AUTH_EMAIL_TRANSPORT: "smtp", SMTP_PORT: String(smtp.port), SMTP_TLS: "none" } },
  };
  try {
    const okLines = await quietAsync(() =>
      emailTransportPreflight(
        config,
        new Map([
          ["AUTH_EMAIL_FROM", "QM <noreply@example.com>"],
          ["SMTP_HOST", "127.0.0.1"],
          ["SMTP_USERNAME", "user"],
          ["SMTP_PASSWORD", "right"],
          ["RESEND_API_KEY", "re_unused"],
        ]),
      ),
    );
    assert.ok(okLines.some((line) => line.includes("credentials accepted")));
    assert.ok(
      okLines.some((line) => line.includes("RESEND_API_KEY is set but") && line.includes("external-user invitations")),
      "a Resend key beside an SMTP broker is core's invitation sender, not a stray value",
    );
    await assert.rejects(
      () =>
        emailTransportPreflight(
          config,
          new Map([
            ["AUTH_EMAIL_FROM", "QM <noreply@example.com>"],
            ["SMTP_HOST", "127.0.0.1"],
            ["SMTP_USERNAME", "user"],
            ["SMTP_PASSWORD", "wrong"],
          ]),
        ),
      (e: unknown) => {
        assert.ok(e instanceof CliError);
        assert.ok(e.message.includes("sign-in links cannot be sent"));
        return true;
      },
    );
  } finally {
    await smtp.close();
  }
});

test("email preflight warns when SMTP values are set but the transport is resend", async () => {
  const config = { ...CONFIG, env: { auth: { AUTH_EMAIL_TRANSPORT: "resend" } } };
  const lines = await quietAsync(() =>
    emailTransportPreflight(
      config,
      new Map([
        ["SMTP_HOST", "smtp.example.com"],
        ["SMTP_PASSWORD", "hunter2"],
      ]),
    ),
  );
  assert.ok(lines.some((line) => line.includes('set but env.auth.AUTH_EMAIL_TRANSPORT is "resend"')));
});

test("email preflight does nothing without the auth service", async () => {
  const lines = await quietAsync(() =>
    emailTransportPreflight({ ...CONFIG, services: ["core"] }, new Map([["RESEND_API_KEY", "re_x"]])),
  );
  assert.deepEqual(lines, []);
});

test("missing email credentials disable email without failing deployment checks", async () => {
  for (const transport of ["resend", "smtp"]) {
    const config = { ...CONFIG, env: { auth: { AUTH_EMAIL_TRANSPORT: transport } } };
    assert.equal(emailTransportConfigured(config, new Map()), false);
    await assert.doesNotReject(emailTransportPreflight(config, new Map()));
    for (const values of [
      new Map([["AUTH_EMAIL_FROM", "noreply@example.com"]]),
      new Map([[transport === "resend" ? "RESEND_API_KEY" : "SMTP_HOST", "configured"]]),
    ]) {
      assert.equal(emailTransportConfigured(config, values), false);
      const output = await quietAsync(() => emailTransportPreflight(config, values));
      assert.ok(output.some((line) => line.includes("sign-in email: disabled")));
    }
  }
});

test("email preflight resolves delivered secret aliases and settings supplied directly in config", async () => {
  const aliased = {
    ...CONFIG,
    env: { auth: { AUTH_EMAIL_TRANSPORT: "resend" } },
    secretEnv: { auth: { AUTH_EMAIL_FROM: "AUTH_SENDER", RESEND_API_KEY: "MAIL_KEY" } },
  };
  const secrets = new Map([
    ["AUTH_SENDER", "noreply@example.com"],
    ["MAIL_KEY", "re_configured"],
  ]);
  assert.equal(emailTransportConfigured(aliased, secrets), true);
  await assert.doesNotReject(emailTransportPreflight(aliased, secrets));
  assert.equal(emailTransportConfigured(aliased, new Map([["MAIL_KEY", "re_configured"]])), false);
  const direct = {
    ...CONFIG,
    env: { auth: { AUTH_EMAIL_TRANSPORT: "resend", AUTH_EMAIL_FROM: "noreply@example.com" } },
  };
  assert.equal(emailTransportConfigured(direct, new Map([["RESEND_API_KEY", "re_configured"]])), true);
  await assert.doesNotReject(emailTransportPreflight(direct, new Map([["RESEND_API_KEY", "re_configured"]])));
});
