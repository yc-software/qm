import { createServer, type Server } from "node:http";

/** Minimal stand-in for the Memorable extraction service: turns a trace into a deterministic draft. */
export function startExtractionStub(): Promise<{ server: Server; url: string; requests: unknown[] }> {
  const requests: unknown[] = [];
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const json = (obj: unknown) => {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify(obj));
      };
      if (req.url === "/v1/extract") {
        const trace = JSON.parse(body) as {
          session_id: string;
          workflow_id?: string;
          task_description?: string;
          prompt?: string;
          tool_calls: Array<{ name: string; input: Record<string, unknown>; result?: { ok: boolean } }>;
        };
        requests.push(trace);
        const classes: Record<string, string> = { execute: "execute", write: "write", read: "read" };
        const klass = (name: string) => classes[name] ?? "other";
        const steps = trace.tool_calls.map((call) => ({
          action: call.name,
          activity_class: klass(call.name),
          ...(typeof call.input.command === "string" ? { command: call.input.command } : {}),
          ...(typeof call.input.path === "string" ? { targets: [call.input.path] } : {}),
          ...(call.result ? { outcome: call.result.ok ? "ok" : "failed" } : {}),
        }));
        const title = (trace.task_description ?? trace.prompt ?? "untitled task").slice(0, 200);
        const files = steps.flatMap((s) => s.targets ?? []);
        const commands = steps.flatMap((s) => (s.command ? [s.command] : []));
        json({
          draft: {
            schema_version: 1,
            session_id: trace.session_id,
            workflow_id: trace.workflow_id ?? trace.session_id,
            title,
            trigger_signature: {
              summary_text: title,
              search_text: [title, ...files, ...commands].join(" "),
              entities: { file_paths: files, commands, tool_names: [...new Set(trace.tool_calls.map((c) => c.name))] },
            },
            steps,
            preconditions: [],
            postconditions: commands.length ? [`exited successfully: ${commands[commands.length - 1]}`] : [],
            embedding: [],
            embedding_model: "",
          },
        });
        return;
      }
      json({ ok: true, used: 0, remaining: 1000, allowance: 1000 });
    });
  });
  return new Promise((resolve) =>
    server.listen(0, () => {
      const { port } = server.address() as { port: number };
      resolve({ server, url: `http://127.0.0.1:${port}`, requests });
    }),
  );
}
