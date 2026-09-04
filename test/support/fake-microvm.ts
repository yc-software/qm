import type {
  AwsMicrovmApi,
  MicrovmDescription,
  MicrovmImageSummary,
  MicrovmLifecycleState,
} from "../../src/sandbox/aws-microvm-api.ts";
import { AwsApiError } from "../../src/sandbox/aws-microvm-api.ts";

interface FakeBody {
  id: string;
  endpoint: string;
  state: MicrovmLifecycleState;
  createdAtMs: number;
  fs: Map<string, Uint8Array>;
}

const enc = (s: string) => Buffer.from(s, "utf8");

export interface FakeMicrovm {
  api: AwsMicrovmApi;
  s3: { send(cmd: unknown): Promise<unknown> };
  fetchImpl: typeof fetch;
  bodies: Map<string, FakeBody>;
  s3store: Map<string, Uint8Array>;
  commands: string[];
  runCount: number;
  killBody(id: string): void;
}

export function installFakeMicrovm(): FakeMicrovm {
  const bodies = new Map<string, FakeBody>();
  const s3store = new Map<string, Uint8Array>();
  let n = 0;
  const self = { runCount: 0 } as FakeMicrovm;

  const byEndpoint = (endpoint: string): FakeBody | undefined =>
    [...bodies.values()].find((b) => b.endpoint === endpoint);

  const api: AwsMicrovmApi = {
    async listImages(): Promise<MicrovmImageSummary[]> {
      return [];
    },
    async findImage(name) {
      return {
        name,
        imageArn: `arn:aws:lambda:us-west-2:0:microvm-image:${name}`,
        state: "CREATED",
        latestActiveImageVersion: "1.0",
      };
    },
    async createImage({ name }): Promise<MicrovmImageSummary> {
      return { name, imageArn: `arn:fake:${name}`, state: "CREATED", latestActiveImageVersion: "1.0" };
    },
    async updateImage({ imageIdentifier }): Promise<MicrovmImageSummary> {
      return { name: imageIdentifier, imageArn: imageIdentifier, state: "UPDATED", latestActiveImageVersion: "1.0" };
    },
    async runMicrovm(): Promise<MicrovmDescription> {
      const id = `mvm-${++n}`;
      bodies.set(id, { id, endpoint: `${id}.fake.on.aws`, state: "RUNNING", createdAtMs: Date.now(), fs: new Map() });
      self.runCount++;
      return { microvmId: id, endpoint: `${id}.fake.on.aws`, state: "RUNNING" };
    },
    async getMicrovm(id): Promise<MicrovmDescription> {
      const b = bodies.get(id);
      if (!b) throw new AwsApiError(`not found: ${id}`, 404);
      return { microvmId: id, endpoint: b.endpoint, state: b.state };
    },
    async tryGetMicrovm(id) {
      const b = bodies.get(id);
      return b ? { microvmId: id, endpoint: b.endpoint, state: b.state } : null;
    },
    async createAuthToken(id) {
      return `tok-${id}`;
    },
    async suspend(id) {
      const b = bodies.get(id);
      if (b && b.state === "RUNNING") b.state = "SUSPENDED";
    },
    async resume(id) {
      const b = bodies.get(id);
      if (b && b.state === "SUSPENDED") b.state = "RUNNING";
    },
    async terminate(id) {
      const b = bodies.get(id);
      if (b) b.state = "TERMINATED";
    },
    async waitForState(id, target) {
      const b = bodies.get(id);
      if (!b) throw new AwsApiError(`not found: ${id}`, 404);
      if (target === "RUNNING" && b.state === "SUSPENDED") b.state = "RUNNING";
      return { microvmId: id, endpoint: b.endpoint, state: b.state };
    },
  };

  function exec(body: FakeBody, cmd: string): { stdout: string; stderr: string; code: number; timedOut: boolean } {
    self.commands.push(cmd);
    const ok = { stdout: "", stderr: "", code: 0, timedOut: false };
    if (cmd.includes("tar --null -T - -cf '/tmp/agent-home.tar'")) {
      const dump: Record<string, string> = {};
      for (const [p, v] of body.fs)
        if (p.startsWith("/root") && p !== "/tmp/agent-home.tar") dump[p] = Buffer.from(v).toString("base64");
      body.fs.set("/tmp/agent-home.tar", enc(JSON.stringify(dump)));
      return ok;
    }
    if (cmd.includes("tar -xf '/tmp/agent-home.tar'")) {
      const blob = body.fs.get("/tmp/agent-home.tar");
      if (blob) {
        const dump = JSON.parse(Buffer.from(blob).toString("utf8")) as Record<string, string>;
        for (const [p, b64] of Object.entries(dump)) body.fs.set(p, Buffer.from(b64, "base64"));
      }
      body.fs.delete("/tmp/agent-home.tar");
      return ok;
    }
    if (cmd.includes("tar -xf '.ro-layers.tar'")) return ok;
    if (cmd.startsWith("mkdir -p") || cmd.startsWith("rm -f") || cmd.startsWith("rm -rf")) {
      if (cmd.startsWith("rm -f '/tmp/agent-home.tar'")) body.fs.delete("/tmp/agent-home.tar");
      return ok;
    }
    if (cmd.includes("find ") && cmd.includes("-type f")) {
      const files = [...body.fs.keys()]
        .filter((p) => p.startsWith("/root/workspace/"))
        .map((p) => p.slice("/root/workspace/".length));
      return { ...ok, stdout: files.join("\n") };
    }
    const echo = cmd.match(/echo ([^\n;|&]+)\s*$/);
    if (echo) return { ...ok, stdout: `${echo[1]!.trim()}\n` };
    return ok;
  }

  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    const u = new URL(String(url));
    const body = byEndpoint(u.hostname);
    const json = (status: number, obj?: unknown) =>
      new Response(obj === undefined ? "" : JSON.stringify(obj), {
        status,
        headers: { "content-type": "application/json" },
      });
    if (!body || body.state !== "RUNNING") return json(502, { error: "not running" });
    if (u.pathname === "/health") return json(200, { ok: true, pid: 1 });
    const payload = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};
    if (u.pathname === "/exec") return json(200, exec(body, String(payload.cmd ?? "")));
    if (u.pathname === "/write") {
      body.fs.set(String(payload.path), Buffer.from(String(payload.b64), "base64"));
      return json(200, { ok: true });
    }
    if (u.pathname === "/read") {
      const v = body.fs.get(String(payload.path));
      return v ? json(200, { b64: Buffer.from(v).toString("base64") }) : json(404, { error: "not found" });
    }
    return json(404, { error: "no route" });
  }) as unknown as typeof fetch;

  const s3 = {
    async send(cmd: unknown): Promise<unknown> {
      const c = cmd as { constructor: { name: string }; input: { Key: string; Body?: Uint8Array } };
      const name = c.constructor.name;
      if (name === "PutObjectCommand") {
        s3store.set(c.input.Key, c.input.Body as Uint8Array);
        return {};
      }
      if (name === "GetObjectCommand") {
        const v = s3store.get(c.input.Key);
        if (!v) throw new AwsApiError("NoSuchKey", 404);
        return { Body: { transformToByteArray: async () => v } };
      }
      if (name === "DeleteObjectCommand") {
        s3store.delete(c.input.Key);
        return {};
      }
      throw new Error(`fake s3: unsupported command ${name}`);
    },
  };

  self.api = api;
  self.s3 = s3;
  self.fetchImpl = fetchImpl;
  self.bodies = bodies;
  self.s3store = s3store;
  self.commands = [];
  self.killBody = (id: string) => {
    const b = bodies.get(id);
    if (b) b.state = "TERMINATED";
  };
  return self;
}
