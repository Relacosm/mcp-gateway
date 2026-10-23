import { useCallback, useEffect, useState } from 'react';
import { api, when, type AuditRow, type Member, type Server } from '../api';

export function Audit({ isAdmin }: { isAdmin: boolean }) {
  const [rows, setRows] = useState<AuditRow[]>([]);
  const [members, setMembers] = useState<Member[]>([]);
  const [servers, setServers] = useState<Server[]>([]);
  const [userId, setUserId] = useState('');
  const [server, setServer] = useState('');
  const [error, setError] = useState('');

  useEffect(() => {
    if (isAdmin) api<Member[]>('/members').then(setMembers).catch(() => undefined);
    api<Server[]>('/servers').then(setServers).catch(() => undefined);
  }, [isAdmin]);

  const load = useCallback(() => {
    const params = new URLSearchParams();
    if (userId) params.set('user_id', userId);
    if (server) params.set('server', server);
    api<AuditRow[]>(`/audit?${params}`)
      .then((r) => {
        setRows(r);
        setError('');
      })
      .catch((err) => setError(err.message));
  }, [userId, server]);

  useEffect(() => {
    load();
    const t = setInterval(load, 5000);
    return () => clearInterval(t);
  }, [load]);

  return (
    <>
      <header className="page-head">
        <h2>Audit log</h2>
        <div className="row">
          {isAdmin && (
            <select value={userId} onChange={(e) => setUserId(e.target.value)}>
              <option value="">All users</option>
              {members.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.email}
                </option>
              ))}
            </select>
          )}
          <select value={server} onChange={(e) => setServer(e.target.value)}>
            <option value="">All servers</option>
            {servers.map((s) => (
              <option key={s.id} value={s.slug}>
                {s.name}
              </option>
            ))}
          </select>
        </div>
      </header>
      {!isAdmin && <p className="muted">Your own tool calls.</p>}
      {error && <div className="error">{error}</div>}
      <table>
        <thead>
          <tr>
            <th>Time</th>
            <th>User</th>
            <th>Server</th>
            <th>Tool</th>
            <th>Via</th>
            <th className="right">ms</th>
            <th>Outcome</th>
          </tr>
        </thead>
        <tbody>
          {rows.length === 0 && (
            <tr>
              <td colSpan={7} className="muted">
                No calls yet.
              </td>
            </tr>
          )}
          {rows.map((r) => (
            <tr key={r.id}>
              <td>{when(r.created_at)}</td>
              <td>{r.user_email}</td>
              <td>{r.server_slug ?? '—'}</td>
              <td>
                <code>{r.tool}</code>
              </td>
              <td>{r.source}</td>
              <td className="right">{r.duration_ms}</td>
              <td>
                <span className={`status ${r.outcome === 'ok' ? 'connected' : 'unreachable'}`}>{r.outcome}</span>
                {r.error && <div className="muted small">{r.error}</div>}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </>
  );
}
