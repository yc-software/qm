import { createServer } from "node:http";
import type { AddressInfo } from "node:net";

export async function verificationUpstream() {
  const requests: {
    path: string;
    body: Record<string, unknown>;
    authorization?: string;
    key?: string;
    beta?: string;
    gatewayKey?: string;
  }[] = [];
  const behavior = { status: 200, empty: false, hang: false, rejectFast: false };
  const server = createServer((req, res) => {
    let raw = "";
    req.on("data", (chunk) => {
      raw += chunk;
    });
    req.on("end", () => {
      const body = JSON.parse(raw);
      requests.push({
        path: req.url!,
        body,
        authorization: req.headers.authorization,
        key: req.headers["x-api-key"] as string,
        beta: req.headers["anthropic-beta"] as string,
        gatewayKey: req.headers["x-gateway-key"] as string,
      });
      if (behavior.hang) return;
      const status = behavior.rejectFast && body.speed === "fast" ? 400 : behavior.status;
      if (status !== 200) {
        res.writeHead(status, { "content-type": "application/json" });
        return res.end(
          JSON.stringify({
            error: { message: `${status} private-provider-detail`, type: "invalid_request_error" },
          }),
        );
      }
      res.writeHead(200, { "content-type": "text/event-stream" });
      const text = behavior.empty ? "" : "VERIFIED MODEL REPLY";
      const send = (type: string, data: object) =>
        res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
      if (req.url?.endsWith("/messages")) {
        send("message_start", {
          message: {
            id: "msg_probe",
            type: "message",
            role: "assistant",
            content: [],
            model: body.model,
            stop_reason: null,
            usage: { input_tokens: 5, output_tokens: 0 },
          },
        });
        send("content_block_start", { index: 0, content_block: { type: "text", text: "" } });
        send("content_block_delta", { index: 0, delta: { type: "text_delta", text } });
        send("content_block_stop", { index: 0 });
        send("message_delta", { delta: { stop_reason: "end_turn" }, usage: { output_tokens: 3 } });
        send("message_stop", {});
      } else {
        const item = {
          id: "msg_probe",
          type: "message",
          role: "assistant",
          status: "completed",
          content: [{ type: "output_text", text, annotations: [] }],
        };
        send("response.created", { response: { id: "resp_probe", status: "in_progress", output: [] } });
        send("response.output_item.added", { output_index: 0, item: { ...item, status: "in_progress", content: [] } });
        send("response.content_part.added", {
          output_index: 0,
          item_id: item.id,
          content_index: 0,
          part: { type: "output_text", text: "", annotations: [] },
        });
        send("response.output_text.delta", { output_index: 0, item_id: item.id, content_index: 0, delta: text });
        send("response.output_item.done", { output_index: 0, item });
        send("response.completed", {
          response: {
            id: "resp_probe",
            status: "completed",
            output: [item],
            usage: { input_tokens: 5, output_tokens: 3, total_tokens: 8 },
          },
        });
      }
      res.end();
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    requests,
    behavior,
    async close() {
      server.closeAllConnections();
      await new Promise<void>((r) => server.close(() => r()));
    },
  };
}
