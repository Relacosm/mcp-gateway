# System design and tradeoffs

## Components

| Component | Kind | Exposed | Why it looks like this |
|---|---|---|---|
| MariaDB | StatefulSet + PVC | ClusterIP | Stable identity and its own volume; NetworkPolicy lets only WordPress and the setup Job in. |
| WordPress + WooCommerce | Deployment + PVC, `Recreate` | Ingress `store.<domain>` | Official image. `Recreate` because the content volume is ReadWriteOnce. |
| Store setup Job | Helm post-install/upgrade hook | — | WP-CLI installs WordPress and WooCommerce, enables COD, free shipping and pages, turns off "coming soon", creates a sample product and registers the REST key. Every step checks first, so it re-runs safely on each upgrade. |
| woo-mcp | Deployment | ClusterIP only | Our MCP server over the WooCommerce REST API. Stateless Streamable HTTP. |
| utils-mcp | Deployment | ClusterIP only | Second in-cluster upstream (time, currency). Used for the "kill a pod" demo. |
| Gateway | Deployment | Ingress `gateway.<domain>/api`, `/mcp` | MCP client to every upstream, MCP server to every member, dashboard API, chat agent. |
| Gateway Postgres | StatefulSet + PVC | ClusterIP | Users, sessions, API keys, servers, audit log. |
| Dashboard | Deployment (nginx-unprivileged) | Ingress `gateway.<domain>/` | Static React build. Same host as the API, so the session cookie is first-party and there is no CORS at all. |

All of it is one umbrella Helm chart. Cross-cutting Secrets (DB passwords, the WooCommerce
key, the MCP tokens, the master key, the LLM key) are rendered in the umbrella chart so every
subchart reads the same value. Each is generated on first install unless passed in, and read
back with `lookup` on upgrades, so no secret is ever in the repo and upgrades never rotate
them by accident.

## Multi-store

Extra stores are created from the dashboard, and each gets **its own MCP server**: tools such as
`bakery__list_orders`. We chose one server per store over one shared server with a `store`
argument because then every per-server feature works per store for free (status, disable,
members-read-only, metrics, audit filter), and adding or deleting a store never restarts
something the other stores depend on.

1. Any user posts a name. The gateway checks it (2–15 lowercase letters or digits, no
   collision with an existing server slug, at most `gateway.maxStoresPerUser` stores per user),
   generates a bearer token for the new MCP server, stores it encrypted, and calls the provisioner.
2. The **provisioner** creates namespace `urumi-store-<name>` (labelled as one of its stores,
   annotated with owner and creation time), a ResourceQuota and LimitRange in it, and a
   RoleBinding that grants itself the store tenant role there. Then it runs
   `helm upgrade --install store-<name>` into that namespace, using the chart it carries in its
   own image, with a values file the platform release renders (images, sizes, domain, where the
   gateway lives) plus the name and token. Only store + woo-mcp are enabled in that release.
   Up to `provisioner.parallelInstalls` (2) installs run at once; Helm's `--timeout`
   (`installTimeoutSeconds`, 600) is the provisioning deadline.
3. Setup is the same idempotent WP-CLI Job as the built-in store. The image already contains
   WooCommerce, so a store is ready in about 1.5 minutes.
4. The gateway's reconcile loop (every 10s) sees the release is `deployed`, adds
   `store-<name>-woo-mcp.urumi-store-<name>` to the SSRF allowlist, and registers the server.
5. Delete (owner or admin): the gateway unregisters the server (its tools vanish at once), and
   the provisioner deletes the namespace, which takes the release, PVCs, Secrets and Ingress with it.

States shown in the dashboard: Provisioning / Ready / Failed / Deleting. The namespace is the
record, so state survives a provisioner restart: a failure reason is kept as a namespace
annotation, and a release left `pending-install` by a restart (Helm runs as the provisioner's
child, so it died too) shows as Failed with "interrupted ... retry or delete". **Retry** (posting
the same name again) is idempotent: a store on its way is left alone, a failed one is cleaned
up inside its namespace and installed again with the same token.

Isolation: each store has its own namespace, quota and limits. NetworkPolicies let only the
platform gateway reach a store's MCP server, only a store's own WordPress and setup Job reach
its MariaDB, and only the ingress controller and the store's own pods reach its WordPress, so
one store's MCP server cannot reach another store's database or site.

Why the provisioner needs cluster-wide rights, and how they are fenced in: creating namespaces
is cluster-scoped, so its ClusterRole may create/delete namespaces, quotas, limit ranges and
RoleBindings, and may `bind` exactly one ClusterRole (the store tenant role). RBAC cannot say
"only namespaces you created", so a ValidatingAdmissionPolicy does: every write by the
provisioner's service account must target a namespace labelled as its store (before and after
the change) or an object inside one. It cannot label, delete or write into `urumi`, and it still
has no read access to the gateway's secrets.

## How a tool call travels

1. **Authenticate.** An MCP client sends `Authorization: Bearer <member key>` to `/mcp`. The
   gateway hashes the key (SHA-256) and looks it up among non-revoked keys. That is one indexed
   query per request, which is why a revoked key fails on the very next call. Chat requests use
   the dashboard session cookie instead.
2. **List tools.** `tools/list` returns the cached tool lists of every enabled, connected
   server, renamed `<slug>__<tool>` and filtered by the caller's role.
3. **Route.** `tools/call` splits the name on the first `__`. Slugs are restricted to
   `[a-z0-9-]`, so a slug can never contain `__` and the split is unambiguous.
4. **Policy and rate limit.** Role policy (members may be limited to `readOnlyHint` tools)
   and a per-key / per-chat-user rate limit.
5. **Forward.** The call goes out on that upstream's own MCP client connection. The gateway
   adds the upstream's credential here, decrypting it from Postgres. The member's key is never
   forwarded.
