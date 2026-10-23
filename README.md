# Team MCP Gateway on Kubernetes

A "reception desk" for AI tools. An admin connects MCP servers in a dashboard once; every
team member then gets **one gateway URL and their own API key** and can use the tools of
every connected server, from an MCP client (Claude Code, Cursor, MCP Inspector) or from a
chat agent inside the dashboard. Members never see upstream credentials.

The first data source is a WooCommerce store running in the same cluster, exposed through
an MCP server we wrote.

```
 MCP client ──(gateway URL + member API key)──┐
 Dashboard chat ──(member session)────────────┤
                                              ▼
                        Gateway (Node, MCP client + MCP server)
                   auth → policy → rate limit → route by "<slug>__<tool>"
                   adds the upstream credential · writes an audit row
             ┌───────────────────┼───────────────────────┐
             ▼                   ▼                       ▼
     woo-mcp (ours)        utils-mcp (ours)       DeepWiki (public, remote)
             │
             ▼ WooCommerce REST API (wc/v3)
     WordPress + WooCommerce + MariaDB
```

| Piece | Where | Notes |
|---|---|---|
| Store | `charts/platform/charts/store` | WordPress 7.0 + WooCommerce + MariaDB, persistent volumes, WP-CLI setup Job |
| Woo MCP server | `services/woo-mcp` | `list_products`, `create_product`, `list_orders`, `get_order`, `update_order_status` |
| Utils MCP server | `services/utils-mcp` | `get_time`, `convert_currency`; bearer-token protected |
| Gateway | `services/gateway` | Express + official MCP SDK, Postgres, chat agent |
| Dashboard | `services/dashboard` | React + Vite, served by nginx |
| Store provisioner | `services/provisioner` | creates/deletes extra stores (one Helm release + one MCP server each) |
| Store image | `services/store-wordpress` | WordPress 7.0 with WooCommerce pre-installed |
| Helm | `charts/platform` | one umbrella chart, `values-local.yaml` / `values-prod.yaml` |

Design notes: [docs/system-design.md](docs/system-design.md) · Threat model: [docs/threat-model.md](docs/threat-model.md)

---

## Local setup (k3d)

