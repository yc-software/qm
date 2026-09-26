import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { closeSync, openSync, readFileSync, writeSync } from "node:fs";
import { createServer } from "node:http";
import type { WorkloadFixture } from "./workload.ts";

export interface SlackProfile {
  schemaVersion: 1;
  fixtureId: string;
  tokenEnv: string;
  host: "127.0.0.1";
  port: number;
  teamId: string;
  botUserId: string;
  botId: string;
  users: Array<{ id: string; principalId: string; displayName: string }>;
  conversations: Array<{
    id: string;
    kind: "channel" | "group" | "dm";
    name: string;
    members: string[];
    private?: boolean;
    external?: boolean;
  }>;
  writableConversationIds: string[];
  messages: Array<{ channel: string; ts: string; user: string; text: string; thread_ts?: string }>;
}

const hash = (s: string) => createHash("sha256").update(s).digest("hex");

export function createSlackResponder(
  profile: SlackProfile,
  fixture: WorkloadFixture,
  emit: (record: Record<string, unknown>) => void,
  env: NodeJS.ProcessEnv = process.env,
) {
  assert.equal(profile.schemaVersion, 1);
  assert.equal(profile.fixtureId, fixture.fixtureId);
  assert.match(fixture.databaseName ?? "", /^qm_perf_/);
  assert.equal(profile.host, "127.0.0.1");
  assert.ok(Number.isInteger(profile.port) && profile.port >= 0 && profile.port < 65536);
  const token = env[profile.tokenEnv];
  assert.ok(token?.startsWith("xoxb-qm-perf-"), "synthetic fixture token required");
  assert.equal(new Set(profile.users.map((u) => u.id)).size, profile.users.length);
  assert.equal(new Set(profile.users.map((u) => u.principalId)).size, profile.users.length);
  assert.equal(new Set(profile.conversations.map((c) => c.id)).size, profile.conversations.length);
  const users = new Map(
    profile.users.map((u) => [
      u.id,
      {
        id: u.id,
        team_id: profile.teamId,
        name: u.displayName,
        real_name: u.displayName,
        profile: { display_name: u.displayName, email: u.principalId },
        deleted: false,
        is_bot: false,
      },
    ]),
  );
  assert.ok(!users.has(profile.botUserId));
  for (const user of profile.users) assert.match(user.principalId, /@[^@]+\.invalid$/);
  for (const c of profile.conversations) for (const id of c.members) assert.ok(users.has(id));
  const conversations = new Map(
    profile.conversations.map((c) => [
      c.id,
      {
        id: c.id,
        name: c.name,
        is_member: true,
        is_channel: c.kind === "channel",
        is_private: c.private ?? c.kind !== "channel",
        is_ext_shared: c.external ?? false,
        is_im: c.kind === "dm",
        is_mpim: c.kind === "group",
        topic: { value: "", creator: profile.botUserId },
      },
    ]),
  );
  for (const id of profile.writableConversationIds) assert.ok(conversations.has(id));
  const messages = new Map(
    profile.conversations.map((c) => [c.id, profile.messages.filter((m) => m.channel === c.id)]),
  );
  const profileSha256 = hash(JSON.stringify(profile));
  const identity = {
    fixtureId: fixture.fixtureId,
    profileSha256: fixture.profileSha256,
    slackProfileSha256: profileSha256,
  };
  let messageMicros = Math.max(Date.now() * 1000, ...profile.messages.map((m) => Math.round(Number(m.ts) * 1_000_000)));
  let active = 0;
  let closing: Promise<void> | undefined;
  const handlers = new Set<Promise<void>>();

  function dispatch(method: string, args: Record<string, unknown>): Record<string, unknown> {
    const channel = typeof args.channel === "string" ? args.channel : "";
    const conversation = conversations.get(channel);
    const list = messages.get(channel);
    const memberIds = profile.conversations.find((c) => c.id === channel)?.members;
    const ok = (value: Record<string, unknown>) => ({ ok: true, ...value });
    const required = <T>(value: T | undefined, label: string): T => {
      assert.ok(value, label);
      return value;
    };
    const writable = () =>
      assert.ok(profile.writableConversationIds.includes(channel), "unapproved write conversation");
    if (method === "auth.test")
      return ok({
        team_id: profile.teamId,
        user_id: profile.botUserId,
        bot_id: profile.botId,
        user: "fixture-agent",
        team: "Synthetic fixture",
      });
    if (method === "users.list") return ok({ members: [...users.values()], response_metadata: { next_cursor: "" } });
    if (method === "users.info") return ok({ user: required(users.get(String(args.user)), "unknown fixture user") });
    if (method === "users.lookupByEmail")
      return ok({
        user: required(
          [...users.values()].find((u) => u.profile.email === args.email),
          "unknown fixture email",
        ),
      });
    if (method === "emoji.list") return ok({ emoji: {} });
    if (method === "conversations.list") {
      const types = String(args.types).split(",");
      const selected = profile.conversations.filter((c) => {
        if (c.kind === "group") return types.includes("mpim");
        if (c.kind === "dm") return types.includes("im");
        return types.includes(c.private ? "private_channel" : "public_channel");
      });
      return ok({ channels: selected.map((c) => conversations.get(c.id)), response_metadata: { next_cursor: "" } });
    }
    if (method === "conversations.open") {
      const requested = String(args.users).split(",").sort().join(",");
      const dm = profile.conversations.find((c) => c.kind === "dm" && [...c.members].sort().join(",") === requested);
      return ok({ channel: required(dm && conversations.get(dm.id), "unapproved fixture DM") });
    }
    required(conversation, "unknown fixture conversation");
    if (method === "conversations.info") return ok({ channel: conversation });
    if (method === "conversations.members") return ok({ members: memberIds, response_metadata: { next_cursor: "" } });
    if (method === "conversations.history" || method === "conversations.replies") {
      const inclusive = args.inclusive === true || args.inclusive === "true";
      const oldest = Number(args.oldest ?? 0);
      const latest = Number(args.latest ?? Infinity);
      let page = list!.filter((m) =>
        inclusive ? +m.ts >= oldest && +m.ts <= latest : +m.ts > oldest && +m.ts < latest,
      );
      if (method === "conversations.replies") page = page.filter((m) => m.ts === args.ts || m.thread_ts === args.ts);
      page.sort((a, b) => (method === "conversations.replies" ? +a.ts - +b.ts : +b.ts - +a.ts));
      return ok({
        messages: page.slice(0, Math.max(1, Math.min(1000, Number(args.limit ?? 100)))),
        has_more: false,
        response_metadata: { next_cursor: "" },
      });
    }
    writable();
    if (method === "conversations.setTopic") {
      conversation!.topic = { value: String(args.topic), creator: profile.botUserId };
      return ok({ channel: conversation });
    }
    if (method === "chat.postMessage") {
      const ts = (++messageMicros / 1_000_000).toFixed(6);
      const message = {
        channel,
        ts,
        user: profile.botUserId,
        text: String(args.text ?? ""),
        ...(args.thread_ts ? { thread_ts: String(args.thread_ts) } : {}),
      };
      list!.push(message);
      return ok({ channel, ts, message });
    }
    const target = list!.find((m) => m.ts === (args.ts ?? args.timestamp));
    if (method === "chat.update") {
      required(target, "unknown fixture message");
      assert.equal(target!.user, profile.botUserId);
      target!.text = String(args.text ?? "");
      return ok({ channel, ts: target!.ts, text: target!.text });
    }
    if (method === "chat.delete") {
      required(target, "unknown fixture message");
      assert.equal(target!.user, profile.botUserId);
      list!.splice(list!.indexOf(target!), 1);
      return ok({ channel, ts: target!.ts });
    }
    if (method === "reactions.add" || method === "reactions.remove") {
      required(target, "unknown fixture reaction message");
      return ok({});
    }
    if (method === "reactions.get")
      return ok({
        type: "message",
        message: { ...required(target, "unknown fixture reaction message"), reactions: [] },
      });
    throw new Error("unsupported Slack method");
  }

  const server = createServer((req, res) => {
    const handler = (async () => {
      const startedAt = Date.now();
      const method = (req.url ?? "").replace(/^\/api\//, "");
      let requestBytes = 0;
      let requestSha256: string | undefined;
      let responseBytes = 0;
      let error: string | null = null;
      let args: Record<string, unknown> = {};
      active++;
      const reply = (status: number, body: unknown) => {
        const bytes = JSON.stringify(body);
        responseBytes = Buffer.byteLength(bytes);
        res.writeHead(status, { "content-type": "application/json" });
        res.end(bytes);
      };
      try {
        if (req.method === "GET" && req.url === "/__qm_perf/identity")
          return reply(200, { ...identity, qualified: false });
        assert.equal(req.method, "POST");
        assert.ok(req.url?.startsWith("/api/"));
        assert.equal(req.headers.authorization, `Bearer ${token}`, "synthetic fixture authorization required");
        const chunks: Buffer[] = [];
        for await (const chunk of req) {
          requestBytes += chunk.length;
          assert.ok(requestBytes <= 1_000_000, "Slack request too large");
          chunks.push(chunk);
        }
        const raw = Buffer.concat(chunks).toString("utf8");
        requestSha256 = hash(raw);
        const parsed: unknown = req.headers["content-type"]?.includes("application/json")
          ? JSON.parse(raw)
          : Object.fromEntries(new URLSearchParams(raw));
        assert.ok(parsed && typeof parsed === "object" && !Array.isArray(parsed), "Slack object body required");
        args = parsed as Record<string, unknown>;
        reply(200, dispatch(method, args));
      } catch (e) {
        error = e instanceof Error ? e.message.split("\n")[0]! : String(e);
        reply(400, { ok: false, error: "fixture_rejected" });
      } finally {
        active--;
        emit({
          schemaVersion: 1,
          type: "slack-network-call",
          qualified: false,
          ...identity,
          method,
          startedAt,
          finishedAt: Date.now(),
          requestBytes,
          requestSha256,
          responseBytes,
          channel: args.channel,
          textSha256: typeof args.text === "string" ? hash(args.text) : undefined,
          textBytes: typeof args.text === "string" ? Buffer.byteLength(args.text) : undefined,
          error,
          active,
        });
      }
    })();
    handlers.add(handler);
    void handler.finally(() => handlers.delete(handler));
  });
  const close = () =>
    (closing ??= (async () => {
      await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
      await Promise.all(handlers);
    })());
  return { server, close, identity, messages };
}

if (import.meta.main) {
  const [profilePath, fixturePath, outputPath] = process.argv.slice(2);
  assert.ok(
    profilePath && fixturePath && outputPath,
    "usage: workload-slack.ts profile.json fixture.json evidence.jsonl",
  );
  const profile = JSON.parse(readFileSync(profilePath, "utf8")) as SlackProfile;
  const fixture = JSON.parse(readFileSync(fixturePath, "utf8")) as WorkloadFixture;
  const fd = openSync(outputPath, "ax", 0o600);
  const responder = createSlackResponder(profile, fixture, (record) => writeSync(fd, `${JSON.stringify(record)}\n`));
  responder.server.listen(profile.port, profile.host, () =>
    console.log(JSON.stringify({ ready: true, ...responder.identity, qualified: false })),
  );
  let stopping = false;
  const stop = () => {
    if (stopping) return;
    stopping = true;
    void responder
      .close()
      .finally(() => closeSync(fd))
      .catch((error: unknown) => {
        console.error(error);
        process.exitCode = 1;
      });
  };
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);
}
