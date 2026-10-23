import { useEffect, useState } from 'react';
import { api, type Me } from './api';
import { Login } from './pages/Login';
import { Servers } from './pages/Servers';
import { Members } from './pages/Members';
import { Keys } from './pages/Keys';
import { Audit } from './pages/Audit';
import { Chat } from './pages/Chat';
import { Stores } from './pages/Stores';

type Page = 'chat' | 'servers' | 'stores' | 'keys' | 'audit' | 'members';

const PAGES: { id: Page; label: string; adminOnly?: boolean }[] = [
  { id: 'chat', label: 'Chat' },
  { id: 'servers', label: 'Servers' },
  { id: 'stores', label: 'Stores', adminOnly: true },
  { id: 'keys', label: 'API keys' },
  { id: 'audit', label: 'Audit log' },
  { id: 'members', label: 'Members', adminOnly: true },
];

function currentPage(): Page {
  const id = location.hash.slice(1) as Page;
  return PAGES.some((p) => p.id === id) ? id : 'chat';
}

export function App() {
  const [me, setMe] = useState<Me | null | undefined>(undefined);
  const [page, setPage] = useState<Page>(currentPage);

  useEffect(() => {
    api<Me>('/auth/me')
      .then(setMe)
      .catch(() => setMe(null));
    const onHash = () => setPage(currentPage());
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);

  if (me === undefined) return <div className="center muted">Loading…</div>;
  if (me === null) return <Login onLogin={setMe} />;

  const isAdmin = me.role === 'admin';
  // Members never see admin pages; the backend rejects them as well.
  const visible = PAGES.filter((p) => !p.adminOnly || isAdmin);
  const active = visible.some((p) => p.id === page) ? page : 'chat';

  async function logout() {
    await api('/auth/logout', { method: 'POST' }).catch(() => undefined);
    setMe(null);
  }

  return (
    <div className="shell">
      <nav className="sidebar">
        <div className="brand">MCP Gateway</div>
        {visible.map((p) => (
          <a key={p.id} href={`#${p.id}`} className={p.id === active ? 'active' : ''}>
            {p.label}
          </a>
        ))}
        <div className="whoami">
          <div>{me.email}</div>
          <span className={`badge ${isAdmin ? 'admin' : ''}`}>{me.role}</span>
          <button className="link" onClick={logout}>
            Log out
          </button>
        </div>
      </nav>
      <main>
        {active === 'chat' && <Chat me={me} />}
        {active === 'servers' && <Servers isAdmin={isAdmin} />}
        {active === 'stores' && isAdmin && <Stores />}
        {active === 'keys' && <Keys me={me} />}
        {active === 'audit' && <Audit isAdmin={isAdmin} />}
        {active === 'members' && isAdmin && <Members me={me} />}
      </main>
    </div>
  );
}
