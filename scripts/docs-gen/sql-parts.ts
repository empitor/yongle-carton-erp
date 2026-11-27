// 把一段建表 SQL（server/core/schema/tables/ 的分组、配置库规格 create 里执行的语句）拆成生成文档要的几块：
// 建表（列、表约束和括号里的注释）、建索引，以及它们前面的注释。由 scripts/docs-gen/schema-doc.ts 用。
//
// 注释怎么归：一句前面的 -- 注释按空行分成几段，紧挨着这句的最后一段是这句的说明，前面几段和最后一句之后的注释是“自由说明”，
// 按出现的先后排在文档里。语句前面的注释不进库结构（SQLite 只存从 CREATE 起的原文），括号里的注释会存进库结构。
// 认不出的语句、和数据库读出来的列对不上，都直接报错：宁可生成不了，也不生成一份和建表不一样的文档。

/** 表里的一项：列或表约束；note 是写在它前面的括号里的注释 */
export type SqlItem =
  | { kind: 'column'; name: string; type: string; rest: string; note: string[] }
  | { kind: 'constraint'; text: string; note: string[] };
export type SqlPart =
  | { kind: 'note'; lines: string[] }
  | { kind: 'table'; name: string; note: string[]; items: SqlItem[]; options: string }
  | { kind: 'index'; name: string; table: string; note: string[]; sql: string };

/** 扫一遍 SQL：遇到字符串和注释跳过，回调拿到每个“正文”字符和它所在的括号深度 */
function scan(sql: string, visit: (index: number, depth: number) => boolean | void) {
  let depth = 0;
  for (let i = 0; i < sql.length; i++) {
    const ch = sql[i];
    if (ch === "'") {
      i++;
      while (i < sql.length && (sql[i] !== "'" || sql[i + 1] === "'")) i += sql[i] === "'" ? 2 : 1;
    } else if (ch === '-' && sql[i + 1] === '-') {
      while (i < sql.length && sql[i] !== '\n') i++;
    } else {
      if (ch === ')') depth--;
      if (visit(i, depth) === true) return;
      if (ch === '(') depth++;
    }
  }
}

/** 在括号外、字符串和注释外按分隔符切开 */
function splitTop(sql: string, separator: string) {
  const pieces: string[] = [];
  let start = 0;
  scan(sql, (i, depth) => {
    if (depth === 0 && sql[i] === separator) {
      pieces.push(sql.slice(start, i));
      start = i + 1;
    }
  });
  pieces.push(sql.slice(start));
  return pieces;
}

const isComment = (line: string) => line.trim().startsWith('--');
/** 一行注释的正文：去掉 -- 和后面的一个空格 */
const commentText = (line: string) => line.trim().replace(/^--\s?/, '');
const squash = (text: string) => text.replace(/\s+/g, ' ').trim();

/** 一段文字开头的注释（空行分段）和后面的正文 */
function leading(text: string) {
  const lines = text.split('\n');
  let first = lines.findIndex((line) => line.trim() !== '' && !isComment(line));
  if (first < 0) first = lines.length;
  const blocks: string[][] = [];
  let current: string[] | null = null;
  for (const line of lines.slice(0, first)) {
    if (!isComment(line)) current = null;
    else if (current) current.push(commentText(line));
    else blocks.push((current = [commentText(line)]));
  }
  return { blocks, body: lines.slice(first).join('\n').trim() };
}

/** 去掉注释，只留正文 */
function withoutComments(text: string) {
  return text
    .split('\n')
    .filter((line) => !isComment(line))
    .join('\n');
}

const CONSTRAINT = /^(CHECK|UNIQUE|PRIMARY\s+KEY|FOREIGN\s+KEY|CONSTRAINT)\b/i;
/** 列定义里第二个词不是类型的情况（没写类型直接写约束） */
const NOT_TYPE = /^(NOT|NULL|PRIMARY|UNIQUE|CHECK|DEFAULT|REFERENCES|GENERATED|COLLATE|CONSTRAINT|AS)$/i;

function item(piece: string): SqlItem {
  const { blocks, body } = leading(piece);
  const note = blocks.flat();
  const text = squash(withoutComments(body));
  if (CONSTRAINT.test(text)) return { kind: 'constraint', text, note };
  const [name, second = '', ...more] = text.split(' ');
  const typed = second !== '' && !NOT_TYPE.test(second);
  return { kind: 'column', name, type: typed ? second : '', rest: (typed ? more : [second, ...more]).join(' ').trim(), note };
}

/** 建表语句：名字、括号里的各项、括号后的选项（STRICT 这类） */
function table(statement: string, note: string[]): SqlPart {
  const head = /^CREATE\s+TABLE\s+(\w+)\s*\(/i.exec(statement);
  if (!head) throw new Error('认不出的建表语句：' + statement.slice(0, 80));
  const open = head[0].length - 1;
  let close = -1;
  scan(statement, (i, depth) => {
    if (i > open && depth === 0 && statement[i] === ')') {
      close = i;
      return true;
    }
  });
  if (close < 0) throw new Error('建表语句的括号没有合上：' + head[1]);
  const items = splitTop(statement.slice(open + 1, close), ',').map(item);
  return { kind: 'table', name: head[1], note, items, options: squash(statement.slice(close + 1)) };
}

/** 一句建表或建索引；别的语句（插入数据、改表）不该出现在建表里，直接报错 */
function statementPart(statement: string, note: string[]): SqlPart {
  if (/^CREATE\s+TABLE\b/i.test(statement)) return table(statement, note);
  const index = /^CREATE\s+(?:UNIQUE\s+)?INDEX\s+(\w+)\s+ON\s+(\w+)/i.exec(statement);
  if (index) return { kind: 'index', name: index[1], table: index[2], note, sql: squash(withoutComments(statement)) };
  throw new Error('建表里有认不出的语句（只认建表、建索引）：' + statement.slice(0, 80));
}

/** 把一段 SQL 拆成按先后排的几块 */
export function sqlParts(sql: string): SqlPart[] {
  const parts: SqlPart[] = [];
  for (const chunk of splitTop(sql.replace(/\r\n/g, '\n'), ';')) {
    const { blocks, body } = leading(chunk);
    const free = body ? blocks.slice(0, -1) : blocks;
    for (const lines of free) parts.push({ kind: 'note', lines });
    if (body) parts.push(statementPart(body, blocks.at(-1) ?? []));
  }
  return parts;
}
