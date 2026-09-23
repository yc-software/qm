export const CAPABILITY_HEADER = "x-agent-capability";

export const CAPABILITY_CURL_AUTH = `-H "${CAPABILITY_HEADER}: $AGENT_API_TOKEN"`;

export function keychainUseCommand(ref: { grant: string } | { credential: string }): string {
  return "grant" in ref
    ? `request the credential listed for grant ${ref.grant} in execute.credentials`
    : `request the credential ${ref.credential} in execute.credentials`;
}
