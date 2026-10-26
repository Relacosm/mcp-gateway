import type { ReactNode } from 'react';

/**
 * The small Markdown subset LLM replies use: paragraphs, headings, lists,
 * tables, code blocks, **bold**, *italic* and `code`. It builds React elements and
 * never sets HTML, because replies can quote untrusted tool output.
 */
export function Markdown({ text }: { text: string }) {
  return <div className="md">{blocks(text)}</div>;
}

function blocks(text: string): ReactNode[] {
  const out: ReactNode[] = [];
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  let para: string[] = [];
  let list: { ordered: boolean; items: string[] } | null = null;

  const flushPara = () => {
    if (para.length) out.push(<p key={out.length}>{joinLines(para)}</p>);
    para = [];
  };
  const flushList = () => {
    if (!list) return;
    const items = list.items.map((item, i) => <li key={i}>{inline(item)}</li>);
    out.push(list.ordered ? <ol key={out.length}>{items}</ol> : <ul key={out.length}>{items}</ul>);
    list = null;
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (/^\s*```/.test(line)) {
      flushPara();
      flushList();
      const code: string[] = [];
      while (++i < lines.length && !/^\s*```/.test(lines[i])) code.push(lines[i]);
      out.push(
        <pre key={out.length}>
          <code>{code.join('\n')}</code>
        </pre>,
      );
      continue;
    }
    if (isRow(line) && i + 1 < lines.length && SEPARATOR.test(lines[i + 1])) {
      flushPara();
      flushList();
      const right = cells(lines[i + 1]).map((c) => /-:$/.test(c));
      const head = cells(line);
      const body: string[][] = [];
      i += 2;
      while (i < lines.length && isRow(lines[i])) body.push(cells(lines[i++]));
      i--;
      const cls = (col: number) => (right[col] ? 'num' : undefined);
      out.push(
        <div className="table-wrap" key={out.length}>
          <table>
            <thead>
              <tr>
                {head.map((c, j) => (
                  <th key={j} className={cls(j)}>
                    {inline(c)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {body.map((row, r) => (
                <tr key={r}>
                  {head.map((_, j) => (
                    <td key={j} className={cls(j)}>
                      {inline(row[j] ?? '')}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>,
      );
      continue;
    }
    const heading = /^\s*#{1,6}\s+(.*)$/.exec(line);
    const bullet = /^\s*[-*•]\s+(.*)$/.exec(line);
    const numbered = /^\s*\d+[.)]\s+(.*)$/.exec(line);
    if (heading) {
      flushPara();
      flushList();
      out.push(<h4 key={out.length}>{inline(heading[1])}</h4>);
    } else if (bullet || numbered) {
      flushPara();
      const ordered = Boolean(numbered);
      if (list && list.ordered !== ordered) flushList();
      list ??= { ordered, items: [] };
      list.items.push((bullet ?? numbered)![1]);
    } else if (!line.trim()) {
      flushPara();
      flushList();
    } else if (list && /^\s{2,}\S/.test(line)) {
      // An indented line continues the previous list item.
      list.items[list.items.length - 1] += ` ${line.trim()}`;
    } else {
      flushList();
      para.push(line);
    }
  }
  flushPara();
  flushList();
  return out;
}

// Pipe tables: a header row, a |---|:--:| separator, then body rows.
const SEPARATOR = /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/;

function isRow(line: string): boolean {
  return /^\s*\|.*\|\s*$/.test(line);
}

function cells(line: string): string[] {
  return line.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((c) => c.trim());
}

function joinLines(lines: string[]): ReactNode[] {
  return lines.flatMap((l, i) => (i ? [<br key={`br${i}`} />, ...inline(l, `l${i}`)] : inline(l, `l${i}`)));
}

// Links: [text](url) or a bare URL. Only http(s), so a reply cannot carry a javascript: link.
const MD_LINK = /^\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)$/;
const BARE_URL = /^https?:\/\/\S+$/;

function link(href: string, label: ReactNode, key: string): ReactNode {
  return (
    <a key={key} href={href} target="_blank" rel="noreferrer noopener">
      {label}
    </a>
  );
}

function inline(text: string, keyPrefix = ''): ReactNode[] {
  const parts = text.split(/(`[^`]+`|\[[^\]]+\]\(https?:\/\/[^\s)]+\)|https?:\/\/[^\s<>()`*]+|\*\*[^*]+\*\*|__[^_]+__|\*[^*\s][^*]*\*)/g);
  return parts.flatMap((part, i) => {
    const key = `${keyPrefix}${i}`;
    if (/^`[^`]+`$/.test(part)) {
      const code = part.slice(1, -1);
      return BARE_URL.test(code) ? link(code, <code>{code}</code>, key) : <code key={key}>{code}</code>;
    }
    const md = MD_LINK.exec(part);
    if (md) return link(md[2], md[1], key);
    if (BARE_URL.test(part)) {
      // A sentence's closing punctuation is not part of the URL.
      const [, url, tail] = /^(.*?)([.,;:!?]*)$/.exec(part)!;
      return [link(url, url, key), tail];
    }
    if (/^(\*\*|__).+\1$/.test(part)) return <strong key={key}>{inline(part.slice(2, -2), `${key}-`)}</strong>;
    if (/^\*[^*\s][^*]*\*$/.test(part)) return <em key={key}>{part.slice(1, -1)}</em>;
    return part;
  });
}
