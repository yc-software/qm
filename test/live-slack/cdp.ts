import { spawn, type ChildProcess } from "node:child_process";
import { sleep } from "./slack.ts";

const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

interface CdpMessage {
  id?: number;
  method?: string;
  result?: any;
  error?: { message: string };
  params?: any;
  sessionId?: string;
}

export class Cdp {
  private ws!: WebSocket;
  private nextId = 1;
  private readonly pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>();
  private chrome?: ChildProcess;

  private constructor() {}

  static async launch(opts: {
    port: number;
    userDataDir: string;
    headed?: boolean;
    windowSize?: string;
  }): Promise<Cdp> {
    const args = [
      `--remote-debugging-port=${opts.port}`,
      `--user-data-dir=${opts.userDataDir}`,
      "--no-first-run",
      "--no-default-browser-check",
      `--window-size=${opts.windowSize ?? "1280,1200"}`,
      ...(opts.headed ? [] : ["--headless=new"]),
      "about:blank",
    ];
    const chrome = spawn(CHROME, args, { stdio: "ignore", detached: false });
    const cdp = new Cdp();
    cdp.chrome = chrome;
    const wsUrl = await Cdp.waitForBrowserWs(opts.port);
    await cdp.connect(wsUrl);
    return cdp;
  }

  private static async waitForBrowserWs(port: number): Promise<string> {
    const deadline = Date.now() + 20_000;
    while (Date.now() < deadline) {
      try {
        const res = await fetch(`http://127.0.0.1:${port}/json/version`);
        if (res.ok) {
          const data = (await res.json()) as { webSocketDebuggerUrl?: string };
          if (data.webSocketDebuggerUrl) return data.webSocketDebuggerUrl;
        }
      } catch {
        void 0;
      }
      await sleep(300);
    }
    throw new Error(`Chrome CDP not available on port ${port} after 20s`);
  }

  private connect(wsUrl: string): Promise<void> {
    return new Promise((resolve, reject) => {
      this.ws = new WebSocket(wsUrl);
      this.ws.addEventListener("open", () => resolve());
      this.ws.addEventListener("error", () => reject(new Error("CDP websocket error")));
      this.ws.addEventListener("message", (ev: MessageEvent) => {
        const msg = JSON.parse(String(ev.data)) as CdpMessage;
        if (msg.id !== undefined && this.pending.has(msg.id)) {
          const { resolve: res, reject: rej } = this.pending.get(msg.id)!;
          this.pending.delete(msg.id);
          if (msg.error) rej(new Error(msg.error.message));
          else res(msg.result);
        }
      });
    });
  }

  private send(method: string, params: Record<string, unknown> = {}, sessionId?: string): Promise<any> {
    const id = this.nextId++;
    const payload: Record<string, unknown> = { id, method, params };
    if (sessionId) payload.sessionId = sessionId;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify(payload));
      setTimeout(() => {
        if (this.pending.delete(id)) reject(new Error(`CDP ${method} timed out`));
      }, 30_000);
    });
  }

  async capture(
    url: string,
    opts: { needle?: string; readyMs?: number; settleMs?: number } = {},
  ): Promise<{ data: string; ready: boolean }> {
    const { targetId } = await this.send("Target.createTarget", { url });
    const { sessionId } = await this.send("Target.attachToTarget", { targetId, flatten: true });
    try {
      await this.send("Page.enable", {}, sessionId);
      await this.send("Runtime.enable", {}, sessionId);
      const deadline = Date.now() + (opts.readyMs ?? 30_000);
      let ready = !opts.needle;
      while (!ready && Date.now() < deadline) {
        const r = await this.send(
          "Runtime.evaluate",
          {
            expression: `document.body ? document.body.innerText.includes(${JSON.stringify(opts.needle)}) : false`,
            returnByValue: true,
          },
          sessionId,
        ).catch(() => ({ result: { value: false } }));
        ready = Boolean(r?.result?.value);
        if (!ready) await sleep(500);
      }
      await sleep(opts.settleMs ?? 1500);
      const shot = await this.send(
        "Page.captureScreenshot",
        { format: "png", captureBeyondViewport: false },
        sessionId,
      );
      return { data: shot.data as string, ready };
    } finally {
      await this.send("Target.closeTarget", { targetId }).catch(() => {});
    }
  }

  async isSlackLoggedIn(clientUrl: string): Promise<boolean> {
    const { targetId } = await this.send("Target.createTarget", { url: clientUrl });
    const { sessionId } = await this.send("Target.attachToTarget", { targetId, flatten: true });
    try {
      await this.send("Runtime.enable", {}, sessionId);
      await sleep(4000);
      const r = await this.send(
        "Runtime.evaluate",
        {
          expression: "location.href + '\\n' + (document.body ? document.body.innerText.slice(0, 600) : '')",
          returnByValue: true,
        },
        sessionId,
      ).catch(() => ({ result: { value: "" } }));
      const v = String(r?.result?.value ?? "");
      const signedOut =
        /sign in to your workspace|enter your workspace|create a new workspace|find your workspace/i.test(v);
      return !signedOut;
    } finally {
      await this.send("Target.closeTarget", { targetId }).catch(() => {});
    }
  }

  async close(): Promise<void> {
    try {
      await this.send("Browser.close");
    } catch {
      void 0;
    }
    this.ws?.close();
    this.chrome?.kill();
  }
}
