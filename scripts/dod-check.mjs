#!/usr/bin/env node
// Runs the Definition of Done checklist (project_context.txt, section 8)
// against a running install, with two users: A (chat) and B (MCP client).
//
//   (cd services/gateway && npm ci)      # the script borrows the gateway's MCP SDK
//   node scripts/dod-check.mjs           # everything, including the chat (slow on a CPU-only LLM)
//   node scripts/dod-check.mjs --no-chat # skip the chat checks
//
// Env: GATEWAY (default http://gateway.localtest.me), STORE (default http://store.localtest.me),
//      NAMESPACE (urumi), RELEASE (platform), ADMIN_EMAIL (admin@example.com).
//      Needs kubectl access to the cluster (reads the admin password, kills a pod).
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sdk = (p) => new URL(`file:///${root.replace(/\\/g, '/')}/services/gateway/node_modules/@modelcontextprotocol/sdk/dist/esm/${p}`).href;
const { Client } = await import(sdk('client/index.js'));
const { StreamableHTTPClientTransport } = await import(sdk('client/streamableHttp.js'));

const GATEWAY = process.env.GATEWAY ?? 'http://gateway.localtest.me';
const STORE = process.env.STORE ?? 'http://store.localtest.me';
const NS = process.env.NAMESPACE ?? 'urumi';
const REL = process.env.RELEASE ?? 'platform';
const withChat = !process.argv.includes('--no-chat');

const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`);
}
const kubectl = (...args) => execFileSync('kubectl', ['-n', NS, ...args], { encoding: 'utf8' }).trim();
const secret = (name, key) => Buffer.from(kubectl('get', 'secret', name, '-o', `jsonpath={.data.${key}}`), 'base64').toString();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- dashboard API as a logged-in user (cookie session)
async function login(email, password) {
  const res = await fetch(`${GATEWAY}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  if (!res.ok) throw new Error(`login ${email}: ${res.status}`);
  const cookie = res.headers.get('set-cookie').split(';')[0];
  return async (method, p, body) => {
    const r = await fetch(`${GATEWAY}/api${p}`, {
      method,
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: method === 'GET' ? undefined : JSON.stringify(body ?? {}),
    });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(`${method} ${p}: ${r.status} ${data.error ?? ''}`);
    return data;
  };
}

// ---- MCP client with only the gateway URL and an API key
async function mcp(key) {
  const client = new Client({ name: 'dod-check', version: '0' });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(`${GATEWAY}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${key}` } } }),
  );
  return client;
}
const text = (r) => r.content.map((c) => c.text ?? '').join('\n');

// ---- a customer order through the storefront's Store API (cart + checkout, COD)
async function placeOrder() {
  let cookie = '';
  const call = async (p, opts = {}) => {
    const r = await fetch(`${STORE}/?rest_route=/wc/store/v1${p}`, { ...opts, headers: { ...opts.headers, Cookie: cookie } });
    const set = r.headers.getSetCookie?.() ?? [];
    if (set.length) cookie = set.map((c) => c.split(';')[0]).join('; ');
    return r;
  };
  const cart = await call('/cart');
  const h = { Nonce: cart.headers.get('nonce'), 'Cart-Token': cart.headers.get('cart-token'), 'Content-Type': 'application/json' };
  const [product] = await (await call('/products&per_page=1')).json();
  await call('/cart/add-item', { method: 'POST', headers: h, body: JSON.stringify({ id: product.id, quantity: 1 }) });
  const addr = { first_name: 'Asha', last_name: 'Rao', address_1: '12 Park St', city: 'Bengaluru', state: 'KA', postcode: '560001', country: 'IN', email: 'asha@example.com', phone: '9999999999' };
  const out = await (await call('/checkout', { method: 'POST', headers: h, body: JSON.stringify({ billing_address: addr, shipping_address: addr, payment_method: 'cod' }) })).json();
  return out.order_id;
}

async function ensureMember(admin, email, password) {
  const members = await admin('GET', '/members');
  if (!members.some((m) => m.email === email)) await admin('POST', '/members', { email, name: email.split('@')[0], password });
}

// =====================================================================
const admin = await login(process.env.ADMIN_EMAIL ?? 'admin@example.com', secret(`${REL}-gateway`, 'admin-password'));
await ensureMember(admin, 'alice@example.com', 'alice-password-1');
await ensureMember(admin, 'bob@example.com', 'bob-password-1');
const alice = await login('alice@example.com', 'alice-password-1');
const bob = await login('bob@example.com', 'bob-password-1');

console.log('\n-- Store');
const orderId = await placeOrder();
check('Customer checks out with COD', Number.isInteger(orderId), `order #${orderId}`);
const adminKey = (await admin('POST', '/keys', { name: 'dod-check' })).key;
const ac = await mcp(adminKey);
const order = JSON.parse(text(await ac.callTool({ name: 'woo__get_order', arguments: { id: orderId } })));
check('Order is in WooCommerce (admin view)', order.id === orderId && order.payment_method === 'Cash on delivery', order.status);
await ac.close();

