export type GoogleWorkspaceReadTarget = "calendar-settings";

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

const CALENDAR_SETTINGS_URL = "https://www.googleapis.com/calendar/v3/users/me/settings/timezone";

const CALENDAR_TOKEN_ENV = "VAULT_TOKEN_WWW_GOOGLEAPIS_COM";

const validateCalendarSettings = [
  `const fs=require("node:fs");`,
  `const path=process.argv[1];`,
  `let body;`,
  `let json;`,
  `try{body=fs.readFileSync(path,"utf8");json=JSON.parse(body);}`,
  `catch{console.error("google read error: invalid calendar settings JSON");process.exit(1);}`,
  `if(!json||json.id!=="timezone"){console.error("google read error: unexpected calendar settings response");process.exit(1);}`,
  `console.log("google read ok: target=calendar-settings bytes="+Buffer.byteLength(body,"utf8"));`,
].join("");

export function buildGoogleWorkspaceReadSmokeCommand(target: GoogleWorkspaceReadTarget = "calendar-settings"): string {
  if (target !== "calendar-settings") throw new Error(`unknown Google Workspace read smoke target: ${target}`);
  const out = "/tmp/qm-google-read-calendar-settings-$$.json";
  return [
    "set -e",
    `test -n "\${${CALENDAR_TOKEN_ENV}:-}" || { echo 'google read error: missing ${CALENDAR_TOKEN_ENV} (connect Google)'; exit 1; }`,
    `out=${shellQuote(out)}`,
    `curl -fsS -H "Authorization: Bearer $${CALENDAR_TOKEN_ENV}" ${shellQuote(CALENDAR_SETTINGS_URL)} > "$out"`,
    `node -e ${shellQuote(validateCalendarSettings)} "$out"`,
  ].join("; ");
}
