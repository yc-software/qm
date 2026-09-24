import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
const routes = new Map([
  ["/gallery.js", ["gallery.js", "text/javascript"]],
  ["/", ["index.html", "text/html"]],
  ["/org-design.css", ["org-design.css", "text/css"]],
  ["/DESIGN.md", ["DESIGN.md", "text/plain"]],
]);
createServer(async (req, res) => {
  const route = routes.get(new URL(req.url, "http://localhost").pathname);
  if (!route) {
    res.writeHead(404);
    res.end("Not found");
    return;
  }
  try {
    const body = await readFile(new URL(route[0], import.meta.url));
    res.writeHead(200, { "content-type": route[1] + "; charset=utf-8" });
    res.end(body);
  } catch {
    res.writeHead(500);
    res.end("Unable to load this page");
  }
}).listen(Number(process.env.PORT || 8080), "0.0.0.0");
