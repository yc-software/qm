import { SlackClient } from "./slack.ts";

function tokens(): Map<string, string> {
  const out = new Map<string, string>();
  const json = process.env.LIVE_E2E_ACTOR_TOKENS;
  if (json)
    for (const [n, t] of Object.entries(JSON.parse(json) as Record<string, string>)) out.set(n.toLowerCase(), t);
  for (const [k, v] of Object.entries(process.env)) {
    const m = /^LIVE_E2E_ACTOR_TOKEN_(.+)$/.exec(k);
    if (m && v) out.set(m[1]!.toLowerCase(), v);
  }
  return out;
}

const all = tokens();
if (!all.size) {
  console.error("no actor tokens set (LIVE_E2E_ACTOR_TOKEN_<NAME> or LIVE_E2E_ACTOR_TOKENS json)");
  process.exit(1);
}
let ok = 0;
for (const [name, token] of all) {
  try {
    const a = await new SlackClient(token).authTest();
    console.log(`  ✅ ${name}: @${a.user} (${a.userId}) in ${a.teamId}`);
    ok++;
  } catch (err) {
    console.error(`  ❌ ${name}: ${err instanceof Error ? err.message : String(err)}`);
  }
}
console.log(`\n${ok}/${all.size} actor tokens valid`);
process.exitCode = ok === all.size ? 0 : 1;
