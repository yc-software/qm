# Let coding agents hand work to QM

I spend most of the day in coding agents, and I'd like to hand a job to QM without switching to Slack or the web UI. A small user-facing CLI would give Claude Code, Codex, Cursor, and plain shell scripts one integration instead of needing a plugin for each one.

I think this would make QM useful to a group it does not naturally reach today. Slack and the web are good places to talk to QM, but development teams already live in terminals and coding agents. A CLI turns QM's durable work, company context, credentials, files, and background runs into something those agents can call as part of their normal workflow. It makes QM more than another chat surface: it becomes the place local agents can hand off work that needs organizational context or should keep running after the terminal closes.

Something like this would cover my first use case:

```sh
qm login https://qm.example.com
qm ask "investigate this failure" --file ./build.log --detach
qm run watch <run-id>
qm run steer <run-id> "also compare the previous release"
qm run cancel <run-id>
qm files pull <file-id>
```

I don't feel strongly about whether these are commands on the existing `qm` binary or a separate client. Reusing `qm` may be less surprising if it can tell whether a command needs a deployment directory.

The important part for me is that login uses the deployment's normal browser identity, with no capability token to copy into a dotfile, and that the CLI never gets more access than the signed-in user. A lost device should be revocable.

Files are also why I'd start with an API client rather than MCP. The CLI can stream bytes between a local path and QM while commands and model context only carry file IDs. Long work can return a run ID immediately, then survive terminal and network disconnects while the client watches or reconnects later.

A useful small first version would be login/logout/whoami, a personal-scope `ask`, file upload/download, and run get/watch/steer/cancel. QM already has the web versions of most of these flows, so I hope the first implementation can reuse those authorization, run, and file boundaries rather than create a second system. Shared scopes, Slack delivery, crons, and MCP can wait until the basic handoff feels good.
