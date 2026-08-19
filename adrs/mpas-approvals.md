# Multisig Approvals for QM

I just open-sourced a multisig protocol called MPAS and contributed the code to OMA3.  It would add more flexibility to the command policy of QM. 

MPAS stands for Multi-Party Action Security. It essentially brings banking-style approvals to agentic workflows. Aside from banking, multi-party approvals are also used in GitHub PRs and SAFE.global crypto transactions, but these are all bespoke implementations. MPAS allows any application or API to implement multi-party approvals using a common protocol.  Every party uses their own private key to sign/approve the exact action/command under consideration.

My proposal is to integrate MPAS into QM and use it as an additional security layer to the existing regex-based command policy. This enables the following capabilities:

1. Ability to specify X out of Y approvals from a predefined set of parties for certain high impact commands.
2. Approvers can be agents as well as humans, which would allow organizations to maintain autonomous workflows.  
3. More flexible policy framework that allows you to filter commands in a fine-grained manner based on the exact parameters as well as the command name. For example deleting a production database can require more approvals than deleting a test database. 
4. Application publishers (e.g.- Railway) can create plugins that define which commands/parameters are high impact and which ones are not. This is valuable because application developers know best about what their APIs are able to do. 
5. As a result of signatures, the audit trail can be cryptographically proven. 
6. Other features like asynchronous wait for approvals and complete separation of credentials from agents. 

If this is interesting to you, there are two integration paths:

1. Support MCP in QM and use the existing MPAS MCP bridges. 
2. Build an MPAS plugin architecture for CLI if you want to keep CLI as the only execution path. 

If you want to learn more about MPAS, here are some links. 

https://github.com/oma3dao/oma3-projects/blob/main/mpas.md
https://github.com/oma3dao/mpas
https://github.com/oma3dao/mpas-applications (existing MCP bridges)

I'd be happy to help with integration.