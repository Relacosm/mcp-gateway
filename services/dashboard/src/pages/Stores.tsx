import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { api, when } from '../api';

interface Store {
  name: string;
  namespace: string;
  state: 'creating' | 'ready' | 'failed' | 'deleting';
  message: string;
  url: string;
  admin_url: string;
  created_at: string | null;
  created_by: string | null;
  can_manage: boolean;
  server: { id: number; slug: string; status: string; tools: number } | null;
}

const STATE_LABEL: Record<Store['state'], string> = {
  creating: 'Provisioning',
  deleting: 'Deleting',
  ready: 'Ready',
  failed: 'Failed',
};

// Starter products for a new store (store.catalogs in the Helm chart).
const CATALOGS = [
  { value: 'custom', label: 'Custom (empty)' },
  { value: 'apparel', label: 'Clothing' },
  { value: 'bakery', label: 'Bakery' },
  { value: 'books', label: 'Books' },
];

const STATE_CLASS: Record<Store['state'], string> = {
  creating: 'pending',
  deleting: 'pending',
  ready: 'connected',
  failed: 'unreachable',
};

export function Stores() {
  const [stores, setStores] = useState<Store[]>([]);
  const [limits, setLimits] = useState<{ per_user: number; mine: number } | null>(null);
  const [enabled, setEnabled] = useState(true);
  const [name, setName] = useState('');
  const [catalog, setCatalog] = useState('custom');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const full = !!limits && limits.mine >= limits.per_user;

  const load = useCallback(() => {
    api<{ enabled: boolean; stores: Store[]; limits?: { per_user: number; mine: number } }>('/stores')
      .then((r) => {
        setEnabled(r.enabled);
        setStores(r.stores);
        setLimits(r.limits ?? null);
      })
      .catch((err) => setError(err.message));
  }, []);

  useEffect(() => {
    load();
    const t = setInterval(load, 5000);
    return () => clearInterval(t);
  }, [load]);

  async function create(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      await api('/stores', { method: 'POST', body: { name, catalog } });
      setName('');
      load();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function retry(s: Store) {
    setError('');
    try {
      await api('/stores', { method: 'POST', body: { name: s.name } });
      load();
    } catch (err) {
      setError((err as Error).message);
    }
  }

  async function remove(s: Store) {
    if (!confirm(`Delete store "${s.name}"? Its website, database, orders and tools are removed for good.`)) return;
    try {
      await api(`/stores/${s.name}`, { method: 'DELETE' });
      load();
    } catch (err) {
      setError((err as Error).message);
    }
  }

  return (
    <>
      <header className="page-head">
        <h2>Stores</h2>
      </header>
      <p className="muted">
        Each store gets its own namespace, WordPress site, database and MCP server, with its own quota and limits. When it is
        ready, its tools appear for everyone as <code>&lt;name&gt;__list_orders</code> and so on. The built-in store is the <code>urumi</code>{' '}
        server.
      </p>
      {!enabled && <div className="error">Store provisioning is not enabled in this install.</div>}
      {enabled && (
        <form className="card form" onSubmit={create}>
          <div className="form-head">
            <h3>Add a store</h3>
            {limits && (
              <span className={`quota ${full ? 'full' : ''}`}>
                Your stores <strong className="tabular">{limits.mine} / {limits.per_user}</strong>
              </span>
            )}
          </div>
          <div className="row">
            <input
              placeholder='name, e.g. "bakery"'
              value={name}
              onChange={(e) => setName(e.target.value.toLowerCase())}
              pattern="[a-z][a-z0-9]{1,14}"
              title="2-15 lowercase letters or digits, starting with a letter"
              required
            />
            <select id="store-catalog" aria-label="Store type" value={catalog} onChange={(e) => setCatalog(e.target.value)}>
              {CATALOGS.map((c) => (
                <option key={c.value} value={c.value}>
                  {c.label}
                </option>
              ))}
            </select>
            <button disabled={busy || full}>{busy ? 'Starting…' : 'Create store'}</button>
          </div>
          <p className="muted small">
            {full
              ? `You have used all ${limits!.per_user} of your stores. Delete one to create another.`
              : 'Takes about 2–3 minutes. The name becomes its address and its tool prefix; the type picks its starter products.'}
          </p>
        </form>
      )}
      {error && <div className="error">{error}</div>}
      <table>
        <thead>
          <tr>
            <th>Store</th>
            <th>State</th>
            <th>MCP server</th>
            <th>Created</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {stores.length === 0 && (
            <tr>
              <td colSpan={5} className="muted">
                No extra stores yet.
              </td>
            </tr>
          )}
          {stores.map((s) => (
            <tr key={s.name}>
              <td>
                <strong>{s.name}</strong>
                {s.namespace && <div className="muted small">namespace {s.namespace}</div>}
                <div className="small">
                  <a href={s.url} target="_blank" rel="noreferrer">
                    storefront
                  </a>{' '}
                  ·{' '}
                  <a href={s.admin_url} target="_blank" rel="noreferrer">
                    wp-admin
                  </a>
                </div>
              </td>
              <td>
                <span className={`status ${STATE_CLASS[s.state]}`}>{STATE_LABEL[s.state]}</span>
                {s.message && <div className="muted small">{s.message}</div>}
              </td>
              <td>
                {s.server ? (
                  <>
                    <code>{s.server.slug}__*</code> <span className={`status ${s.server.status}`}>{s.server.status}</span>
                    <div className="muted small">{s.server.tools} tools</div>
                  </>
                ) : (
                  <span className="muted">{s.state === 'ready' ? 'registering…' : '—'}</span>
                )}
              </td>
              <td>
                {when(s.created_at)}
                {s.created_by && <div className="muted small">{s.created_by}</div>}
              </td>
              <td className="right">
                {s.can_manage && s.state === 'failed' && <button onClick={() => retry(s)}>Retry</button>}{' '}
                {s.can_manage && (s.state === 'ready' || s.state === 'failed') && (
                  <button className="danger" onClick={() => remove(s)}>
                    Delete
                  </button>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="muted small">
        wp-admin password for a store:{' '}
        <code>kubectl -n urumi-store-&lt;name&gt; get secret store-&lt;name&gt;-store-admin -o jsonpath='{'{.data.password}'}' | base64 -d</code>
      </p>
    </>
  );
}
