# Align CLI dotenv parsing with Node's --env-file

Saw #56 and traced the parser to confirm. Both bugs are there.

`readEnvFile` in `cli/src/util.ts` (line 216) splits on the first `=` and takes everything after it verbatim. No quote stripping, no comment handling. So `TOKEN="abc#def"` gives you `"abc#def"` — literal double quotes included — while Node's `--env-file` gives you `abc#def`. And `VALUE=abc#def` comes back as `abc#def` where Node treats the `#` as an inline comment and gives you `abc`.

There's actually a test that asserts the wrong behavior: `"readEnvFile preserves hashes in unquoted values"` in `cli/test/util.test.ts` explicitly expects `abc#def` from an unquoted hash. That test was written as intentional, but it's documenting the divergence rather than the correct behavior.

One extra thing: there's a second copy of the same parser in `scripts/dev/lib/util.ts` (around line 32) with the same bugs. Whichever direction the fix goes, both copies need it.

The issue mentions `qm secrets set` and the setup writer as callers that would upload values with literal quotes into deployment secrets. That's the real downstream cost — it's not just a cosmetic mismatch, it's data corruption at the boundary between local dev and deployed config.

I don't have a strong view on whether to write a parser from scratch or lean on a well-known package. Node's `--env-file` semantics are documented but have some quirks of their own. Either way, the two copies probably want to become one.

Happy to help test the fix against the edge cases in the issue.
