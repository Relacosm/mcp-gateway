import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { api, when, type Me, type Member, type Role } from '../api';

export function Members({ me }: { me: Me }) {
  const [members, setMembers] = useState<Member[]>([]);
  const [error, setError] = useState('');
  const [form, setForm] = useState({ email: '', name: '', password: '', role: 'member' as Role });

  const load = useCallback(() => {
    api<Member[]>('/members').then(setMembers).catch((err) => setError(err.message));
  }, []);
  useEffect(load, [load]);

  async function invite(e: FormEvent) {
    e.preventDefault();
    setError('');
    try {
      await api('/members', { method: 'POST', body: form });
      setForm({ email: '', name: '', password: '', role: 'member' });
      load();
    } catch (err) {
      setError((err as Error).message);
    }
  }

  async function remove(m: Member) {
    if (!confirm(`Remove ${m.email}? Their API keys stop working at once.`)) return;
    try {
      await api(`/members/${m.id}`, { method: 'DELETE' });
      load();
    } catch (err) {
      setError((err as Error).message);
    }
  }

  return (
    <>
      <header className="page-head">
        <h2>Members</h2>
      </header>
      <form className="card form" onSubmit={invite}>
        <h3>Invite a member</h3>
        <div className="grid4">
          <input type="email" placeholder="email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} required />
          <input placeholder="name" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
          <input
            type="text"
            placeholder="initial password (8+ chars)"
            minLength={8}
            value={form.password}
            onChange={(e) => setForm({ ...form, password: e.target.value })}
            required
          />
          <select value={form.role} onChange={(e) => setForm({ ...form, role: e.target.value as Role })}>
            <option value="member">member</option>
            <option value="admin">admin</option>
          </select>
        </div>
        <button>Invite</button>
      </form>
      {error && <div className="error">{error}</div>}
      <table>
        <thead>
          <tr>
            <th>Email</th>
            <th>Name</th>
            <th>Role</th>
            <th>Joined</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {members.map((m) => (
            <tr key={m.id}>
              <td>{m.email}</td>
              <td>{m.name}</td>
              <td>
                <span className={`badge ${m.role === 'admin' ? 'admin' : ''}`}>{m.role}</span>
              </td>
              <td>{when(m.created_at)}</td>
              <td className="right">
                {m.id !== me.id && (
                  <button className="danger" onClick={() => remove(m)}>
                    Remove
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
