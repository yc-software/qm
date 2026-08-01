# PostgreSQL poll failures in `waitFor`

I ran into this while testing PostgreSQL-backed run completion.

If a polling `getRun` call fails, the error escapes the promise returned by `waitFor()` and can become an unhandled rejection. The polling interval also leaves its timeout scheduled after the run finishes.

I think `waitFor()` should reject with the original database error and clear the poll, timeout, and listener whenever it settles. I am not sure whether transient database errors should be retried first, so it would be good to agree on that behavior.

Happy to work on a fix if the proposed error behavior makes sense.
