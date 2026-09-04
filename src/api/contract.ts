export const CAPABILITY_HEADER = "x-agent-capability";

export const CAPABILITY_CURL_AUTH = `-H "${CAPABILITY_HEADER}: $AGENT_API_TOKEN"`;

export function keychainUseCommand(ref: { grant: string } | { credential: string }): string {
  const body = "grant" in ref ? `{"grant":"${ref.grant}"}` : `{"credential":"${ref.credential}"}`;
  return (
    `curl -fsS -X POST "$AGENT_API_URL/v1/keychain/use" ${CAPABILITY_CURL_AUTH} ` +
    `-H 'content-type: application/json' -d '${body}' -o /tmp/keychain.env && . /tmp/keychain.env`
  );
}
