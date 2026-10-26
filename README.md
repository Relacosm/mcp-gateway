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
- **Recommended:** a free hosted tier, for example Groq (tested with `openai/gpt-oss-120b`).
  Put the provider and key in an untracked `local.secret.yaml` (`*.secret.yaml` is gitignored):

```yaml
# local.secret.yaml
gateway:
  llm:
    baseUrl: https://api.groq.com/openai/v1
    model: openai/gpt-oss-120b
    timeoutMs: 60000
secrets:
  llmApiKey: <your Groq key>
```

```bash
helm upgrade platform charts/platform -n urumi -f charts/platform/values-local.yaml \
  -f local.secret.yaml --timeout 15m --wait
kubectl -n urumi rollout restart deploy/platform-gateway
```

Pass `-f local.secret.yaml` on every later upgrade too, or the chat goes back to "not configured".
Free tiers limit tokens per minute (Groq: 8,000/min for this model, about three chat steps);
on a 429 the gateway waits as long as the provider asks (up to 20s, 3 retries) before giving up.
List the models your key can use with
`curl -H "Authorization: Bearer $KEY" https://api.groq.com/openai/v1/models`.

### Changing code

```bash
scripts/build-images.sh gateway            # rebuild + import one image (fixed tag)
kubectl -n urumi rollout restart deploy/platform-gateway
helm upgrade platform charts/platform -n urumi -f charts/platform/values-local.yaml -f local.secret.yaml --timeout 15m --wait
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

Tools are named `<server>__<tool>`, e.g. `urumi__list_orders`, `utils__convert_currency`.
Try "List today's orders and convert the total to USD" (needs two servers).

### Chat agent

Dashboard → **Chat**. Ask "Create a product called Desk Lamp for 499" or "What orders came
in today?". Each tool call is shown with its arguments and result, runs as you, and lands
in the audit log with `via = chat`.

### Admin controls

- **Servers:** add (any Streamable HTTP MCP URL, optional bearer or custom-header
  credential), edit, disable, remove, "Check now". Status: Connected / Unreachable / Disabled.
  Per-server 24h metrics (calls, errors, avg/p95 latency, rate-limited calls).
  "Members may only use read-only tools" (on by default, including for every store) limits
  members to tools marked `readOnlyHint`. A store's owner keeps write access to their own store.
  When an upstream leaves that label out or gets it wrong (DeepWiki sets none), an admin can
  correct it per tool under "Show tools" (mark as read / mark as write / reset).
- **API keys:** revoke any key; it is rejected on the very next call.
- **Audit log:** every tool call (user, server, tool, time, duration, outcome); filter by
  user and server.

### Add a store (multi-store)

Dashboard → **Stores** → enter a name such as `bakery` → **Create store**. About 2–3 minutes
later the store is live at http://bakery.localtest.me and its MCP server is registered, so
everyone sees `bakery__list_orders`, `bakery__create_product`, and so on. **Delete** removes
the store's whole namespace (site, database, volumes, secrets) and its tools.

How it works: the gateway asks the **provisioner**, which creates namespace `urumi-store-<name>`
with its own ResourceQuota and LimitRange, then runs `helm install store-<name>` with the same
chart (store + woo-mcp only) into it. Several stores can be provisioned at once (status
Provisioning / Ready / Failed). Any user may own up to `gateway.maxStoresPerUser` (2) stores and
`provisioner.maxStores` (3) caps the total; the owner or an admin can **Retry** a failed store or
**Delete** it. If the provisioner restarts mid-install, the store shows Failed ("interrupted")
and Retry is safe. Only the provisioner has Kubernetes write access, and a
ValidatingAdmissionPolicy limits it to its own store namespaces. NetworkPolicies keep each
store's database, WordPress and MCP server unreachable from other stores.

wp-admin password of a store:

```bash
kubectl -n urumi-store-<name> get secret store-<name>-store-admin -o jsonpath='{.data.password}' | base64 -d
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
| Chat agent survives free-tier rate limits (waits and retries on 429 as the provider asks) | `services/gateway/src/chat.ts` (`complete`) |
| Dashboard redesign: mono, square, light/dark with a sun/moon toggle, live top bar (upstreams up, tool count), clickable example prompts | `services/dashboard/src` |
| Storefront skin matching the dashboard (light/dark), shipped as a must-use plugin from a ConfigMap; `store.skin.enabled` turns it off | `charts/platform/charts/store/files/urumi-skin.php` |
| Production values with cert-manager TLS | `charts/platform/values-prod.yaml`, `templates/cluster-issuer.yaml` |
| Automated Definition of Done check | `scripts/dod-check.mjs` |
| Multi-store: create/retry/delete stores from the dashboard; one namespace + ResourceQuota + LimitRange + MCP server per store, auto-registered; parallel installs, per-user cap, provisioning timeout, restart recovery | `services/provisioner`, `services/gateway/src/stores.ts`, Stores page, `templates/provisioner.yaml` |
| Provisioner fenced by a ValidatingAdmissionPolicy: it can only write in its own store namespaces | `templates/provisioner.yaml` |
| Cross-store isolation: a store's DB, WordPress and MCP server are unreachable from other stores | `templates/networkpolicies.yaml` |
| Pre-built store image (WooCommerce baked in, per-store settings still applied) | `services/store-wordpress` |

Live VPS deploy (k3s on a Contabo VPS, Let's Encrypt TLS):

- Dashboard: https://gateway.urumi.relacosm.com
- MCP endpoint: https://gateway.urumi.relacosm.com/mcp
- Built-in store: https://store.urumi.relacosm.com
- Stores created from the dashboard: `https://<name>.urumi.relacosm.com` (wildcard DNS),
  e.g. https://quickbakers.urumi.relacosm.com
