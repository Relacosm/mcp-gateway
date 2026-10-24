import { useEffect, useState } from 'react';
import { api, type Me, type Server } from './api';
import { ThemeToggle } from './theme';
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
  { id: 'stores', label: 'Stores' },
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

  if (me === undefined) return <div className="center muted">Loading_</div>;
  if (me === null) return <Login onLogin={setMe} />;

  const isAdmin = me.role === 'admin';
  // Members never see admin pages; the backend rejects them as well.
  const visible = PAGES.filter((p) => !p.adminOnly || isAdmin);
  const active = visible.some((p) => p.id === page) ? page : 'chat';

  async function logout() {
    await api('/auth/logout', { method: 'POST' }).catch(() => undefined);
    setMe(null);
  }

  const index = visible.findIndex((p) => p.id === active);

  return (
    <div className="shell">
      <nav className="sidebar">
        <div className="brand">MCP Gateway</div>
        {visible.map((p, i) => (
          <a key={p.id} href={`#${p.id}`} className={p.id === active ? 'active' : ''}>
            <span>
              <span className="nav-no">{String(i + 1).padStart(2, '0')}</span>
              {p.label}
            </span>
          </a>
        ))}
        <div className="whoami">
          <ThemeToggle />
          <div>{me.email}</div>
          <div className="row">
            <span className={`badge ${isAdmin ? 'admin' : ''}`}>{me.role}</span>
            <button className="link" onClick={logout}>
              Log out
            </button>
          </div>
        </div>
      </nav>
      <div className="content">
        <TopBar crumb={visible[index]?.label ?? ''} index={index + 1} total={visible.length} />
        <main>
          {active === 'chat' && <Chat me={me} />}
          {active === 'servers' && <Servers isAdmin={isAdmin} />}
          {active === 'stores' && <Stores />}
          {active === 'keys' && <Keys me={me} />}
          {active === 'audit' && <Audit isAdmin={isAdmin} />}
          {active === 'members' && isAdmin && <Members me={me} />}
        </main>
      </div>
    </div>
  );
}

/** A thin readout: where you are, how many upstreams are up, and the time. */
function TopBar({ crumb, index, total }: { crumb: string; index: number; total: number }) {
  const [servers, setServers] = useState<Server[] | null>(null);
  const [now, setNow] = useState(() => new Date());

  useEffect(() => {
    const load = () => api<Server[]>('/servers').then(setServers).catch(() => setServers(null));
    load();
    const poll = setInterval(load, 10_000);
    const tick = setInterval(() => setNow(new Date()), 1000);
    return () => {
      clearInterval(poll);
      clearInterval(tick);
    };
  }, []);

  const enabled = servers?.filter((s) => s.status !== 'disabled') ?? [];
  const up = enabled.filter((s) => s.status === 'connected').length;
  const tools = enabled.reduce((n, s) => n + (s.status === 'connected' ? s.tools.length : 0), 0);
  const health = !servers ? 'pending' : up === enabled.length ? 'connected' : 'unreachable';

  return (
    <header className="topbar">
      <span>
        <span className="muted">
          {String(index).padStart(2, '0')}/{String(total).padStart(2, '0')}
        </span>{' '}
        {crumb}
      </span>
      <span className="topbar-stats">
        <span className={`status ${health}`}>
          {servers ? `${up}/${enabled.length} upstreams` : 'connecting'}
        </span>
        <span className="muted">{tools} tools</span>
        <span className="muted tabular">{now.toLocaleTimeString([], { hour12: false })}</span>
      </span>
    </header>
  );
}
