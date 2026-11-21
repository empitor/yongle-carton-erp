// 财务事件从快照取出来的几列（往来单位、单号、理论金额、缺税率）只由 server/finance/event-columns.ts 和快照一起写：
// 别的文件的 SQL 不许写 snapshot 和这几列；各种写法造出来的事件、第 21 步升级回填的旧事件，列都等于 eventColumns(快照) 算出来的值。
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import ts from 'typescript';
import { z } from 'zod';
import { Store } from '../server/core/db.js';
import { many, rows } from '../server/core/index.js';
import { upgradeSchema, upgradeSteps } from '../server/core/schema/index.js';
import { eventColumns } from '../server/finance/event-columns.js';
import { FinanceEventHandling } from '../server/finance/event-handling.js';
import { FinanceEventVouchers } from '../server/finance/event-voucher.js';
import { FinanceEvents } from '../server/finance/events.js';
import { readSnapshot } from '../server/finance/source-snapshot.js';
import { deliveryDoc, arrivalDoc, event, maker, newSettings, physical, postDrafts, setDoc } from './finance-fixture.js';
import { all } from './module-map.js';

const OWNER = 'server/finance/event-columns.ts';
/** 快照和从快照取出来的列 */
const guarded = new Set(['snapshot', 'party_kind', 'party_id', 'party_name', 'source_number', 'theoretical_cents', 'missing_tax']);
/** 表名：可带库名前缀（main.），可带引号、方括号、反引号 */
const table = String.raw`(?:["\x60\[]?\w+["\x60\]]?\s*\.\s*)?["\x60\[]?fin_events(?!\w)["\x60\]]?`;
/** 新记事件（快照必填，记一条就是写快照）：INSERT [OR …] INTO、REPLACE INTO */
const insert = new RegExp(String.raw`\b(?:INSERT|REPLACE)\b(?:\s+OR\s+\w+)?\s+INTO\s+${table}`, 'i');
/** UPDATE [OR …] 表 [[AS] 别名] SET：取 SET 后面的文字 */
const update = new RegExp(String.raw`\bUPDATE\s+(?:OR\s+\w+\s+)?${table}(?:\s+(?:AS\s+)?\w+)?\s+SET\b`, 'gi');

