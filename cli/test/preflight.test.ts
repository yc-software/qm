import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server, type Socket } from "node:net";
import { doctorCommon } from "../src/backends/doctor.ts";
import type { QmConfig } from "../src/config.ts";
import { CliError } from "../src/log.ts";
import {
  emailSignInState,
  emailTransportPreflight,
  flySandboxTokenPreflight,
  nodeEngineProblem,
  smtpVerify,
  SmtpRejectedError,
} from "../src/preflight.ts";
import type { SecretValues } from "../src/secrets.ts";

const complete = (values: ReadonlyMap<string, string>): SecretValues => ({ values, source: "complete" });

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
        complete(
          new Map([
            ["AUTH_EMAIL_FROM", "QM <noreply@example.com>"],
            ["SMTP_HOST", "127.0.0.1"],
            ["SMTP_USERNAME", "user"],
            ["SMTP_PASSWORD", "right"],
            ["RESEND_API_KEY", "re_unused"],
          ]),
        ),
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
          complete(
            new Map([
              ["AUTH_EMAIL_FROM", "QM <noreply@example.com>"],
              ["SMTP_HOST", "127.0.0.1"],
              ["SMTP_USERNAME", "user"],
              ["SMTP_PASSWORD", "wrong"],
            ]),
          ),
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

test("email preflight warns instead of failing when a STARTTLS relay does not offer STARTTLS", async () => {
  const smtp = await fakeSmtp("right");
  const config = {
    ...CONFIG,
    env: { auth: { AUTH_EMAIL_TRANSPORT: "smtp", SMTP_PORT: String(smtp.port), SMTP_TLS: "starttls" } },
  };
  try {
    const lines = await quietAsync(() =>
      emailTransportPreflight(
        config,
        complete(
          new Map([
            ["AUTH_EMAIL_FROM", "QM <noreply@example.com>"],
            ["SMTP_HOST", "127.0.0.1"],
            ["SMTP_USERNAME", "user"],
            ["SMTP_PASSWORD", "right"],
          ]),
        ),
      ),
    );
    assert.ok(lines.some((line) => line.includes("could not verify the SMTP credentials")));
    assert.ok(!lines.some((line) => line.includes("credentials accepted")));
  } finally {
    await smtp.close();
  }
});

test("doctor reports an SMTP relay reachable when it answers and unreachable when it does not", async () => {
  const smtp = await fakeSmtp("right");
  const relay = (port: number): QmConfig => ({
    ...CONFIG,
    env: { auth: { AUTH_EMAIL_TRANSPORT: "smtp", SMTP_PORT: String(port) } },
  });
  const secrets = new Map([
    ["SMTP_HOST", "127.0.0.1"],
    ["SMTP_USERNAME", "user"],
    ["SMTP_PASSWORD", "right"],
    ["AUTH_EMAIL_FROM", "noreply@example.com"],
  ]);
  try {
    const lines = await quietAsync(() => doctorCommon(relay(smtp.port), complete(secrets)));
    assert.ok(lines.some((line) => line.includes(`SMTP relay 127.0.0.1:${smtp.port}: reachable`)));
  } finally {
    await smtp.close();
  }
  await assert.rejects(
    quietAsync(() => doctorCommon(relay(smtp.port), complete(secrets))),
    (e: unknown) => e instanceof CliError && e.message.includes("is unreachable"),
  );
});

test("email preflight warns when SMTP values are set but the transport is resend", async () => {
  const config = { ...CONFIG, env: { auth: { AUTH_EMAIL_TRANSPORT: "resend" } } };
  const lines = await quietAsync(() =>
    emailTransportPreflight(
      config,
      complete(
        new Map([
          ["SMTP_HOST", "smtp.example.com"],
          ["SMTP_PASSWORD", "hunter2"],
        ]),
      ),
    ),
  );
  assert.ok(lines.some((line) => line.includes('set but env.auth.AUTH_EMAIL_TRANSPORT is "resend"')));
});

test("email preflight does nothing without the auth service", async () => {
  const lines = await quietAsync(() =>
    emailTransportPreflight({ ...CONFIG, services: ["core"] }, complete(new Map([["RESEND_API_KEY", "re_x"]]))),
  );
  assert.deepEqual(lines, []);
});

test("email sign-in state reports only what its values source can vouch for", async () => {
  for (const transport of ["resend", "smtp"]) {
    const config = { ...CONFIG, env: { auth: { AUTH_EMAIL_TRANSPORT: transport } } };
    const key = transport === "resend" ? "RESEND_API_KEY" : "SMTP_HOST";
    const partials = [new Map([["AUTH_EMAIL_FROM", "noreply@example.com"]]), new Map([[key, "configured"]])];
    for (const values of [new Map<string, string>(), ...partials]) {
      assert.equal(emailSignInState(config, complete(values)), "disabled");
      await assert.doesNotReject(emailTransportPreflight(config, complete(values)));
      const output = await quietAsync(() => emailTransportPreflight(config, complete(values)));
      assert.ok(output.some((line) => line.includes("sign-in email: disabled")));
      for (const source of ["partial"] as const) {
        assert.equal(emailSignInState(config, { values: values, source: source }), "uninspected");
        const unread = await quietAsync(() => emailTransportPreflight(config, { values: values, source: source }));
        assert.ok(!unread.some((line) => line.includes("sign-in email: disabled")));
        assert.ok(unread.some((line) => line.includes("sign-in email: not inspected")));
      }
    }
    for (const values of [new Map([[key, ""]]), new Map([["AUTH_EMAIL_FROM", " "]])]) {
      assert.equal(emailSignInState(config, complete(values)), "disabled");
      assert.equal(emailSignInState(config, { values: values, source: "partial" }), "uninspected");
    }
  }
});

test("email preflight rejects conflicting aliases and resolves settings supplied directly in config", async () => {
  const aliased = {
    ...CONFIG,
    env: { auth: { AUTH_EMAIL_TRANSPORT: "resend" } },
    secretEnv: {
      auth: { AUTH_EMAIL_FROM: "AUTH_SENDER", RESEND_API_KEY: "MAIL_KEY" },
    },
  };
  const secrets = new Map([
    ["AUTH_SENDER", "noreply@example.com"],
    ["MAIL_KEY", "re_configured"],
  ]);
  assert.throws(() => emailSignInState(aliased, complete(secrets)), /would receive env AUTH_EMAIL_FROM from both/);
  await assert.rejects(
    emailTransportPreflight(aliased, complete(secrets)),
    /would receive env AUTH_EMAIL_FROM from both/,
  );
  const direct = {
    ...CONFIG,
    env: { auth: { AUTH_EMAIL_TRANSPORT: "resend", AUTH_EMAIL_FROM: "noreply@example.com" } },
  };
  for (const source of ["complete", "partial"] as const)
    assert.equal(
      emailSignInState(direct, { values: new Map([["RESEND_API_KEY", "re_configured"]]), source: source }),
      "enabled",
    );
  await assert.doesNotReject(emailTransportPreflight(direct, complete(new Map([["RESEND_API_KEY", "re_configured"]]))));
});
