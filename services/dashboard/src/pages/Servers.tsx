import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { api, when, type Metrics, type Server } from '../api';

type AuthType = Server['auth_type'];

interface FormState {
  name: string;
  slug: string;
  url: string;
  auth_type: AuthType;
  auth_header: string;
  credential: string;
  members_read_only: boolean;
}

const EMPTY: FormState = { name: '', slug: '', url: '', auth_type: 'none', auth_header: '', credential: '', members_read_only: true };

function ServerForm({ server, onDone }: { server?: Server; onDone: () => void }) {
  const [form, setForm] = useState<FormState>(
    server
      ? {
          ...EMPTY,
          name: server.name,
          slug: server.slug,
          url: server.url,
          auth_type: server.auth_type,
          auth_header: server.auth_header ?? '',
          members_read_only: server.members_read_only,
        }
      : EMPTY,
  );
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const set = (k: keyof FormState) => (e: { target: { value: string } }) => setForm({ ...form, [k]: e.target.value });

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError('');
    const body: Record<string, unknown> = {
      name: form.name,
      url: form.url,
      auth_type: form.auth_type,
      auth_header: form.auth_type === 'header' ? form.auth_header : null,
      members_read_only: form.members_read_only,
    };
    // Blank credential on edit = keep the stored one.
    if (form.credential) body.credential = form.credential;
    try {
      if (server) await api(`/servers/${server.id}`, { method: 'PATCH', body });
      else await api('/servers', { method: 'POST', body: { ...body, slug: form.slug } });
      onDone();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="card form" onSubmit={submit}>
      <h3>{server ? `Edit ${server.name}` : 'Add a server'}</h3>
      <div className="grid2">
        <label>
          Name
          <input value={form.name} onChange={set('name')} required />
        </label>
        <label>
          Slug <small>(tool prefix, e.g. "bakery")</small>
          <input value={form.slug} onChange={set('slug')} required disabled={Boolean(server)} pattern="[a-z0-9]+(-[a-z0-9]+)*" />
        </label>
      </div>
      <label>
        MCP URL (Streamable HTTP)
        <input type="url" value={form.url} onChange={set('url')} placeholder="https://example.com/mcp" required />
      </label>
      <div className="grid2">
        <label>
          Credential type
          <select value={form.auth_type} onChange={set('auth_type')}>
            <option value="none">None</option>
            <option value="bearer">Bearer token</option>
            <option value="header">Custom header</option>
          </select>
        </label>
        {form.auth_type === 'header' && (
          <label>
            Header name
            <input value={form.auth_header} onChange={set('auth_header')} placeholder="X-API-Key" required />
          </label>
        )}
      </div>
      {form.auth_type !== 'none' && (
        <label>
          Credential{' '}
          <small>{server?.has_credential ? '(stored; leave blank to keep it)' : '(write-only, stored encrypted)'}</small>
          <input type="password" value={form.credential} onChange={set('credential')} autoComplete="off" required={!server?.has_credential} />
        </label>
      )}
      <label className="check">
        <input
          type="checkbox"
          checked={form.members_read_only}
          onChange={(e) => setForm({ ...form, members_read_only: e.target.checked })}
        />
        Members may only use read-only tools (writes are for admins and, on a store, its owner)
      </label>
      {error && <div className="error">{error}</div>}
      <div className="row">
        <button disabled={busy}>{busy ? 'Saving…' : 'Save'}</button>
        <button type="button" className="secondary" onClick={onDone}>
          Cancel
        </button>
      </div>
    </form>
  );
}

