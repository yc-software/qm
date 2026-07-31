# The destructive-SQL rule in the command policy never fires

I was reading through `command-policy.ts` and I think the `drop|truncate table` floor rule
is dead code in practice.

`scannableCommand` strips quoted multi-word strings down to `""` before the rules run. SQL
always has spaces in it, so anything you'd actually type gets emptied out first:

```
psql -c "DROP TABLE users"      ->  allow             (scans as: psql -c "")
psql --command 'DROP TABLE x'   ->  allow
truncate users                  ->  allow             (Postgres doesn't need TABLE)
drop table users                ->  require_approval
```

I ran those through `evaluateCommand` with `defaultOrgPolicy()`. The only spelling that
trips the rule is the bare one, which is also the one nobody types — you reach a database
through a client, and the client takes the statement as a quoted argument.

The quote-stripping itself looks deliberate and I don't think it should change: `git commit
-m "drop table users"` has to stay allowed, and there's a test pinning exactly that. What
seems missing is on the rule side — something that pulls the statement out of `psql -c` /
`mysql -e` and scans it, the same way `pipedShellPayloads` already pulls the payload out of
a pipe-to-shell so that rule can work.

To be clear about scope: SECURITY.md already says the command policy is a speed bump rather
than a boundary, and I'm not treating this as a security hole. It's just that this
particular speed bump can't catch the accident it was written for.

Happy to leave it alone if you'd rather not touch it.
