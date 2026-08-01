# Reject unknown top-level fields in qm.config.jsonc

Saw #54 and went looking at the validation to see if it was real. It is.

`validate` in `cli/src/config.ts` (around line 481) reads each known field out of the parsed object individually — `o["contract"]`, `o["orgId"]`, `o["basePort"]`, etc. — but never iterates `Object.keys` to see if there's anything it didn't expect. A misspelled optional field like `baseProt` just sits there unread, and the default kicks in with no feedback.

The pattern for catching this already exists in the same file. `validateSecurityScreen` (line 426) builds a `Set` of allowed keys and throws a `CliError` for anything outside it. The top-level validator never got the same treatment.

One thing worth deciding: error or warning. An error is stricter and catches typos immediately, but it also means a future CLI version adding a new optional field would break configs written for that version if someone runs an older CLI against them. A warning is friendlier for forward compat but easier to miss. The nested objects already chose "error," so matching precedent seems natural — but whether cross-version config compat matters for deployed repos is your call.

Happy to help test whatever direction you pick.
