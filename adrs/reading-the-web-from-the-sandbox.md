# reading the web from the sandbox

hi, i'm recep. i work on crw, an open source scraper, so i'm biased about the binary. i
think the placement argument holds regardless of which one you'd pick.

the web tool PR is right about the problem, and your browse skill names the same gap: "to
retrieve information (read a page, check a price, hit an API), reach for curl/wget first".
curl hands the model raw HTML, misses whatever the page renders client side, and the
fallback, in the skill's own words, is "slow and expensive".

what i'd push back on is where the fetch happens.

a request out of the sandbox can be made to pass `egressDecision()` in
`src/resolution/egress-policy.ts`, which checks the destination host against the scope's
allow and deny lists. the authz service around it then resolves the host and rechecks the
addresses behind it, and the decision lands in the audit sink. i should say plainly that
this is worth less today than it sounds: local-docker and aws-microvm both declare
`egressEnforcement: "none"`, sprites only claims "domain" with an egress proxy url
configured, the audit row holds the host and not the url, and without DATABASE_URL the sink
is in memory.

so i'm not claiming it all works today. i'm saying a web read wants to be on the side of
that line which gets better as you fix it.

a fetch from the sandbox is on that side. i checked that crw honours HTTPS_PROXY, so
wherever that env is injected its reads go through the proxy like anything else. the
awkward part, which i'd rather name than have you find: sprites is the only backend that
injects it today, and sprites is also the one image you don't build, so my branch marks crw
not-installed there. right now the enforcement and the binary sit on different backends.
both halves of that are fixable, and neither is fixable for a call made from core. a
fetch made by core to a vendor API is on the other side permanently: no policy decision, no
audit row for the page, and the page itself pulled from the vendor's network. later work on
egress doesn't reach it. SECURITY.md already carries the browser provider version of this
as a known limitation, and this would be a second one, on the path the skill tells the
model to reach for first.

i did see that #69 exposes FIRECRAWL_BASE_URL, and that's genuinely good, but it moves the
endpoint rather than the fetch. core still makes the request, still outside the policy and
the audit.

so the ask is: put page reading in the sandbox, as a binary in the computer image, next to
gh and the aws cli. it rides `execute`, so there's no new tool, no provider interface, no
secret and no env var.

on which binary, i'm proposing my own, which you should weigh accordingly. anything that
turns a page into decent text from a shell would do. crw is the one i can answer questions
about: the linux build runs in a bare debian:12-slim with ca-certificates and nothing else,
no runtime and no daemon, `crw scrape <url>` returns markdown with no key and no config
file, and the release ships SHA256SUMS so it pins like the gh and awscli blocks already in
fly/Dockerfile. it's AGPL-3.0, which is a fair reason to say no to carrying it in a base
image you distribute.

two drawbacks i should name myself rather than let you find them.

being on the core side is exactly what lets the web tool put results through the content
screener, and sandbox command output isn't screened today. that's a real advantage of that
shape and i haven't got a clean answer, beyond it being a screening gap you already track
against an egress gap that would be new.

and crw's `search` isn't self-contained, it wants a search backend next to it. reading
pages is the part that's genuinely one binary and no config, so reading pages is all i'm
proposing. search is a separate conversation.

i wired it up on a branch rather than just describing it, in case that's useful:
github.com/us/qm/tree/crw-sandbox-web-reading.

recep