6. **Audit.** One `audit_log` row: user, server, tool, source (`mcp` or `chat`), duration and
   outcome (`ok`, `tool_error` or `gateway_error`).

The chat agent calls the same `routeToolCall` function as `/mcp`, so the policy, rate limit
and audit rules cannot drift apart.

## Aggregation and failure handling

- **One client per upstream.** `UpstreamManager` keeps a separate MCP client, status and
  cached tool list for each server.
- **Background health check** (every 10s, 5s timeout). It runs `tools/list` on every enabled
  server and refreshes the cache. On failure it retries once on a fresh connection, because the
  old session may be stale (for example, the upstream restarted). If that also fails, the
  status becomes **Unreachable**.
- **Listing never waits on an upstream.** It is served from the cache, so one slow or dead
  server never blocks the others.
- **Calls fail with a clear message.** Each call has its own timeout (60s, since some tools
  generate answers, e.g. DeepWiki's `ask_wiki_question`), and a slow call fails only itself:
  "upstream 'deepwiki' did not answer 'ask_wiki_question' within 60s". It does not mark the
  server down; the health check decides that. A call to an Unreachable server returns
  immediately with "upstream 'utils' is unreachable (fetch failed)", and a network failure
  during a call marks the server Unreachable.
- **Disabling a server** closes its connection and hides its tools from everyone at once.
- **Our MCP servers are stateless** (a new server and transport per request), so any replica
  can serve any request and a restart loses nothing.

## Data model

```
users(id, email, name, password_hash[scrypt], role[admin|member])
sessions(token_hash, user_id, expires_at)                    -- cookie holds the raw token
api_keys(id, user_id, name, prefix, key_hash, last_used_at, revoked_at)
servers(id, name, slug, url, auth_type[none|bearer|header], auth_header,
        credential_enc[AES-256-GCM], enabled, members_read_only)
audit_log(id, created_at, user_id, user_email, server_id, server_slug, tool,
          source[mcp|chat], duration_ms, outcome, error)
meta(key, value)                                             -- e.g. "seeded:woo"
```

`audit_log` copies the user's email and the server's slug into each row, so rows stay
readable after a user or server is deleted.

## Chat agent

- **Stateless.** The browser sends the visible conversation, user and assistant text only.
- **Tool loop.** The backend sends the conversation plus the caller's tool list to an
  OpenAI-compatible `/chat/completions` endpoint and runs every requested tool through the
  gateway. It feeds results back until the model answers or a step cap (6) is reached.
- **Provider is config only** (base URL, model, key from a Secret), so Groq, Gemini, OpenAI
  or a local Ollama all work. Locally it runs on Groq (`openai/gpt-oss-120b`).
- **Free-tier rate limits.** A 429 from the provider is retried up to 3 times after the wait
  it asks for (Retry-After or "try again in Ns", capped at 20s); after that the chat returns a
  clear "rate limited, try again in a minute" instead of a raw provider error.
- **Small-model accommodations:**
  - tool schemas are cleaned of keys some providers reject;
  - numeric arguments accept numeric strings;
  - JSON written as text is accepted as a tool call only when it names a real tool;
  - an optional one-tool-per-step mode exists.

## WooCommerce integration choice

The Woo MCP server uses the **WooCommerce REST API (wc/v3)**. It is the official, documented,
stable interface, works over the network, and needs no shell access into the WordPress pod.

There was one wrinkle. WooCommerce only accepts key/secret Basic auth on HTTPS requests, and
over plain HTTP it requires OAuth 1.0a signatures. Inside the cluster we call the ClusterIP
service over HTTP and send `X-Forwarded-Proto: https`; the official WordPress image's
`wp-config.php` maps that header to `$_SERVER['HTTPS']`. This is safe: on the public path,
Traefik overwrites `X-Forwarded-Proto`, so outside clients cannot fake it, and only the
gateway can reach woo-mcp anyway. The side effect is that WordPress builds `https://`
permalinks, so woo-mcp rewrites them onto the public store URL. Signing OAuth 1.0a would avoid
the header but adds code for no security gain inside the cluster.

## Tradeoffs we chose

| Choice | Why | Cost |
|---|---|---|
| Stateless MCP endpoints | Simple, horizontally scalable, restarts are invisible | No server-initiated notifications (e.g. `tools/list_changed`); clients re-list instead |
| Health-check cache for tool lists | Listing is instant and isolated from slow upstreams | A newly added upstream tool appears within one interval (10s), or at once via "Check now" |
| In-memory rate limits and upstream connections | No extra infrastructure (no Redis) | Per replica; the gateway runs as 1 replica by default so limits are exact |
| Sessions in Postgres, not JWTs | Logout and member removal take effect immediately | One query per dashboard request |
| Fixed reference rates in utils-mcp | Deterministic demo, no outbound dependency | Not live rates (stated in the tool description) |
| Helm-generated secrets with `lookup` | Nothing secret in git, one-command install | `helm template` shows throwaway values; real prod values come from `--set` or a secret file |

## What changes for production

- **Values only:** `values-prod.yaml` sets the real domain, TLS through cert-manager (a
  ClusterIssuer is included), larger resources and volumes, images from a registry, and a
  hosted LLM. Secrets come from an untracked file at install time.
- **Cookies** become `Secure` automatically when TLS is on.
- **Next steps if usage grows:**
  - Move rate-limit counters to Redis before running more than one gateway replica.
  - Add a retention job for `audit_log`.
  - Back up both databases (e.g. a CronJob with `mysqldump` / `pg_dump` to object storage).
  - Use a managed Postgres.
  - Consider a ReadWriteMany volume or object storage for WordPress uploads to run more than
    one WordPress pod.
