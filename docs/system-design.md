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
- **Calls fail fast with a clear message.** Each call has its own timeout (15s), so the
  message reads like "upstream 'utils' timed out after 15s". A call to an Unreachable server
  returns immediately with "upstream 'utils' is unreachable (fetch failed)". A network failure
  during a call also marks the server Unreachable.
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
  or a local Ollama all work.
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