if (withChat) {
  console.log('\n-- Chat agent, as user A (alice)');
  const name = `DoD Lamp ${Date.now() % 100000}`;
  const created = await alice('POST', '/chat', { messages: [{ role: 'user', content: `Create a product called "${name}" with price 499` }] });
  const madeIt = created.steps.some((s) => s.tool === 'woo__create_product' && !s.isError);
  const onStore = await (await fetch(`${STORE}/?rest_route=/wc/store/v1/products&search=${encodeURIComponent(name)}`)).json();
  check('Chat creates a product that appears on the storefront', madeIt && onStore.length > 0, created.steps.map((s) => s.tool).join(', '));
  const today = await alice('POST', '/chat', { messages: [{ role: 'user', content: 'What orders came in today?' }] });
  const listed = today.steps.some((s) => s.tool === 'woo__list_orders' && s.result.includes(`"id": ${orderId}`));
  check('Chat answers "what orders came in today" with the order', listed, today.reply.slice(0, 80));
}

console.log('\n-- External MCP client, as user B (bob)');
const bobKey = await bob('POST', '/keys', { name: 'dod-check' });
const bc = await mcp(bobKey.key);
const servers = await admin('GET', '/servers');
const enabled = servers.filter((s) => s.enabled && s.status === 'connected').map((s) => s.slug);
const tools = (await bc.listTools()).tools.map((t) => t.name);
check('Connects with only the gateway URL and a key', tools.length > 0, `${tools.length} tools`);
check('Sees the tools of every enabled server', enabled.every((slug) => tools.some((t) => t.startsWith(`${slug}__`))), enabled.join(', '));
const todays = JSON.parse(text(await bc.callTool({ name: 'woo__list_orders', arguments: { date: 'today' } })));
check('Orders question returns today\'s order', todays.some((o) => o.id === orderId), `${todays.length} today`);
const total = todays.reduce((sum, o) => sum + Number(o.total), 0);
const usd = JSON.parse(text(await bc.callTool({ name: 'utils__convert_currency', arguments: { amount: total, from: 'INR', to: 'USD' } })));
check('One task across two servers (woo + utils)', usd.result > 0, `₹${total} = $${usd.result}`);

console.log('\n-- Team and control');
await bob('DELETE', `/keys/${bobKey.id}`);
let rejected = false;
try {
  await bc.listTools();
} catch {
  rejected = true;
}
check("Revoked key is rejected on the next call", rejected);

const deepwiki = servers.find((s) => s.slug === 'deepwiki') ?? servers.find((s) => s.slug !== 'woo' && s.slug !== 'utils');
if (deepwiki) {
  await admin('PATCH', `/servers/${deepwiki.id}`, { enabled: false });
  const chatTools = (await alice('GET', '/tools')).map((t) => t.name);
  const bob2 = await bob('POST', '/keys', { name: 'dod-check-2' });
  const bc2 = await mcp(bob2.key);
  const clientTools = (await bc2.listTools()).tools.map((t) => t.name);
  const gone = (list) => !list.some((t) => t.startsWith(`${deepwiki.slug}__`));
  check(`Disabled server's tools vanish from chat and client`, gone(chatTools) && gone(clientTools), deepwiki.slug);
  await admin('PATCH', `/servers/${deepwiki.id}`, { enabled: true });

  kubectl('scale', `deploy/${REL}-utils-mcp`, '--replicas=0');
  kubectl('wait', '--for=delete', 'pod', '-l', 'app.kubernetes.io/name=utils-mcp', '--timeout=60s');
  await sleep(12_000);
  const status = (await admin('GET', '/servers')).find((s) => s.slug === 'utils')?.status;
  const wooStill = await bc2.callTool({ name: 'woo__list_orders', arguments: { date: 'today' } });
  check('Kill one upstream pod: others work, dashboard shows Unreachable', !wooStill.isError && status === 'unreachable', `utils=${status}`);
  kubectl('scale', `deploy/${REL}-utils-mcp`, '--replicas=1');
  await bc2.close();
  await bob('DELETE', `/keys/${bob2.id}`);
}

const audit = await admin('GET', '/audit?limit=200');
const bobRows = audit.filter((r) => r.user_email === 'bob@example.com' && r.source === 'mcp');
const aliceRows = audit.filter((r) => r.user_email === 'alice@example.com' && r.source === 'chat');
check('Calls are in the audit log under the right user', bobRows.length >= 2 && (!withChat || aliceRows.length >= 2), `bob=${bobRows.length} alice(chat)=${aliceRows.length}`);
await admin('DELETE', `/keys/${(await admin('GET', '/keys')).find((k) => k.name === 'dod-check' && !k.revoked_at).id}`);

const failed = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - failed}/${results.length} checks passed`);
process.exit(failed ? 1 : 0);