/** SET 后面按顶层逗号分开的每一段，到顶层的 WHERE、FROM、RETURNING 为止（括号里的子查询、引号里的文字不算） */
function setParts(rest: string) {
  const parts: string[] = [];
  let depth = 0,
    quote = '',
    start = 0,
    i = 0;
  for (; i < rest.length; i++) {
    const ch = rest[i];
    if (quote) quote = ch === quote ? '' : quote;
    else if (ch === "'" || ch === '"') quote = ch;
    else if (ch === '(') depth++;
    else if (ch === ')') depth--;
    else if (depth === 0 && ch === ',') {
      parts.push(rest.slice(start, i));
      start = i + 1;
    } else if (depth === 0 && /^(?:WHERE|FROM|RETURNING)\b/i.test(rest.slice(i)) && /\W/.test(rest[i - 1] ?? ' ')) break;
  }
  return [...parts, rest.slice(start, i)];
}
/** 一段 SET 赋值左边的列名（含 (a,b)=(…) 的写法），去掉别名前缀和引号 */
const assigned = (part: string) =>
  (part.split('=')[0] ?? '')
    .replace(/[()"\x60[\]]/g, ' ')
    .split(',')
    .map((name) => name.trim().split('.').at(-1) ?? '')
    .filter(Boolean);
/** 一段 SQL 写不写快照或那几列 */
function writesGuarded(sql: string) {
  if (insert.test(sql)) return true;
  return [...sql.matchAll(update)].some((m) =>
    setParts(sql.slice((m.index ?? 0) + m[0].length)).some((part) => assigned(part).some((name) => guarded.has(name.toLowerCase()))),
  );
}

/** 节点能拼出的 SQL 文字：字符串、模板（插值算一个 ?）、字符串用 + 拼起来的整段；别的写法是 null */
function sqlText(n: ts.Node): string | null {
  if (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n)) return n.text;
  if (ts.isTemplateExpression(n)) return n.head.text + n.templateSpans.map((s) => '?' + s.literal.text).join('');
  if (ts.isParenthesizedExpression(n)) return sqlText(n.expression);
  if (ts.isBinaryExpression(n) && n.operatorToken.kind === ts.SyntaxKind.PlusToken) {
    const left = sqlText(n.left),
      right = sqlText(n.right);
    return left === null && right === null ? null : (left ?? '?') + (right ?? '?');
  }
  return null;
}

/** 一个文件里写这些列的语句所在的行（拼接的按整段看，不看注释） */
function snapshotWrites(file: string, text = readFileSync(file, 'utf8')) {
  if (!text.includes('fin_events')) return [];
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
  const found: number[] = [];
  const visit = (n: ts.Node) => {
    const sql = sqlText(n);
    if (sql !== null) {
      if (writesGuarded(sql)) found.push(sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1);
      return;
    }
    n.forEachChild(visit);
  };
  visit(sf);
  return found;
}

test('财务事件的快照和从快照取出来的几列只由 event-columns.ts 写', () => {
  // 建表和升级步骤（server/core/schema/）只用 SQL，第 21 步按同一个取法回填，不算
  const files = all.filter((f) => /^server\/.*\.ts$/.test(f) && !f.startsWith('server/core/schema/') && f !== OWNER);
  const bad = files.flatMap((file) =>
    snapshotWrites(file).map(
      (line) =>
        `${file}:${line} 在 SQL 里写了 fin_events 的快照或从快照取出来的列：改成调 ${OWNER} 的 insertEvent、updateEventSnapshot，` +
        '列和快照由 eventColumns 一起算、同一句写',
    ),
  );
  assert.deepEqual(bad, []);
  assert.equal(snapshotWrites(OWNER).length, 2, 'event-columns.ts 里新记和换快照两句都认得出来');
});

test('写快照的取法：各种写法的新记事件、给快照或几列赋值都认得出来，只改状态的、WHERE 里比较的不算', () => {
  const probe = writesGuarded;
  assert.equal(probe('UPDATE fin_events SET status=?,snapshot=? WHERE id=?'), true);
  assert.equal(probe('UPDATE OR IGNORE fin_events SET snapshot=? WHERE id=?'), true, 'UPDATE OR …');
  assert.equal(probe('UPDATE fin_events AS e SET party_name=? WHERE e.id=?'), true, '带 AS 的别名');
  assert.equal(probe('UPDATE fin_events e SET e.source_number=? WHERE e.id=?'), true, '不带 AS 的别名、别名前缀');
  assert.equal(probe('UPDATE main.fin_events SET missing_tax=1'), true, '库名前缀');
  assert.equal(probe('UPDATE "fin_events" SET theoretical_cents=NULL'), true, '带引号的表名');
  assert.equal(probe('UPDATE fin_events SET (status,party_id)=(?,?) WHERE id=?'), true, '一次给几列赋值');
  assert.equal(probe('INSERT INTO "fin_events"(source_kind) VALUES(?)'), true, 'INSERT 带引号的表名');
  assert.equal(probe('INSERT OR REPLACE INTO main.fin_events(source_kind) VALUES(?)'), true, 'INSERT OR …、库名前缀');
  assert.equal(probe('REPLACE INTO fin_events(source_kind) VALUES(?)'), true, 'REPLACE INTO');
  assert.equal(probe('UPDATE fin_events SET status=? WHERE party_id=? AND snapshot IS NOT NULL'), false, 'WHERE 里比较的不算');
  assert.equal(probe("UPDATE fin_events SET problem=(SELECT x FROM y WHERE party_id=1),status='a' WHERE id=?"), false, '子查询里的不算');
  assert.equal(probe("UPDATE fin_events SET status='corrected',version=version+1 WHERE id=?"), false);
  assert.equal(probe('UPDATE fin_events_x SET snapshot=?'), false, '别的表');
  assert.equal(probe('SELECT snapshot FROM fin_events'), false);
  const text = `declare const db: any, n: string;
db.prepare('UPDATE fin_events SET status=?,' + 'snapshot=? WHERE id=?');
db.prepare(\`INSERT INTO fin_events(source_kind,\${n}) VALUES(?)\`);
db.prepare('UPDATE fin_events SET status=? ' + n + ' WHERE id=?');
// INSERT INTO fin_events 只写在注释里的不算`;
  assert.deepEqual(snapshotWrites('server/finance/__probe__.ts', text), [2, 3], '拼接的按整段看');
});

/** 库里每条事件：从快照算出来的几列和存着的列 */
function columnsOfAll(db: DatabaseSync) {
  return many(db, rows.fin_events, 'SELECT * FROM fin_events ORDER BY id').map((row) => {
    const { snapshot: _text, ...expected } = eventColumns(readSnapshot(row));
    const { party_kind, party_id, party_name, source_number, theoretical_cents, missing_tax } = row;
    return { row, expected, stored: { party_kind, party_id, party_name, source_number, theoretical_cents, missing_tax } };
  });
}

test('各种写法造出来的事件，从快照取出来的列都等于 eventColumns(快照)：同步、补税率、改单接手上一条、红字冲销并重做、启用前', () => {
  const s = new Store(':memory:');
  try {
    newSettings(s);
    const events = new FinanceEvents(s),
      handling = new FinanceEventHandling(s);
    physical(s, 1, 'delivery', '2026-01-10', deliveryDoc('10'));
    physical(s, 2, 'delivery', '2026-01-11', deliveryDoc('3', { taxed: false }));
    physical(s, 3, 'arrival', '2026-01-12', arrivalDoc('5'));
    physical(s, 4, 'delivery', '2025-12-20', deliveryDoc('1'));
    events.sync(maker);
    // 缺税率的补上（换快照）
    const pending = event(s, 2);
    assert.equal(pending.missing_tax, 1);
    handling.resolve(maker, pending.id, {
      version: pending.version,
      requestId: 'resolve',
      lines: [{ exact: '300.0000', mode: '未税', rate: '13%' }],
    });
    // 入过账的送货单改了数量：新的一条接手上一条（有差异），红字冲销并重做（换快照）
    new FinanceEventVouchers(s).generate(maker, event(s, 1).id, { version: 1, requestId: 'generate' });
    postDrafts(s);
    setDoc(s, 1, '$.lines[0].quantity', '12');
    events.sync(maker);
    const diff = event(s, 1);
    assert.equal(diff.status, 'difference');
    handling.correct(maker, diff.id, { version: diff.version, date: '2026-01-20', requestId: 'correct', reason: '虚构改单' });

    const checked = columnsOfAll(s.db);
    for (const { row, expected, stored } of checked) assert.deepEqual(stored, expected, `事件 ${row.id} 的列和快照对不上`);
    // 造出来的确实覆盖了每一种
    assert.ok(checked.some(({ row }) => row.party_kind === 'customer' && row.source_number === 'FICT-1'));
    assert.ok(checked.some(({ row }) => row.party_kind === 'supplier' && row.party_id === '1' && row.theoretical_cents !== null));
    assert.ok(checked.some(({ row }) => row.status === 'before_opening' && row.party_kind === null && row.missing_tax === 0));
    assert.equal(event(s, 2).missing_tax, 0, '补完税率不再缺');
    const redone = event(s, 1);
    assert.equal(redone.status, 'generated');
    assert.notEqual(redone.previous_event_id, null, '改单后的那条记着它接手的上一条');
    assert.equal(redone.document_cents, 120000, '同步时按单据现在的内容算的金额');
  } finally {
    s.close();
  }
});

/** 第 21 步数据样例里升级前的事件行 */
const sampleRows = z.object({
  before: z.object({ fin_events: z.array(z.record(z.string(), z.union([z.string(), z.number(), z.null()]))) }),
});

test('第 21 步回填的旧事件，从快照取出来的列也都等于 eventColumns(快照)：升级回填和程序新写同一个取法', () => {
  const before = sampleRows.parse(JSON.parse(readFileSync('tests/fixtures/upgrade-samples/v21.json', 'utf8'))).before.fin_events;
  const db = new DatabaseSync(':memory:');
  try {
    db.exec(readFileSync('tests/fixtures/schema-v20.sql', 'utf8'));
    for (const row of before) {
      const cols = Object.keys(row);
      db.prepare(`INSERT INTO fin_events(${cols.join(',')}) VALUES(${cols.map(() => '?').join(',')})`).run(...cols.map((c) => row[c]));
    }
    upgradeSchema(db, { appVersion: 'test-9.9.9', steps: upgradeSteps.filter((step) => step.version <= 21) });
    const checked = columnsOfAll(db);
    assert.equal(checked.length, before.length);
    for (const { row, expected, stored } of checked) assert.deepEqual(stored, expected, `回填的事件 ${row.id} 的列和快照对不上`);
  } finally {
    db.close();
  }
});
