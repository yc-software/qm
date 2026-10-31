# Discord live QA

Every row below must be run against a real Discord server on a dev instance. No live result is claimed here.

| #   | Action                                                                                                         | Status           |
| --- | -------------------------------------------------------------------------------------------------------------- | ---------------- |
| 1   | Save token, client secret, guild and role in the admin card; bot connects                                      | pending live run |
| 2   | Staff DMs the bot; mention reply                                                                               | pending live run |
| 3   | `@bot` in a Staff/Colleague-only channel opens a thread and replies                                            | pending live run |
| 4   | In-thread reply without mention gets an answer                                                                 | pending live run |
| 5   | Restart then immediate `@bot hi` shows the "can't confirm who can read" notice                                 | pending live run |
| 6   | Outsider added to channel: guest refusal                                                                       | pending live run |
| 7   | Third-party bot added: guest refusal; removed: answers resume                                                  | pending live run |
| 8   | Cron created at row 3 with Outsider present posts nothing                                                      | pending live run |
| 9   | Command approval: DM card with buttons plus thread pointer                                                     | pending live run |
| 10  | Other thread member receives no card                                                                           | pending live run |
| 11  | Double-click "Allow once" runs one continuation                                                                | pending live run |
| 12  | DMs closed: web fallback link approves                                                                         | pending live run |
| 13  | Standing order ("summarize every Friday") creates a cron                                                       | pending live run |
| 14  | "What did we discuss earlier" reads thread history                                                             | pending live run |
| 15  | "React to my last message" lands the reaction                                                                  | pending live run |
| 16  | Web Connect Discord: consent and return                                                                        | pending live run |
| 17  | Outsider opens the authorize URL: refused                                                                      | pending live run |
| 18  | Keychain ask routes to the credential owner's DM                                                               | pending live run |
| 19  | Slack command approval stays on Slack                                                                          | pending live run |
| 20  | Disconnect in web settings unlinks                                                                             | pending live run |
| 21  | Kill mid DM turn then restart: reply recovered, not duplicated                                                 | pending live run |
| 22  | Ctrl-C shuts the gateway down cleanly                                                                          | pending live run |
| -   | `discord.js` expects undici ^6; the root override pins undici 8.10.2 - verify REST calls and file uploads live | pending live run |
| -   | Private-thread scenarios (thread inherits parent config, conflict refusal, thread-member readers)              | pending live run |
