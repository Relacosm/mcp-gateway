import { useEffect, useRef, useState, type FormEvent } from 'react';
import { api, type Me } from '../api';

interface Step {
  tool: string;
  arguments: unknown;
  result: string;
  isError: boolean;
}

interface Entry {
  role: 'user' | 'assistant';
  content: string;
  steps?: Step[];
  error?: boolean;
}

const STORAGE_KEY = 'chat-history';

const SUGGESTIONS = [
  'Create a product called Desk Lamp for 499',
  'What orders came in today?',
  "List today's orders and convert the total to USD",
  "Compare today's orders across all stores",
];

function loadHistory(): Entry[] {
  try {
    return JSON.parse(sessionStorage.getItem(STORAGE_KEY) ?? '[]') as Entry[];
  } catch {
    return [];
  }
}

function StepCard({ step }: { step: Step }) {
  const [open, setOpen] = useState(false);
  return (
    <div className={`step ${step.isError ? 'failed' : ''}`}>
      <button className="link" onClick={() => setOpen(!open)}>
        {open ? '▾' : '▸'} <code>{step.tool}</code> {step.isError ? 'failed' : 'ok'}
      </button>
      {open && (
        <>
          <div className="muted small">arguments</div>
          <pre>{JSON.stringify(step.arguments, null, 2)}</pre>
          <div className="muted small">{step.isError ? 'error' : 'result'}</div>
          <pre>{step.result}</pre>
        </>
      )}
    </div>
  );
}

export function Chat({ me }: { me: Me }) {
  const [entries, setEntries] = useState<Entry[]>(loadHistory);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [tools, setTools] = useState<string[]>([]);
  const bottom = useRef<HTMLDivElement>(null);

  useEffect(() => {
    api<{ name: string }[]>('/tools')
      .then((t) => setTools(t.map((x) => x.name)))
      .catch(() => undefined);
  }, []);

  useEffect(() => {
    try {
      sessionStorage.setItem(STORAGE_KEY, JSON.stringify(entries));
    } catch {
      // storage unavailable; history just won't survive a reload
    }
    bottom.current?.scrollIntoView({ behavior: 'smooth' });
  }, [entries]);

  async function send(e: FormEvent) {
    e.preventDefault();
    const text = input.trim();
    if (!text || busy) return;
    const next: Entry[] = [...entries, { role: 'user', content: text }];
    setEntries(next);
    setInput('');
    setBusy(true);
    try {
      // Only the text of earlier turns goes back; tool steps stay in the UI.
      const messages = next.filter((m) => !m.error).map((m) => ({ role: m.role, content: m.content }));
      const res = await api<{ reply: string; steps: Step[] }>('/chat', { method: 'POST', body: { messages: messages.slice(-20) } });
      setEntries([...next, { role: 'assistant', content: res.reply || '(no answer)', steps: res.steps }]);
    } catch (err) {
      setEntries([...next, { role: 'assistant', content: (err as Error).message, error: true }]);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="chat">
      <header className="page-head">
        <h2>Chat</h2>
        <div className="row">
          <span className="muted small">
            as {me.email} · {tools.length} tools available
          </span>
          {entries.length > 0 && (
            <button className="secondary" onClick={() => setEntries([])}>
              Clear
            </button>
          )}
        </div>
      </header>
      <div className="messages">
        {entries.length === 0 && (
          <div className="empty">
            <div className="empty-title">Ask anything a tool can answer</div>
            <p className="muted small">Every call runs as you, through the gateway, and lands in the audit log.</p>
            <div className="suggestions">
              {SUGGESTIONS.map((q, i) => (
                <button key={q} className="suggestion" onClick={() => setInput(q)}>
                  <span className="nav-no">{String(i + 1).padStart(2, '0')}</span>
                  {q}
                  <span className="arrow">→</span>
                </button>
              ))}
            </div>
          </div>
        )}
        {entries.map((m, i) => (
          <div key={i} className={`msg ${m.role} ${m.error ? 'err' : ''}`}>
            {m.steps && m.steps.length > 0 && (
              <div className="steps">
                {m.steps.map((s, j) => (
                  <StepCard key={j} step={s} />
                ))}
              </div>
            )}
            <div className="bubble">{m.content}</div>
          </div>
        ))}
        {busy && (
          <div className="msg assistant">
            <div className="thinking">Calling tools</div>
          </div>
        )}
        <div ref={bottom} />
      </div>
      <form className="composer" onSubmit={send}>
        <span className="prompt">&gt;</span>
        <input value={input} onChange={(e) => setInput(e.target.value)} placeholder="Ask something that needs a tool…" disabled={busy} autoFocus />
        <button disabled={busy || !input.trim()}>Send</button>
      </form>
    </div>
  );
}
