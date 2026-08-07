# A Money Forward Cloud 経費 connector

We run qm at a Japanese company, and expense claims are the thing people most often want
to ask an agent about that it currently cannot see. Money Forward Cloud is the dominant
back-office suite here; 経費 (クラウド経費) is its expense product.

We have this working locally and are happy to hand over whatever is useful, but the
interesting part is not the code — it is one decision we could not make well on our own.

## It fits the existing shape

`https://expense.moneyforward.com` speaks plain OAuth 2.0 authorization code, and the
token response is standard, so the default adapters in `makeTokenAdapters({})` handle both
exchange and refresh with no custom code. The authorize and token URLs are static strings
(`/oauth/authorize`, `/oauth/token`), the API is REST under
`/api/external/v1/`, and there is a single host to allow. It is the same shape as Linear or
Dropbox: an additive `PROVIDERS` entry, three lines of secret schema, one line in
`CONNECTOR_SKILL_PROVIDERS`, and a seed skill.

Refresh tokens rotate — using a newly issued access token invalidates the previous access
token *and* the previous refresh token. `refreshAndStore` already persists whatever
`refresh_token` comes back and dedupes concurrent refreshes through `inflightRefreshes`, so
this needs nothing new. We mention it only because it is what convinced us the connector
belongs in core: a skill holding a static credential cannot do this safely, since a failed
write-back or two turns refreshing at once leaves the credential permanently broken.

## The decision we would like your view on: scopes

Money Forward documents no read-only scope for the resources people actually want to read.
The scope list is `office_setting:*`, `user_setting:*`, `transaction:*`, `report:*`,
`account:*`, `public_resource:read`, and while `:read` variants exist for some, we could
not find `transaction:read` or `report:read` anywhere in their published docs — only the
`:write` forms appear in the examples. So reading someone's expense transactions appears to
require a scope that also lets an agent create and update them.

That is an uncomfortable default for a money system, and it is not really a Money Forward
problem — it is a question about what qm should do when a vendor offers no read-only scope
for something consequential.

We defaulted the provider entry to `public_resource:read` + `user_setting:read`, which is
enough to prove the connection and nothing else, and left widening to an administrator
through the per-org scope override, with the reason spelled out in `scopesRationale`. The
seed skill tells the agent that a 403 or an empty result most likely means scope rather
than "no expenses", so users get pointed at the real cause.

We are not sure that is the right call. The alternatives we considered were requesting the
write scopes by default and relying on the skill to refuse to write, or splitting the
provider so the write scopes are a separate connection. Both felt worse, but we would
rather follow whatever convention you want here than invent one, since the same question
will come up for any other vendor that bundles read into write.

Happy to test against a live Japanese Money Forward tenant either way — that is the part
that is hard to come by outside Japan.
