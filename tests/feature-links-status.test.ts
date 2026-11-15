/**
 * 一件事一条链路（AGENTS.md）的自动检查之三：关键状态只许一处改。把单据标成待核对、已生效（已入库、已出库、已下达）、
 * 已撤销（含更正时原单被替代）、已取消的写法，只许出现在登记的文件里；订单、采购单、采购退货改状态的语句也一样。
 * 照“表只由主人写、单据只由 document-store.ts 写”的做法（tests/module-table-owners.test.ts）：
 * 单据表的状态只经 writeFlowDocument、insertFlowDocument 的 status 改，这里再管“谁能传哪种状态”。
 * 新的地方要改状态，先想是不是该调登记文件里现成的服务；确实要加的在 statusWriters 登记并写明原因。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { all } from './module-map.js';
import { statusWrites } from './feature-links-scan.js';

/** 哪张表、改成什么状态（单据表按状态值；别的表的 UPDATE 语句记成“语句”；状态是变量的记成“（变量）”）、哪些文件能写、为什么 */
const statusWriters: { table: string; status: string; files: string[]; why: string }[] = [
  { table: 'flow_documents', status: 'draft', files: ['server/flow/service.ts'], why: '新建待核对的单据（安排送货、登记没有采购单的到货、待入库的完工单）' },
  {
    table: 'flow_documents',
    status: 'confirmed',
    files: ['server/flow/confirm.ts', 'server/flow/correction.ts', 'server/flow/service.ts'],
    why: '核对生效（核对入库、出库）只在 confirm.ts；更正出的替代单当场生效；安排生产即下达（service.ts 新建任务）',
  },
  {
    table: 'flow_documents',
    status: 'reversed',
    files: ['server/flow/undo.ts', 'server/flow/correction.ts'],
    why: '撤销在 undo.ts；更正时原单标成已撤销并指向替代单',
  },
  { table: 'flow_documents', status: 'cancelled', files: ['server/flow/undo.ts'], why: '取消还没核对的单据' },
  { table: 'flow_documents', status: '（变量）', files: ['server/flow/maintenance-writes.ts'], why: '管理员拆分送货单：拆出来的新单沿用原单的状态' },
  { table: 'flow_documents', status: '语句', files: ['server/flow/document-store.ts'], why: '单据表只由 document-store.ts 写，状态和镜像列一起写' },
  { table: 'purchase_returns', status: '语句', files: ['server/flow/returns.ts'], why: '采购退货的撤销' },
  {
    table: 'orders',
    status: '语句',
    files: ['server/core/orders.ts', 'server/core/db.ts'],
    why: '整张保存（确认、退回、取消、恢复经 changeOrderStatus 也落到这里）在 orders.ts；生产中、待发货、已发货由单据派生，写回在 db.ts 的 setDerivedOrderStatus',
  },
  { table: 'purchases', status: '语句', files: ['server/operations/purchase-save.ts'], why: '整张保存；改状态的四个动作经 changePurchaseStatus 调它' },
];
const tables = [...new Set(statusWriters.map((s) => s.table))];

test('关键状态只许一处改：单据、订单、采购单、采购退货的状态只在登记的文件里写', () => {
  const files = all.filter((f) => /^server\/.*\.ts$/.test(f) && !f.startsWith('server/core/schema/')).map((file) => ({ file }));
  const found = statusWrites(tables, files);
  const bad = found
    .filter((w) => !statusWriters.some((s) => s.table === w.table && s.status === w.status && s.files.includes(w.file)))
    .map((w) => w.file + ':' + w.line + ' 把 ' + w.table + ' 改成 ' + w.status + '，没登记在 statusWriters');
  for (const s of statusWriters)
    for (const f of s.files)
      if (!found.some((w) => w.table === s.table && w.status === s.status && w.file === f))
        bad.push(s.table + ' ' + s.status + ' 登记了 ' + f + '，那里已经不写了，删掉');
  assert.deepEqual(bad, []);
});

test('状态写法的取法：写单据的两个函数里的 status、UPDATE 语句里的 status 都取得到', () => {
  const text = `import { writeFlowDocument } from './document-store.js';
declare const store: any, doc: any, s: string;
writeFlowDocument(store, 1, doc, { status: 'reversed', at: '' });
writeFlowDocument(store, 1, doc, { status: s === 'a' ? 'confirmed' : 'draft' });
writeFlowDocument(store, 1, doc, { status: s });
store.db.prepare('UPDATE purchases SET notes=?,status=? WHERE id=?');
store.db.prepare('UPDATE purchases SET notes=? WHERE id=?');`;
  const got = statusWrites(['purchases'], [{ file: 'server/flow/__status_probe__.ts', text }]).map((w) => w.table + ' ' + w.status);
  assert.deepEqual(got, ['flow_documents reversed', 'flow_documents confirmed', 'flow_documents draft', 'flow_documents （变量）', 'purchases 语句']);
});