export function Servers({ isAdmin }: { isAdmin: boolean }) {
  const [servers, setServers] = useState<Server[]>([]);
  const [metrics, setMetrics] = useState<Metrics | null>(null);
  const [error, setError] = useState('');
  const [editing, setEditing] = useState<Server | 'new' | null>(null);
  const [open, setOpen] = useState<Record<number, boolean>>({});

  const load = useCallback(() => {
    api<Server[]>('/servers')
      .then((s) => {
        setServers(s);
        setError('');
      })
      .catch((err) => setError(err.message));
    api<Metrics>('/metrics')
      .then(setMetrics)
      .catch(() => undefined);
  }, []);

  useEffect(() => {
    load();
    const t = setInterval(load, 5000);
    return () => clearInterval(t);
  }, [load]);

  // "Check now": button state while it runs, then the outcome for a few seconds.
  const [checking, setChecking] = useState<Record<number, boolean>>({});
  const [checked, setChecked] = useState<Record<number, { ok: boolean; text: string }>>({});

  async function checkNow(s: Server) {
    setChecking((c) => ({ ...c, [s.id]: true }));
    setChecked((c) => {
      const { [s.id]: _, ...rest } = c;
      return rest;
    });
    let result: { ok: boolean; text: string };
    try {
      const r = await api<Server | null>(`/servers/${s.id}/refresh`, { method: 'POST' });
      result = !r
        ? { ok: false, text: 'server not found' }
        : r.status === 'connected'
          ? { ok: true, text: `connected · ${r.tools.length} tools` }
          : { ok: false, text: r.error ? `${r.status}: ${r.error}` : r.status };
    } catch (err) {
      result = { ok: false, text: (err as Error).message };
    }
    setChecking((c) => ({ ...c, [s.id]: false }));
    setChecked((c) => ({ ...c, [s.id]: result }));
    load();
    setTimeout(() => setChecked((c) => (c[s.id] === result ? (({ [s.id]: _, ...rest }) => rest)(c) : c)), 6000);
  }

  async function act(fn: () => Promise<unknown>) {
    try {
      await fn();
      load();
    } catch (err) {
      setError((err as Error).message);
    }
  }

  return (
    <>
      <header className="page-head">
        <h2>Servers</h2>
        {isAdmin && !editing && <button onClick={() => setEditing('new')}>Add server</button>}
      </header>
      {error && <div className="error">{error}</div>}
      {editing && (
        <ServerForm
          server={editing === 'new' ? undefined : editing}
          onDone={() => {
            setEditing(null);
            load();
          }}
        />
      )}
      {servers.length === 0 && <p className="muted">No servers registered yet.</p>}
      {servers.map((s) => (
        <div key={s.id} className="card server">
          <div className="server-head">
            <div>
              <div className="server-name">
                {s.name} <code>{s.slug}__*</code>
              </div>
              <div className="muted small">
                {s.url} · credential: {s.auth_type === 'none' ? 'none' : s.has_credential ? `${s.auth_type} (stored)` : 'missing'} ·
                checked {when(s.checked_at)}
              </div>
            </div>
            <span className={`status ${s.status}`}>{s.status}</span>
          </div>
          {s.error && <div className="error small">{s.error}</div>}
          <div className="metrics small">
            {(() => {
              const m = metrics?.servers[s.slug];
              const limited = metrics?.rate_limited[s.slug] ?? 0;
              return (
                <>
                  <span>calls 24h: {m?.calls ?? 0}</span>
                  <span>errors: {m?.errors ?? 0}</span>
                  <span>avg: {m?.avg_ms ?? '—'} ms</span>
                  <span>p95: {m?.p95_ms ?? '—'} ms</span>
                  {limited > 0 && <span>rate-limited: {limited}</span>}
                  {s.members_read_only && <span className="badge">members: read-only</span>}
                </>
              );
            })()}
          </div>
          <div className="row">
            <button className="link" onClick={() => setOpen({ ...open, [s.id]: !open[s.id] })}>
              {open[s.id] ? 'Hide' : 'Show'} {s.tools.length} tools
            </button>
            {isAdmin && (
              <>
                <button className="secondary" onClick={() => act(() => api(`/servers/${s.id}`, { method: 'PATCH', body: { enabled: !s.enabled } }))}>
                  {s.enabled ? 'Disable' : 'Enable'}
                </button>
                <button className="secondary" onClick={() => checkNow(s)} disabled={checking[s.id]}>
                  {checking[s.id] ? 'Checking…' : 'Check now'}
                </button>
                <button className="secondary" onClick={() => setEditing(s)}>
                  Edit
                </button>
                <button
                  className="danger"
                  onClick={() => confirm(`Remove ${s.name}? Its tools disappear for everyone.`) && act(() => api(`/servers/${s.id}`, { method: 'DELETE' }))}
                >
                  Remove
                </button>
              </>
            )}
          </div>
          {checked[s.id] && (
            <div className={`check-result small ${checked[s.id].ok ? 'ok' : 'bad'}`} role="status">
              {checked[s.id].ok ? '✓' : '✕'} Checked just now · {checked[s.id].text}
            </div>
          )}
          {open[s.id] && (
            <ul className="tools">
              {s.tools.map((t) => (
                <li key={t.name}>
                  <code>
                    {s.slug}__{t.name}
                  </code>{' '}
                  {t.read_only ? <span className="badge">read</span> : <span className="badge admin">write</span>}{' '}
                  {t.labeled_by === 'admin' && <span className="muted small">(labeled by an admin)</span>}{' '}
                  {isAdmin && (
                    <button
                      className="link small"
                      title={
                        t.labeled_by === 'admin'
                          ? "Go back to the server's own label"
                          : 'Correct this label if the server reports it wrongly'
                      }
                      onClick={() =>
                        act(() =>
                          api(`/servers/${s.id}/tools/${encodeURIComponent(t.name)}`, {
                            method: 'PUT',
                            body: { access: t.labeled_by === 'admin' ? null : t.read_only ? 'write' : 'read' },
                          }),
                        )
                      }
                    >
                      {t.labeled_by === 'admin' ? 'reset' : t.read_only ? 'mark as write' : 'mark as read'}
                    </button>
                  )}{' '}
                  <span className="muted">{t.description}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
      ))}
    </>
  );
}
