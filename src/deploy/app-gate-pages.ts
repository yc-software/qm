import { escapeHtml } from "../../plugins/chassis/src/http.ts";

function gateCardHtml(title: string, paragraphsHtml: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1"><title>${escapeHtml(title)}</title>
<style>body{margin:0;min-height:100vh;display:grid;place-items:center;background:#0a0a0a;color:#fafafa;
font:14px/1.6 ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,Helvetica,Arial,sans-serif}
.card{max-width:420px;text-align:center;padding:32px 20px}h1{font-size:19px;margin:0 0 10px}
p{color:#a3a3a3;margin:0 0 8px}b{color:#fafafa}a{color:#fafafa}</style></head>
<body><div class="card"><h1>${escapeHtml(title)}</h1>${paragraphsHtml}</div></body></html>`;
}

export const REQUEST_ACCESS_PATH = "/__claw__/request-access";

export function notSharedHtml(sub: string): string {
  return gateCardHtml(
    "This app hasn't been shared with you",
    `<p>You're signed in as <b>${escapeHtml(sub)}</b>, but this app's owner hasn't shared it with you.</p>
<p>Ask the owner for access, or for the app's share link.</p>
<p><button id="req" style="margin-top:12px;padding:8px 18px;border-radius:8px;border:1px solid #3f3f3f;
background:#fafafa;color:#0a0a0a;font:inherit;font-weight:600;cursor:pointer">Request access</button></p>
<script>document.getElementById("req").addEventListener("click",async function(){
var b=this;b.disabled=true;b.textContent="Sending\u2026";
try{var r=await fetch(${JSON.stringify(REQUEST_ACCESS_PATH)},{method:"POST"});
b.textContent=r.ok?"Request sent \u2713":"Couldn't send \u2014 try again";b.disabled=r.ok;}
catch(e){b.textContent="Couldn't send \u2014 try again";b.disabled=false;}});</script>`,
  );
}

export function signInFailedHtml(signIn: string): string {
  return gateCardHtml(
    "Sign-in didn't reach this app",
    `<p>You signed in, but this app never received your session. This usually means the app gateway is misconfigured — tell whoever runs it.</p>
<p><a href="${escapeHtml(signIn)}">Try signing in again</a></p>`,
  );
}
