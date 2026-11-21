// 财务事件从快照取出来的几列（往来单位、单号、理论金额、缺税率）只由 server/finance/event-columns.ts 和快照一起写：
// 别的文件的 SQL 不许写 snapshot 和这几列；各种写法造出来的事件，列都等于 eventColumns(快照) 算出来的值。
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import ts from 'typescript';
import { Store } from '../server/core/db.js';
import { many, rows } from '../server/core/index.js';
import { eventColumns } from '../server/finance/event-columns.js';
import { FinanceEventHandling } from '../server/finance/event-handling.js';
import { FinanceEventVouchers } from '../server/finance/event-voucher.js';
import { FinanceEvents } from '../server/finance/events.js';
import { readSnapshot } from '../server/finance/source-snapshot.js';
import { deliveryDoc, arrivalDoc, event, maker, newSettings, physical, postDrafts, setDoc } from './finance-fixture.js';
import { all } from './module-map.js';

const OWNER = 'server/finance/event-columns.ts';
/** 写 fin_events 的快照或从快照取出来的列的语句：新记事件（快照必填）、UPDATE 里给这些列赋值 */
const writes = [
  /\b(INSERT|REPLACE)\b[^;]*\bINTO\s+fin_events\b/i,
  /\bUPDATE\s+fin_events\s+SET\b[^;]*\b(snapshot|party_kind|party_id|party_name|source_number|theoretical_cents|missing_tax)\s*=/i,
];

/** 一个文件里写这些列的语句所在的行：只看字符串和模板（含插值的整段），不看注释 */
function snapshotWrites(file: string, text = readFileSync(file, 'utf8')) {
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
  const found: number[] = [];
  const visit = (n: ts.Node) => {
    if (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n) || ts.isTemplateExpression(n)) {
      if (writes.some((re) => re.test(n.getText(sf)))) found.push(sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1);
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
  assert.ok(snapshotWrites(OWNER).length >= 2, 'event-columns.ts 里新记和换快照两句都认得出来');
});

test('写快照的取法：新记事件、UPDATE 给快照或几列赋值的认得出来，只改状态的不算', () => {
  const text = `declare const db: any, n: string;
db.prepare('UPDATE fin_events SET status=?,snapshot=? WHERE id=?');
db.prepare(\`INSERT INTO fin_events(source_kind,\${n}) VALUES(?)\`);
db.prepare("UPDATE fin_events SET party_name=NULL WHERE id=?");
db.prepare("UPDATE fin_events SET status='corrected',version=version+1 WHERE id=?");
db.prepare('SELECT snapshot FROM fin_events');
// INSERT INTO fin_events 只写在注释里的不算`;
  assert.deepEqual(snapshotWrites('server/finance/__probe__.ts', text), [2, 3, 4]);
});

/** 库里每条事件：从快照算出来的几列和存着的列 */
function columnsOfAll(s: Store) {
  return many(s.db, rows.fin_events, 'SELECT * FROM fin_events ORDER BY id').map((row) => {
    const { snapshot: _text, ...expected } = eventColumns(readSnapshot(row));
    const stored = {
      party_kind: row.party_kind,
      party_id: row.party_id,
      party_name: row.party_name,
      source_number: row.source_number,
      theoretical_cents: row.theoretical_cents,
      missing_tax: row.missing_tax,
    };
    return { row, expected, stored };
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
    events.sync(maker, { requestId: 'scan' });
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
    events.sync(maker, { requestId: 'rescan' });
    const diff = event(s, 1);
    assert.equal(diff.status, 'difference');
    handling.correct(maker, diff.id, { version: diff.version, date: '2026-01-20', requestId: 'correct', reason: '虚构改单' });

    const checked = columnsOfAll(s);
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
