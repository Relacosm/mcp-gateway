import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { api, when, type ApiKey, type Me } from '../api';

export function Keys({ me }: { me: Me }) {
  const isAdmin = me.role === 'admin';
  const [keys, setKeys] = useState<ApiKey[]>([]);
  const [all, setAll] = useState(false);
  const [name, setName] = useState('');
  const [created, setCreated] = useState<string | null>(null);
  const [error, setError] = useState('');
  const mcpUrl = `${location.origin}/mcp`;

  const load = useCallback(() => {
    api<ApiKey[]>(`/keys${all ? '?all=1' : ''}`).then(setKeys).catch((err) => setError(err.message));
  }, [all]);
  useEffect(load, [load]);

  async function create(e: FormEvent) {
    e.preventDefault();
    setError('');
    try {
      const res = await api<{ key: string }>('/keys', { method: 'POST', body: { name } });
      setCreated(res.key);
      setName('');
      load();
    } catch (err) {
      setError((err as Error).message);
    }
  }

  async function revoke(k: ApiKey) {
    if (!confirm(`Revoke "${k.name}"? Clients using it are rejected on their next call.`)) return;
    try {
      await api(`/keys/${k.id}`, { method: 'DELETE' });
      load();
    } catch (err) {
      setError((err as Error).message);
    }
  }

  return (
    <>
      <header className="page-head">
        <h2>API keys</h2>
      </header>

      <div className="card">
        <h3>Connect an MCP client</h3>
        <p className="muted">
          One URL for every server's tools. Authenticate with your own key as a bearer token.
        </p>
        <pre>{mcpUrl}</pre>
        <p className="muted small">Claude Code:</p>
        <pre>{`claude mcp add --transport http team-gateway ${mcpUrl} --header "Authorization: Bearer <your key>"`}</pre>
      </div>

      <form className="card form" onSubmit={create}>
        <h3>Create a key</h3>
        <div className="row">
          <input placeholder='name, e.g. "laptop"' value={name} onChange={(e) => setName(e.target.value)} required />
          <button>Create</button>
        </div>
        {created && (
          <div className="reveal">
            <strong>Copy this key now. It will not be shown again.</strong>
            <pre>{created}</pre>
            <div className="row">
              <button type="button" onClick={() => navigator.clipboard?.writeText(created)}>
                Copy
              </button>
              <button type="button" className="secondary" onClick={() => setCreated(null)}>
                Done
              </button>
            </div>
          </div>
        )}
      </form>

      {error && <div className="error">{error}</div>}
      {isAdmin && (
        <label className="check">
          <input type="checkbox" checked={all} onChange={(e) => setAll(e.target.checked)} /> Show every member's keys
        </label>
      )}
      <table>
        <thead>
          <tr>
            <th>Name</th>
            <th>Key</th>
            {all && <th>Owner</th>}
            <th>Created</th>
            <th>Last used</th>
            <th>Status</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {keys.map((k) => (
            <tr key={k.id} className={k.revoked_at ? 'dim' : ''}>
              <td>{k.name}</td>
              <td>
                <code>{k.prefix}…</code>
              </td>
              {all && <td>{k.user_email}</td>}
              <td>{when(k.created_at)}</td>
              <td>{when(k.last_used_at)}</td>
              <td>{k.revoked_at ? `revoked ${when(k.revoked_at)}` : 'active'}</td>
              <td className="right">
                {!k.revoked_at && (
                  <button className="danger" onClick={() => revoke(k)}>
                    Revoke
                  </button>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </>
  );
}
