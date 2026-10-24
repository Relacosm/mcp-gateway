import { useState, type FormEvent } from 'react';
import { api, type Me } from '../api';
import { ThemeToggle } from '../theme';

export function Login({ onLogin }: { onLogin: (me: Me) => void }) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      onLogin(await api<Me>('/auth/login', { method: 'POST', body: { email, password } }));
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="center login-page">
      <div className="login-corner">
        <ThemeToggle />
      </div>
      <form className="login" onSubmit={submit}>
        <header className="login-head">
          <span>MCP Gateway</span>
          <span className="muted">Sign in</span>
        </header>
        <div className="login-body">
          <label>
            Email
            <input type="email" placeholder="you@team.com" value={email} onChange={(e) => setEmail(e.target.value)} autoFocus required />
          </label>
          <label>
            Password
            <div className="row">
              <input type="password" placeholder="••••••••" value={password} onChange={(e) => setPassword(e.target.value)} required />
              <button disabled={busy}>{busy ? '…' : 'Enter'}</button>
            </div>
          </label>
          {error && <div className="error">{error}</div>}
        </div>
        <footer className="login-foot muted">One URL · your own key · every tool</footer>
      </form>
    </div>
  );
}
