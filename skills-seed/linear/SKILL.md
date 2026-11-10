---
name: linear
description: Search, read, create, and update the user's Linear issues, projects, and comments through their own Linear connection.
requiredCapabilities:
  - egress:api.linear.app
---

# Linear

Use this skill when the user asks about Linear issues, tickets, projects, cycles, or
their team's work tracking — finding issues, checking status, filing a bug, leaving a
comment, or updating an issue.

Linear's API is GraphQL at `https://api.linear.app/graphql`, reached one of two ways:

- **Direct token:** `$VAULT_TOKEN_API_LINEAR_APP` holds the user's Linear token; pass it as
  `-H "Authorization: Bearer $VAULT_TOKEN_API_LINEAR_APP"`. The examples below use it as
  written.
- **App connection:** with no token, the user connects Linear as an
  app instead (composio skill). Send the same request through QM — same method, URL, `query`,
  headers and JSON `body`, but no Authorization header:

  ```bash
  curl -sS "$AGENT_API_URL/v1/composio/proxy" -H "X-Agent-Capability: $AGENT_API_TOKEN" \
    -H 'content-type: application/json' \
    --data '{"method":"POST","url":"https://api.linear.app/graphql","body":{"query":"{ viewer { name email } }"}}'
  ```

  The reply is the provider's own status and body; the composio skill's "Raw requests"
  section covers `409` answers, choosing an account, and file bodies. The GraphQL `{"query":…}` object goes in `body`.

Do not ask the user for a token, log it, or use another principal's credential. With no
connection, or a 401/400 (`authentication`) from the API, tell the user they need to connect
Linear and stop — don't guess at issue data.

## Find / read issues

Query issues by text, assignee, or state:

```bash
curl -sS -X POST 'https://api.linear.app/graphql' \
  -H "Authorization: Bearer $VAULT_TOKEN_API_LINEAR_APP" \
  -H 'content-type: application/json' \
  --data '{"query":"{ issues(first: 20, filter: { title: { containsIgnoreCase: \"login\" } }) { nodes { identifier title state { name } assignee { name } url } } }"}'
```

Read one issue by id/identifier:

```bash
curl -sS -X POST 'https://api.linear.app/graphql' \
  -H "Authorization: Bearer $VAULT_TOKEN_API_LINEAR_APP" \
  -H 'content-type: application/json' \
  --data '{"query":"{ issue(id: \"ENG-123\") { identifier title description state { name } assignee { name } url comments { nodes { body user { name } } } } }"}'
```

Keep issue identifiers and `url`s in your answer so claims can be traced.

To create or assign an issue you usually need a team id — list them once:

```bash
curl -sS -X POST 'https://api.linear.app/graphql' \
  -H "Authorization: Bearer $VAULT_TOKEN_API_LINEAR_APP" \
  -H 'content-type: application/json' \
  --data '{"query":"{ teams(first: 100) { nodes { id key name } pageInfo { hasNextPage endCursor } } }"}'
```

Linear paginates every list: if `pageInfo.hasNextPage` is true, re-query with
`after: "<endCursor>"` — never conclude a team or issue doesn't exist from one page.

## Writes require approval

Creating an issue, commenting, or changing state is a write. Prepare the exact mutation,
summarize what it will create/change (team, title, target issue), and ask for approval
before running it.

After approval, create an issue:

```bash
curl -sS -X POST 'https://api.linear.app/graphql' \
  -H "Authorization: Bearer $VAULT_TOKEN_API_LINEAR_APP" \
  -H 'content-type: application/json' \
  --data '{"query":"mutation($input: IssueCreateInput!) { issueCreate(input: $input) { success issue { identifier url } } }","variables":{"input":{"teamId":"TEAM_ID","title":"Login button misaligned on mobile","description":"Reported by a user; repro on iOS Safari."}}}'
```

Add a comment to an existing issue:

```bash
curl -sS -X POST 'https://api.linear.app/graphql' \
  -H "Authorization: Bearer $VAULT_TOKEN_API_LINEAR_APP" \
  -H 'content-type: application/json' \
  --data '{"query":"mutation($input: CommentCreateInput!) { commentCreate(input: $input) { success comment { url } } }","variables":{"input":{"issueId":"ISSUE_UUID","body":"Fixed in the latest deploy."}}}'
```

Always report the resulting issue/comment identifier and `url`.
