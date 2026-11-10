# Chinese (zh-CN) localization

We run qm in a production-like docker deployment for Chinese-speaking users, and the language barrier turned out to be the single biggest adoption problem — bigger than any missing feature. Every UI string is hardcoded English today and there's no i18n mechanism anywhere, so we went ahead and localized the whole thing ourselves from the deployment side. This writeup is what we learned, plus a nudge toward making localization a first-class thing upstream.

## What we actually did

On a real deployment of `@yc-software/qm` 0.1.11 (plain `qm init` docker setup), we built an overlay that rewrites the installed files in place and translates the full surface into zh-CN: 3428 string mappings in total, covering

- the portal and auth SSR pages, including the login and invitation emails,
- the admin frontend (the single big `index.html`),
- the web-ui chat SPA — this one is a minified bundle, so we patch it by matching stable anchors around each string and rebuild the precompressed `.gz` sidecars afterwards,
- the human-facing `message` fields the core API returns,
- the docker path hints the CLI prints.

The patch engine is idempotent (safe to run repeatedly), warns when an anchor is missing instead of silently corrupting anything, and replays automatically on every `qm up` so upgrades don't silently un-translate things. We've been living on this for a while and it holds up.

A few things we deliberately left in English: the skills prompts (they're instructions to the model, not UI), API contract keys, and enum values that code compares against — translating those breaks logic, which is exactly the kind of trap a naive "just translate the bundle" approach falls into.

## What we noticed that matters for doing this natively

- The portal/auth pages are SSR template strings, so a locale dictionary slots in naturally at render time.
- The admin frontend ships as one uncompressed ~700 KB `index.html` — trivially patchable, but also trivially converted to read strings from a catalog.
- The web-ui bundle is Vite/Lit output with no string extraction layer; once minified, only anchor-based patching works, which is inherently fragile across releases.
- Both the CSP script hashes and the ETags are computed at startup from the actual bytes on disk, which is why deployment-side patching works at all — and also means serving per-locale variants wouldn't fight any baked-in hashing.
- `pi-web-ui`, which web-ui already depends on, ships its own key-based i18n dictionary, so there's precedent in the stack for how this can look.

## What we'd suggest

We don't want to prescribe the implementation — that's your call — but two shapes seem obvious:

1. Key-based message catalogs plus a locale setting. The manifest/branding path already injects `selfLabel` into the frontends, so injecting a `locale` alongside it looks cheap. Then zh-CN, and any other language, is just a JSON file.
2. If full i18n is more than you want to take on right now, even an officially maintained list of translatable strings (or a stable anchor/markup convention) would make community language packs sustainable instead of every deployment hand-rolling its own patcher like we did.

Either way, we're happy to contribute our complete zh-CN translation table in whatever form is useful — as plain JSON data, re-keyed to match whatever catalog format you pick, or as the seed for the string list in option 2. The translations are already battle-tested against real users, which is usually the tedious part.
