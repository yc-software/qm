# External identity sessions in the auth broker

We run QM behind Portal, but the people using it already have accounts in another
identity service. That service can verify an email and password, return a short-lived
access token, and answer a current-user endpoint. The built-in auth plugin currently
owns the right OIDC boundary for Portal, but it only supports emailed sign-in links.

Could the broker accept a small external credential verifier while continuing to issue
the same authorization-code, PKCE, nonce, ID-token, and userinfo responses? The
verifier would return an immutable provider user ID, verified email, configured QM
principal, access-token expiry, and opaque provider material. Exact configured
ID/email/principal bindings would decide admission; provider roles would grant nothing.

The provider material and a random application-session ID need durable Core storage,
encrypted with the existing credential key. The browser would receive only the random
session ID. A private broker endpoint would recheck current-user state and another
would revoke the application session. Portal could then fail closed before protected
requests and before relaying later SSE chunks after expiry, logout, binding disable,
identity change, provider deletion, or provider outage.

For the first implementation, sessions would last no more than 15 minutes and never
refresh or slide. Passwords and provider refresh tokens would be discarded. Failed
login limits would reuse the broker's existing durable claim store. Existing email-link
deployments and Portal sessions would keep their current behavior unless the external
verifier is explicitly configured.

If this direction fits QM, I can send the implementation and focused auth, Portal, and
durability tests as a follow-up.
