# Require publicUrl to be an origin on every target

Saw #55 and checked the config validation to see how publicUrl is handled. The gap is real, and there's an extra wrinkle the issue doesn't mention.

`publicUrl` validation in `cli/src/config.ts` (around line 500) only checks that the value is non-empty and parses as an `http:` or `https:` URL. It doesn't reject paths, query strings, fragments, or credentials. Meanwhile `apiUrl` (line 511) in the same file already does exactly this — it checks `pathname !== "/"`, `search`, `hash`, `username`, `password`, even trailing dots on the hostname.

The check does exist for AWS deployments. `validateAwsFrontDoor` (around line 859) enforces origin-only on publicUrl, but it's gated behind `if (target === "aws")`. Docker and Fly targets never hit it.

The wrinkle: downstream code assumes publicUrl is an origin. `orgEnv()` in `cli/src/services.ts` does `publicUrl.replace(/\/$/, "")` and appends paths directly. `slack-manifests.ts` string-concatenates `/auth/callback` onto it. If someone puts a query string in publicUrl, every URL built from it breaks silently — the appended path lands after the `?`.

Seems like the simplest fix would be to move the origin check from `validateAwsFrontDoor` into the main publicUrl validation block so it applies regardless of target. The `apiUrl` validation is right there as a reference. Whether that's a breaking change for anyone who's currently running with a path in their publicUrl on docker/fly, I'm not sure — you'd have better visibility into that than I would.

Happy to help verify the fix once it's in.
