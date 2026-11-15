// 最小的 Markdown 显示：标题（### 起）、段落、有序和无序列表（列表项下缩进的子列表）、表格、加粗、行内代码、链接。
// 只认这几种，别的原样当文字显示；不拼 HTML，全部走 React 元素。使用说明页显示 docs/使用手册.md 用。
import type { ReactNode } from 'react';

type Item = { text: string; children: string[] };
type Block =
  | { kind: 'heading'; level: number; text: string }
  | { kind: 'paragraph'; text: string }
  | { kind: 'list'; ordered: boolean; items: Item[] }
  | { kind: 'table'; head: string[]; rows: string[][] };

// 文字部分写成“非空白开头或者什么都没有”，和前面的空白不重叠，不会回溯爆炸
const listItem = /^(\s*)([-*]|\d+\.)\s+(\S.*|)$/;
const headingLine = /^(#{1,6})\s+(\S.*|)$/;
/** 表格表头下面那一行（| --- | :-: |） */
const tableRule = /^(?:\s*\|[\s:-]+|[\s:-]+)\|/;
const cells = (line: string) => line.trim().replace(/^\||\|$/g, '').split('|').map((c) => c.trim());

/** 从第 start 行起读一块：返回这一块和下一块从哪一行开始 */
type Read = { block: Block; next: number };

/** 表格：表头、分隔行，下面连着的 | 开头的行 */
function readTable(lines: string[], start: number): Read {
  const head = cells(lines[start]),
    rows: string[][] = [];
  let i = start + 2;
  for (; i < lines.length && lines[i].trim().startsWith('|'); i++) rows.push(cells(lines[i]));
  return { block: { kind: 'table', head, rows }, next: i };
}

/** 列表：到空行为止；缩进的列表项算上一项的子项，不是列表项的行接到上一项后面 */
function readList(lines: string[], start: number, ordered: boolean): Read {
  const items: Item[] = [];
  let i = start;
  for (; i < lines.length && lines[i].trim(); i++) {
    const m = listItem.exec(lines[i]);
    const last = items.at(-1);
    if (m && !m[1]) items.push({ text: m[3], children: [] });
    else if (m && last) last.children.push(m[3]);
    else if (last) last.text += ' ' + lines[i].trim();
  }
  return { block: { kind: 'list', ordered, items }, next: i };
}

/** 段落：连着的文字行并成一段，碰到标题、表格、列表停 */
function readParagraph(lines: string[], start: number): Read {
  let text = lines[start].trim(),
    i = start + 1;
  for (; i < lines.length && lines[i].trim() && !/^(#|\||\s*([-*]|\d+\.)\s)/.test(lines[i]); i++)
    text += ' ' + lines[i].trim();
  return { block: { kind: 'paragraph', text }, next: i };
}

/** 一块：标题、表格、列表或段落 */
function readBlock(lines: string[], start: number): Read {
  const line = lines[start];
  const heading = headingLine.exec(line);
  if (heading) return { block: { kind: 'heading', level: heading[1].length, text: heading[2] }, next: start + 1 };
  if (line.trim().startsWith('|') && tableRule.test(lines[start + 1] ?? '')) return readTable(lines, start);
  const first = listItem.exec(line);
  if (first && !first[1]) return readList(lines, start, /\d/.test(first[2]));
  return readParagraph(lines, start);
}

/** 按行切成块：空行分段，连着的文字行并成一段 */
export function parseMarkdown(source: string): Block[] {
  const blocks: Block[] = [];
  const lines = source.replace(/\r\n/g, '\n').split('\n');
  for (let i = 0; i < lines.length; ) {
    if (!lines[i].trim()) {
      i++;
      continue;
    }
    const { block, next } = readBlock(lines, i);
    blocks.push(block);
    i = next;
  }
  return blocks;
}

/** 行内：**加粗**、`代码`、[文字](地址)。站内文件（.md 之类的相对地址）只显示文字 */
function inline(text: string): ReactNode[] {
  const out: ReactNode[] = [];
  const pattern = /\*\*(.+?)\*\*|`([^`]+)`|\[([^\]]+)\]\(([^)\s]+)\)/g;
  let last = 0, m: RegExpExecArray | null;
  while ((m = pattern.exec(text))) {
    if (m.index > last) out.push(text.slice(last, m.index));
    const key = out.length;
    if (m[1] !== undefined) out.push(<strong key={key}>{inline(m[1])}</strong>);
    else if (m[2] !== undefined) out.push(<code key={key}>{m[2]}</code>);
    else if (/^(https?:\/\/|#)/.test(m[4])) out.push(<a key={key} href={m[4]} {...(m[4].startsWith('#') ? {} : { target: '_blank', rel: 'noreferrer' })}>{m[3]}</a>);
    else out.push(m[3]);
    last = pattern.lastIndex;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

export function Markdown({ source }: { source: string }) {
  return (
    <>
      {parseMarkdown(source).map((b, i) => {
        if (b.kind === 'heading') {
          const Tag = b.level <= 3 ? 'h3' : 'h4';
          return <Tag key={i}>{inline(b.text)}</Tag>;
        }
        if (b.kind === 'paragraph') return <p key={i}>{inline(b.text)}</p>;
        if (b.kind === 'table')
          return (
            <div key={i} className="markdown-table">
              <table>
                <thead>
                  <tr>{b.head.map((c, j) => <th key={j}>{inline(c)}</th>)}</tr>
                </thead>
                <tbody>
                  {b.rows.map((r, j) => (
                    <tr key={j}>{r.map((c, k) => <td key={k}>{inline(c)}</td>)}</tr>
                  ))}
                </tbody>
              </table>
            </div>
          );
        const List = b.ordered ? 'ol' : 'ul';
        return (
          <List key={i}>
            {b.items.map((item, j) => (
              <li key={j}>
                {inline(item.text)}
                {item.children.length > 0 && <ul>{item.children.map((c, k) => <li key={k}>{inline(c)}</li>)}</ul>}
              </li>
            ))}
          </List>
        );
      })}
    </>
  );
}
