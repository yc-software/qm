# Memory benchmark fails when repository path contains spaces

I ran into this while testing on macOS.

If the repo lives in a path with spaces (for example `~/Documents/YC QM/qm`), `npm run bench:memory` fails before it even reaches the model call.

Looks like the file URL is ending up with `%20` instead of being converted back into a filesystem path.

I can reproduce it consistently by cloning into a directory with a space in its name.

Happy to work on a fix if this seems like the right direction.
