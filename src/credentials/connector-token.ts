export function envKey(host: string): string {
  return `VAULT_TOKEN_${host.toUpperCase().replace(/[^A-Z0-9]/g, "_")}`;
}

export function connectorTokenNote(host: string): string {
  return `token in \`$${envKey(host)}\`; send it yourself as \`Authorization: Bearer\`; nothing adds it for you`;
}
