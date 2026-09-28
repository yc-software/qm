import WebSocket from "ws";

const host = process.argv[2];
const key = process.env.AGENT37_API_KEY;
if (!host || !/^[a-z0-9-]+\.agent37\.app$/.test(host) || !key) process.exit(2);
const id = host.slice(0, -".agent37.app".length);
const socket = new WebSocket(`wss://${id}-22022.agent37.app/`, { headers: { "X-Agent37-Key": key } });
process.stdin.pause();
socket.on("open", () => process.stdin.resume());
process.stdin.on("data", (data) => socket.send(data));
process.stdin.on("end", () => socket.close());
socket.on("message", (data) => process.stdout.write(data));
socket.on("close", () => process.exit(0));
socket.on("error", () => process.exit(1));
