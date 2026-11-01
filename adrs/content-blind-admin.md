# A content-blind admin role

We'd like someone to be able to run qm for an organization without being able to read everyone's personal conversations. Today `org_admin` can do both: it can manage the deployment, but it can also open another person's session history, transcript, and captured model requests. Auditing those reads helps, but it doesn't make an ordinary admin account a comfortable place to put that access.

Could qm have a second admin role for routine organization management that **cannot read other people's personal content**? That boundary should hold in core, whether the request comes through the admin UI or the agent's admin API. Hiding History alone wouldn't be enough: user details, files, memory, and other views can expose the same material. We'd keep the existing full-access `org_admin` for the smaller set of people who genuinely need it.

We're not asking for per-session sharing rules or a detailed permissions editor. The useful distinction is between *managing qm* and *reading what people told qm*. Is that a role you'd want upstream?
