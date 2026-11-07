# Custom fonts in QM desktop

There's no way to change fonts in QM desktop. `--app-font`, `--brand-font` and the mono stack are hardcoded in `shell.css`, and `--font-mono` is referenced but never defined.

Ask: let me override them. The simplest version I can think of is desktop loading `~/.config/qm/user.css` if it exists and injecting it. Theme import accepting font vars would also work.

Why: readability and accessibility. QM is a desktop application and not all fonts are equally readable.
