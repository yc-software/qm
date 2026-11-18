import base from "./vite.config.ts";
import { mergeConfig } from "vite";
const target = "http://127.0.0.1:8787";
export default mergeConfig(base, {
  server: { host: "127.0.0.1", port: 5173, proxy: { "/api": target, "/auth": target, "/me": target } },
});
