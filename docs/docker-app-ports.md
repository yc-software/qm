# Docker app ports

The Docker development provider now requests a loopback-only ephemeral host port and reads Docker's mapping after readiness succeeds. The normal `{host, port}` endpoint is persisted as before. This removes volatile port maps that restarted at9200 after core reload and collided with an existing app.

No SQL table, field, key, index, constraint, migration, environment variable or user-facing configuration changes. Existing endpoints and running containers remain valid. The unused developer constructor option `basePort` is removed; repository callers did not set it. Docker remains the same provider, with the same image and network isolation.

Before:

```typescript
interface DockerDeployProviderOptions {
  image?: string;
  docker?: string;
  basePort?: number;
  dockerExec?: DockerExec;
  onError?: AppErrorSink;
}
```

After:

```typescript
interface DockerDeployProviderOptions {
  image?: string;
  docker?: string;
  dockerExec?: DockerExec;
  onError?: AppErrorSink;
}
```

Representative endpoint before: `{host:"127.0.0.1",port:9200}`. After: `{host:"127.0.0.1",port:32790}`. Only the allocated value differs; Docker retains the binding and QM stores it in the existing endpoint field. Invalid or non-loopback mapping results fail publication and use the existing container/network cleanup path.

All10 provider tests pass. The cross-provider reload regression fails against22efcad with the actual port-allocation collision. Native development QA published a second app on32790 while the retained app remained running on9200. Focused independent checkpoint reviews accepted Historylessness100, Hand-rolling99 and Non-durability99. These do not replace full-head reviews.
