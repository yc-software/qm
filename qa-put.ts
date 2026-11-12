import { signedRequestHeaders } from "./plugins/chassis/src/source-auth-sign.ts";
const [, , method, path, payload] = process.argv;
const body = payload ?? "";
const res = await fetch(`http://127.0.0.1:8083${path}`, { method, headers: signedRequestHeaders(process.env.SECRET!, method, path, body, { "content-type": "application/json" }), ...(body ? { body } : {}) });
console.log(res.status, (await res.text()).slice(0, 700));
