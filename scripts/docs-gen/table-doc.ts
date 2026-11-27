// 表结构文档里的一块：一段建表 SQL 拆出来的表、索引和说明怎么写成 Markdown（业务库、配置库共用）。
import type { DatabaseSync } from 'node:sqlite';
import { z } from 'zod';
import { many } from '../../server/core/index.js';
import { code, codeSpans, table } from './markdown.js';
import type { SqlItem, SqlPart } from './sql-parts.js';

type TablePart = Extract<SqlPart, { kind: 'table' }>;
type IndexPart = Extract<SqlPart, { kind: 'index' }>;
/** 一段 SQL 写成文档时要的：拆好的几块、建好的库（核对列用）、各表新库预置几行、全部表名（说明里认表名用） */
export type TableSource = { parts: SqlPart[]; db: DatabaseSync; seeds?: ReadonlyMap<string, number>; tableNames: ReadonlySet<string> };

const columnRow = z.object({ name: z.string(), hidden: z.number() });

/** 拆出来的列和库里读出来的列（PRAGMA table_xinfo）要一模一样，对不上说明拆错了 */
function checkColumns(db: DatabaseSync, part: TablePart) {
  const actual = many(db, columnRow, `PRAGMA table_xinfo("${part.name}")`)
    .filter((column) => column.hidden !== 1)
    .map((column) => column.name);
  const parsed = part.items.flatMap((item) => (item.kind === 'column' ? [item.name] : []));
  if (actual.join(',') !== parsed.join(','))
    throw new Error(`表 ${part.name} 从建表语句拆出来的列（${parsed.join('、')}）和库里的（${actual.join('、')}）对不上：生成脚本要跟着改`);
}

/** 几行说明并成一行：中文挨着中文直接接上，英文和英文之间留空格 */
export function joinLines(lines: string[]) {
  return lines.reduce((out, line) => {
    const text = line.trim();
    if (!out || !text) return out + text;
    return out + (/[\x21-\x7e]$/.test(out) && /^[\x21-\x7e]/.test(text) ? ' ' : '') + text;
  }, '');
}

/** 表里写到的英文枚举值（'raw' 这类）：说明里出现时当代码 */
const literals = (part: TablePart) =>
  part.items.flatMap((item) =>
    [...(item.kind === 'column' ? item.rest : item.text).matchAll(/'([A-Za-z_][\w.-]*)'/g)].map((m) => m[1]),
  );

/** 说明文字：逐行套反引号；strict 时写到不存在的项目路径就报错 */
function noteLines(lines: string[], known: ReadonlySet<string>, where: string, strict = true) {
  return lines.map((line) => codeSpans(line, { known, strict, where }));
}

const itemNote = (item: SqlItem, known: ReadonlySet<string>, where: string) =>
  joinLines(noteLines(item.note, known, where, false));

function columnTable(part: TablePart, known: ReadonlySet<string>) {
  const columns = part.items.flatMap((item) => (item.kind === 'column' ? [item] : []));
  const withNotes = columns.some((column) => column.note.length);
  const head = ['列', '类型', '约束', ...(withNotes ? ['说明'] : [])];
  return table(
    head,
    columns.map((column) => [
      code(column.name),
      column.type,
      column.rest ? code(column.rest) : '',
      ...(withNotes ? [itemNote(column, known, '表 ' + part.name)] : []),
    ]),
  );
}

/** 一张表：标题、说明、列、表约束、索引、预置数据 */
function tableLines(part: TablePart, indexes: IndexPart[], source: TableSource) {
  checkColumns(source.db, part);
  const where = '表 ' + part.name;
  const known = new Set([...source.tableNames, ...part.items.flatMap((i) => (i.kind === 'column' ? [i.name] : [])), ...literals(part)]);
  const lines = ['#### ' + code(part.name) + (part.options ? '（' + part.options + '）' : ''), ''];
  if (part.note.length) lines.push(...noteLines(part.note, known, where), '');
  lines.push(...columnTable(part, known));
  const extra: string[] = [];
  for (const item of part.items)
    if (item.kind === 'constraint') {
      const note = itemNote(item, known, where);
      extra.push('- 表约束 ' + code(item.text) + (note ? '：' + note : ''));
    }
  for (const index of indexes) {
    const note = joinLines(noteLines(index.note, known, '索引 ' + index.name));
    extra.push('- 索引 ' + code(index.sql) + (note ? '：' + note : ''));
  }
  const seeded = source.seeds?.get(part.name);
  if (seeded) extra.push(`- 新库预置 ${seeded} 行`);
  if (extra.length) lines.push(...extra, '');
  return lines;
}

/** 一段 SQL 的全部内容：自由说明照先后放，每张表带上建在它上面的索引 */
export function sourceLines(source: TableSource, where: string) {
  const indexes = source.parts.filter((part): part is IndexPart => part.kind === 'index');
  const lines: string[] = [];
  for (const part of source.parts) {
    if (part.kind === 'note') lines.push(...noteLines(part.lines, source.tableNames, where), '');
    else if (part.kind === 'table')
      lines.push(
        ...tableLines(
          part,
          indexes.filter((index) => index.table === part.name),
          source,
        ),
      );
  }
  const tables = new Set(source.parts.flatMap((part) => (part.kind === 'table' ? [part.name] : [])));
  const orphan = indexes.find((index) => !tables.has(index.table));
  if (orphan) throw new Error(`索引 ${orphan.name} 建在 ${orphan.table} 上，可这张表不在同一段建表里：生成脚本要跟着改`);
  return lines;
}
