# Scope model allowlists

Set `MODEL_SCOPE_ALLOWLISTS` to a JSON file to manage model access from deployment configuration.

```json
{
  "version": 1,
  "scopes": {
    "org:acme": {
      "models": ["claude-sonnet-5", "gpt-5.6-luna"],
      "default": "claude-sonnet-5"
    },
    "personal:person@example.com": {
      "models": ["claude-opus-5"],
      "default": "claude-opus-5"
    },
    "group:web-project-00000000-0000-0000-0000-000000000000": {
      "models": ["gpt-5.6-sol"],
      "default": "gpt-5.6-sol"
    }
  }
}
```

A turn receives the union of the organization entry and its one active scope entry. Personal, team, channel, and group entries never follow an actor into another scope.

The default is the active scope default, then the organization default, then the first effective model. A default must appear in the same entry's `models` list. Duplicate model IDs are removed while preserving organization-first order.

The policy controls runtime defaults, model pickers, direct model requests, Slack turns, and triggered turns. Runtime defaults cannot be changed through Admin or the Web UI while the file is configured. Invalid files prevent Core from starting. Changes take effect after Core restarts.