Needs Docker Desktop (give it 6 GB+ RAM), [k3d](https://k3d.io), kubectl, Helm 3, Node.js 22+.

```bash
# 1. cluster: k3s in Docker, Traefik published on host ports 80/443
k3d cluster create --config k3d/cluster.yaml

# 2. build our images and import them into the cluster
scripts/build-images.sh

# 3. install everything (the store setup Job takes a few minutes the first time)
helm install platform charts/platform -n urumi --create-namespace \
  -f charts/platform/values-local.yaml --timeout 15m --wait
```

`*.localtest.me` always resolves to 127.0.0.1, so no hosts-file edits are needed:

| URL | What |
|---|---|
| http://store.localtest.me | storefront (`/wp-admin` for WooCommerce admin) |
| http://gateway.localtest.me | dashboard |
| http://gateway.localtest.me/mcp | the one MCP endpoint |

All secrets are generated on first install and kept on upgrades. To read the passwords:

```bash
# dashboard: admin@example.com
kubectl -n urumi get secret platform-gateway -o jsonpath='{.data.admin-password}' | base64 -d
# wp-admin: admin
kubectl -n urumi get secret platform-store-admin -o jsonpath='{.data.password}' | base64 -d
```

### Chat agent provider

The chat agent talks to any OpenAI-compatible API; the provider is config only
(`gateway.llm.baseUrl`, `gateway.llm.model`, and the key in `secrets.llmApiKey`).

- **Local default: off.** `values-local.yaml` leaves the provider empty, so the chat says it
  is not configured until you add one.
- **Recommended:** a free hosted tier, for example Groq:

```bash
helm upgrade platform charts/platform -n urumi -f charts/platform/values-local.yaml \
  --set gateway.llm.baseUrl=https://api.groq.com/openai/v1 \
  --set gateway.llm.model=llama-3.3-70b-versatile \
  --set gateway.llm.timeoutMs=60000 \
  --set secrets.llmApiKey=$GROQ_API_KEY --timeout 15m --wait
kubectl -n urumi rollout restart deploy/platform-gateway
```

### Changing code

```bash
scripts/build-images.sh gateway            # rebuild + import one image (fixed tag)
kubectl -n urumi rollout restart deploy/platform-gateway
helm upgrade platform charts/platform -n urumi -f charts/platform/values-local.yaml --timeout 15m --wait
helm -n urumi history platform              # list revisions
helm -n urumi rollback platform <revision>  # roll back (tested: secrets and data survive)
```

---

## Using it

### Place an order (as a customer)

Open http://store.localtest.me, add a product to the cart, check out and choose
**Cash on delivery**. The order shows up in wp-admin under WooCommerce → Orders.

Scripted equivalent (same Store API the checkout page uses): `scripts/place-order.sh`.

### Members and keys

1. Log in to the dashboard as the admin.
2. **Members** → invite a member (email + initial password, role member or admin).
3. The member logs in → **API keys** → create a key. It is shown exactly once.

### Connect an MCP client

Only the gateway URL and your own key:

```bash
# Claude Code
claude mcp add --transport http team-gateway http://gateway.localtest.me/mcp \
  --header "Authorization: Bearer <your key>"

# MCP Inspector
npx @modelcontextprotocol/inspector
#   Transport: Streamable HTTP · URL: http://gateway.localtest.me/mcp
#   Header: Authorization = Bearer <your key>
```

Tools are named `<server>__<tool>`, e.g. `woo__list_orders`, `utils__convert_currency`.
Try "List today's orders and convert the total to USD" (needs two servers).

### Chat agent

Dashboard → **Chat**. Ask "Create a product called Desk Lamp for 499" or "What orders came
in today?". Each tool call is shown with its arguments and result, runs as you, and lands
in the audit log with `via = chat`.

### Admin controls

- **Servers:** add (any Streamable HTTP MCP URL, optional bearer or custom-header
  credential), edit, disable, remove, "Check now". Status: Connected / Unreachable / Disabled.
  Per-server 24h metrics (calls, errors, avg/p95 latency, rate-limited calls).
  "Members may only use read-only tools" limits members to tools marked `readOnlyHint`.
- **API keys:** revoke any key; it is rejected on the very next call.
- **Audit log:** every tool call (user, server, tool, time, duration, outcome); filter by
  user and server.

### Add a store (multi-store)

Dashboard → **Stores** (admin) → enter a name such as `bakery` → **Create store**. About 1.5
minutes later the store is live at http://bakery.localtest.me and its MCP server is registered,
so everyone sees `bakery__list_orders`, `bakery__create_product`, and so on. **Delete** removes
the store, its data and its tools.

How it works: the gateway asks the **provisioner**, which runs `helm install store-<name>` with
the same chart (store + woo-mcp only) in the `urumi-stores` namespace. Only the provisioner has
Kubernetes write access, and only in that namespace. A ResourceQuota and `provisioner.maxStores`
(default 3) cap the total.

wp-admin password of a store:

```bash
kubectl -n urumi-stores get secret store-<name>-store-admin -o jsonpath='{.data.password}' | base64 -d
```

### Run the whole checklist

```bash
(cd services/gateway && npm ci)          # the script uses the gateway's MCP SDK
node scripts/dod-check.mjs               # all checks, incl. chat (slow on a local CPU model)
node scripts/dod-check.mjs --no-chat
```

---

## Deploy to a VPS (k3s)

The same chart; only `values-prod.yaml` and the secrets differ.

```bash
# on the VPS (Ubuntu, 2 vCPU / 4 GB+)
curl -sfL https://get.k3s.io | sh -              # k3s ships Traefik + local-path storage
export KUBECONFIG=/etc/rancher/k3s/k3s.yaml

# cert-manager for Let's Encrypt
helm repo add jetstack https://charts.jetstack.io && helm repo update
helm install cert-manager jetstack/cert-manager -n cert-manager --create-namespace --set crds.enabled=true

# DNS: A records for store.<domain> and gateway.<domain> -> the VPS IP
```

Push the images to a registry (from your machine):

```bash
for s in store-wordpress woo-mcp utils-mcp gateway dashboard; do
  docker build -t ghcr.io/<you>/urumi-$s:0.1.0 services/$s && docker push ghcr.io/<you>/urumi-$s:0.1.0
done
docker build -t ghcr.io/<you>/urumi-provisioner:0.1.0 -f services/provisioner/Dockerfile .   && docker push ghcr.io/<you>/urumi-provisioner:0.1.0
```

Edit `charts/platform/values-prod.yaml` (domain, `certManager.email`, image repositories),
create an untracked `prod.secret.yaml` with at least `secrets.llmApiKey` (other secrets are
generated if left out), then:

```bash
helm upgrade --install platform charts/platform -n urumi --create-namespace \
  -f charts/platform/values-prod.yaml -f prod.secret.yaml --timeout 15m --wait
```

---

## Bonus / stand-out items

| Item | Where |
|---|---|
| Tool permissions per role (members read, admins write), per server | `services/gateway/src/upstreams.ts` (`allowed`), Servers page toggle |
| SSRF protection for admin-entered server URLs (DNS check + per-request re-check, no redirects) | `services/gateway/src/ssrf.ts` |
| Rate limit per API key / per chat user | `services/gateway/src/ratelimit.ts`, `RATE_LIMIT_PER_MINUTE` |
| Per-server metrics (24h calls, errors, avg/p95 latency, rate-limited) | `GET /api/metrics`, Servers page |
| NetworkPolicies: only the gateway reaches MCP servers and its DB; only WordPress reaches MariaDB | `charts/platform/templates/networkpolicies.yaml` |
| Every workload non-root (incl. WordPress on port 80 via a namespaced sysctl, MariaDB as mysql) | store chart templates |
| Upstream credentials encrypted at rest (AES-256-GCM) | `services/gateway/src/security.ts` |
| Prompt-injection hardening in the chat agent | `services/gateway/src/chat.ts`, threat model |
| Production values with cert-manager TLS | `charts/platform/values-prod.yaml`, `templates/cluster-issuer.yaml` |
| Automated Definition of Done check | `scripts/dod-check.mjs` |
| Multi-store: add/delete stores from the dashboard; one MCP server per store, auto-registered | `services/provisioner`, `services/gateway/src/stores.ts`, Stores page, `templates/provisioner.yaml` |
| Pre-built store image (WooCommerce baked in, per-store settings still applied) | `services/store-wordpress` |

Not done: a real VPS deploy (the prod values render and are ready, but no server was
available).
