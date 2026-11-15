// 业务的表（基础、采购库存、单据流转、识别导入、助手、业务汇总）：数据库约束真的拦得住不合规则的值。
// 枚举列的取值由 schema-constraints 的枚举比对守着，这里只放条件型的约束（成对出现、日期对得上、范围、JSON）。
// 每条测试一个空业务库，写完核对外键都对得上。
import assert from 'node:assert/strict';
import type { DatabaseSync, SQLInputValue } from 'node:sqlite';
import { test } from 'node:test';
import { Store } from '../server/core/db.js';
import { FINISHED_UNIT, RAW_UNIT } from '../shared/core/units.js';
import { accepts, rejects, sha } from './schema-fixture.js';

const now = '2026-11-12T00:00:00.000Z';

/** 在一个空业务库里做完 work，再核对外键都对得上 */
function withBusinessDb(work: (db: DatabaseSync) => void) {
  const store = new Store(':memory:');
  try {
    work(store.db);
    assert.deepEqual(store.db.prepare('PRAGMA foreign_key_check').all(), []);
  } finally {
    store.close();
  }
}
/** 插一行，返回它的编号 */
const insertId = (db: DatabaseSync, sql: string, ...params: SQLInputValue[]) => Number(db.prepare(sql).run(...params).lastInsertRowid);
const newSupplier = (db: DatabaseSync) =>
  insertId(db, "INSERT INTO suppliers(name,contact,phone,address,notes,created_at,updated_at) VALUES('虚构供应商','','','','',?,?)", now, now);
const newProduct = (db: DatabaseSync, name: string) => insertId(db, 'INSERT INTO products(name,created_at,updated_at) VALUES(?,?,?)', name, now, now);
const stockItem = 'INSERT INTO stock_items(name,kind,unit,product_id,raw_key,created_at,updated_at,document) VALUES(?,?,?,?,?,?,?,?)';
const newRawItem = (db: DatabaseSync) => insertId(db, stockItem, '虚构纸板', 'raw', RAW_UNIT, null, '键一', now, now, '{}');
const movement =
  'INSERT INTO stock_movements(id,item_id,action,delta_units,before_units,after_units,source_kind,date,notes,actor_id,actor_name,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)';

test('客户、供应商：名称不能是空白；版本号从 1 起；STRICT 拦类型不符', () => {
  withBusinessDb((db) => {
    const customer = insertId(db, "INSERT INTO customers(name,contact,phone,address,notes,created_at,updated_at) VALUES('虚构客户','','','','',?,?)", now, now);
    rejects(db, "UPDATE customers SET name='   ' WHERE id=?", [customer]);
    rejects(db, 'UPDATE customers SET version=0 WHERE id=?', [customer]);
    rejects(db, "UPDATE customers SET version='abc' WHERE id=?", [customer], /cannot store TEXT value in INTEGER column/);
    rejects(db, 'UPDATE customers SET version=1.5 WHERE id=?', [customer], /cannot store REAL value in INTEGER column/);
    rejects(db, "UPDATE suppliers SET name='' WHERE id=?", [newSupplier(db)]);
  });
});

// 原材料只有张、成品只有只；成品一定关联产品、原材料不关联；一个产品只有一个成品库存；
// 原材料存查重键（raw_key），同一个键只能有一个；document 是 JSON 对象
test('库存品：单位跟着种类走，成品关联产品、原材料存查重键，各自不重复，内容是 JSON 对象', () => {
  withBusinessDb((db) => {
    const product = newProduct(db, '虚构纸箱'),
      spare = newProduct(db, '虚构纸箱二');
    const raw = newRawItem(db);
    const finished = insertId(db, stockItem, '虚构成品', 'finished', FINISHED_UNIT, product, null, now, now, '{}');
    for (const [kind, unit] of [['raw', '只'], ['raw', '平方米'], ['finished', '张'], ['finished', '个'], ['finished', '箱'], ['raw', '']])
      rejects(db, stockItem, ['虚构库存品', kind, unit, kind === 'finished' ? spare : null, kind === 'finished' ? null : '键二', now, now, '{}']);
    rejects(db, "UPDATE stock_items SET kind='finished' WHERE id=?", [raw]);
    rejects(db, "UPDATE stock_items SET unit='箱' WHERE id=?", [finished]);
    // 成品一定关联产品，原材料不关联；成品不存查重键，原材料一定存
    rejects(db, stockItem, ['虚构成品二', 'finished', FINISHED_UNIT, null, null, now, now, '{}']);
    rejects(db, stockItem, ['虚构纸板二', 'raw', RAW_UNIT, spare, '键二', now, now, '{}']);
    rejects(db, stockItem, ['虚构纸板二', 'raw', RAW_UNIT, null, null, now, now, '{}']);
    rejects(db, stockItem, ['虚构纸板二', 'raw', RAW_UNIT, null, '', now, now, '{}']);
    rejects(db, stockItem, ['虚构成品二', 'finished', FINISHED_UNIT, spare, '键二', now, now, '{}']);
    rejects(db, "UPDATE stock_items SET kind='finished',unit='只' WHERE id=?", [raw]);
    rejects(db, 'UPDATE stock_items SET product_id=NULL WHERE id=?', [finished]);
    rejects(db, 'UPDATE stock_items SET product_id=? WHERE id=?', [spare, raw]);
    // 种类、单位、产品、查重键一起改才对得上（从没用过的库存品改种类）
    accepts(db, "UPDATE stock_items SET kind='finished',unit='只',product_id=?,raw_key=NULL WHERE id=?", [spare, raw]);
    accepts(db, "UPDATE stock_items SET kind='raw',unit='张',product_id=NULL,raw_key='键一' WHERE id=?", [raw]);
    // 一个产品只有一个成品库存；同一个查重键的原材料只有一个（归档只是另一张表里的标记，一样拦）
    rejects(db, stockItem, ['虚构成品二', 'finished', FINISHED_UNIT, product, null, now, now, '{}'], /UNIQUE constraint failed/);
    const third = insertId(db, stockItem, '虚构成品三', 'finished', FINISHED_UNIT, spare, null, now, now, '{}');
    rejects(db, 'UPDATE stock_items SET product_id=? WHERE id=?', [product, third], /UNIQUE constraint failed/);
    rejects(db, stockItem, ['名字不同也不行', 'raw', RAW_UNIT, null, '键一', now, now, '{}'], /UNIQUE constraint failed/);
    accepts(db, stockItem, ['虚构纸板二', 'raw', RAW_UNIT, null, '键二', now, now, '{}']);
    rejects(db, stockItem, ['  ', 'raw', RAW_UNIT, null, '键三', now, now, '{}']);
    rejects(db, stockItem, ['虚构纸板三', 'raw', RAW_UNIT, null, '键三', now, now, '[]']);
    rejects(db, stockItem, ['虚构纸板三', 'raw', RAW_UNIT, null, '键三', now, now, '{bad']);
  });
});

test('生产任务：单位只有只（存在 document 的 unit 里，没写也不行），没有待核对；别的单据不看这两条', () => {
  withBusinessDb((db) => {
    // 计划日按单据日期填进内容和列，到货单没有
    const flowDoc =
      "INSERT INTO flow_documents(kind,number,date,status,actor_id,actor_name,created_at,updated_at,document,planned_date) VALUES(?,?,?,?,?,?,?,?,CASE ?1 WHEN 'arrival' THEN ?9 ELSE json_set(?9,'$.plannedDate',?3) END,CASE ?1 WHEN 'arrival' THEN NULL ELSE ?3 END)";
    const task = insertId(db, flowDoc, 'task', '虚构-SC-1', '2026-11-01', 'confirmed', 't', '虚构', now, now, JSON.stringify({ unit: FINISHED_UNIT }));
    for (const document of [{ unit: '箱' }, { unit: '个' }, { unit: RAW_UNIT }, { unit: '' }, {}])
      rejects(db, flowDoc, ['task', '虚构-SC-2', '2026-11-01', 'confirmed', 't', '虚构', now, now, JSON.stringify(document)]);
    rejects(db, flowDoc, ['task', '虚构-SC-3', '2026-11-01', 'draft', 't', '虚构', now, now, JSON.stringify({ unit: FINISHED_UNIT })]);
    rejects(db, "UPDATE flow_documents SET status='draft' WHERE id=?", [task]);
    rejects(db, "UPDATE flow_documents SET document=json_set(document,'$.unit','箱') WHERE id=?", [task]);
    accepts(db, flowDoc, ['arrival', '虚构-DH-1', '2026-11-01', 'draft', 't', '虚构', now, now, '{}']);
  });
});

test('采购单和订货批次：日期要真实存在，预计到货可以不填但不能是空字符串、不能早于下单日；到货安排是 JSON 数组', () => {
  withBusinessDb((db) => {
    const supplier = newSupplier(db);
    const purchase = insertId(
      db,
      "INSERT INTO purchases(number,supplier_id,supplier_name,order_date,expected_date,status,notes,created_at,updated_at) VALUES('虚构采购单',?,'虚构供应商','2026-11-01',NULL,'待订货','',?,?)",
      supplier,
      now,
      now,
    );
    for (const value of ['2026-02-30', '2026-13-01', '2026-1-1', '', '2026-11-01T08:00:00Z'])
      rejects(db, 'UPDATE purchases SET order_date=? WHERE id=?', [value, purchase]);
    rejects(db, "UPDATE purchases SET expected_date='' WHERE id=?", [purchase]);
    rejects(db, "UPDATE purchases SET expected_date='2026-02-30' WHERE id=?", [purchase]);
    rejects(db, "UPDATE purchases SET expected_date='2026-10-31' WHERE id=?", [purchase]);
    accepts(db, "UPDATE purchases SET expected_date='2026-11-01' WHERE id=?", [purchase]);
    accepts(db, 'UPDATE purchases SET expected_date=NULL WHERE id=?', [purchase]);
    const batch = insertId(
      db,
      "INSERT INTO order_batches(number,supplier_id,order_date,actor_id,actor_name,created_at,updated_at) VALUES('虚构批次',?,'2026-11-01','x','虚构',?,?)",
      supplier,
      now,
      now,
    );
    rejects(db, "UPDATE order_batches SET schedule='{}' WHERE id=?", [batch]);
    rejects(db, "UPDATE order_batches SET schedule='[1,' WHERE id=?", [batch]);
    rejects(db, "UPDATE order_batches SET order_date='2026-02-30' WHERE id=?", [batch]);
    accepts(db, `UPDATE order_batches SET schedule='[{"date":"2026-11-03"}]' WHERE id=?`, [batch]);
  });
});

test('库存流水：日期、数量范围，数量是整数（千分之一为单位），只有盘点能记 0；流水修订记录的前后内容是 JSON', () => {
  withBusinessDb((db) => {
    const raw = newRawItem(db);
    accepts(db, movement, ['m-1', raw, 'in', 1000, 0, 1000, 'manual', '2026-11-01', '', 'x', '虚构', now]);
    // 数量是 0 的流水只有盘点（adjust）能记，表示盘过了、数量没变；别的出入库记 0 被拒。
    // 管理员重写流水时前后结余先按 0/0 插入再重算，这个不拦
    accepts(db, movement, ['m-2', raw, 'adjust', 0, 0, 0, 'manual', '2026-11-01', '', 'x', '虚构', now]);
    for (const [action, source] of [
      ['in', 'manual'],
      ['out', 'manual'],
      ['purchase', 'flow_arrival'],
      ['out', 'flow_delivery'],
      ['in', 'flow_reversal'],
      ['out', 'database-maintenance'],
    ])
      rejects(db, movement, ['m-0', raw, action, 0, 0, 0, source, '2026-11-01', '', 'x', '虚构', now]);
    accepts(db, movement, ['m-4', raw, 'out', -1000, 0, 0, 'database-maintenance', '2026-11-01', '', 'x', '虚构', now]);
    // 已有的非盘点流水也不能改成 0
    rejects(db, "UPDATE stock_movements SET delta_units=0 WHERE id='m-1'", []);
    accepts(db, "UPDATE stock_movements SET delta_units=0,action='adjust' WHERE id='m-4'", []);
    for (const date of ['2026-02-30', '', '2026-11-1'])
      rejects(db, movement, ['m-3', raw, 'in', 1000, 0, 1000, 'manual', date, '', 'x', '虚构', now]);
    rejects(db, movement, ['m-3', raw, 'in', 1000000000000, 0, 1000, 'manual', '2026-11-01', '', 'x', '虚构', now]);
    rejects(db, movement, ['m-3', raw, 'out', -1000, 0, -1000, 'manual', '2026-11-01', '', 'x', '虚构', now]);
    rejects(db, movement, ['m-3', raw, 'in', 1.5, 0, 1000, 'manual', '2026-11-01', '', 'x', '虚构', now], /cannot store REAL value in INTEGER column/);
    const revision = 'INSERT INTO stock_movement_revisions(movement_id,item_id,at,actor_id,actor_name,reason,before_document,after_document) VALUES(?,?,?,?,?,?,?,?)';
    accepts(db, revision, ['m-1', raw, now, 'x', '虚构', '虚构原因', '{}', null]);
    rejects(db, revision, ['m-1', raw, now, 'x', '虚构', '虚构原因', '{bad', null]);
    rejects(db, revision, ['m-1', raw, now, 'x', '虚构', '虚构原因', '{}', '{bad']);
    rejects(db, revision, ['m-1', 0, now, 'x', '虚构', '虚构原因', '{}', null]);
  });
});

test('审计、归档标记、墓碑：来源只有四种入口，动作、对象不为空，编号从 1 起，内容是 JSON', () => {
  withBusinessDb((db) => {
    const audit = 'INSERT INTO business_audit(at,actor_id,actor_name,source,action,entity,record_id,document) VALUES(?,?,?,?,?,?,?,?)';
    // 来源只有四种入口（shared/core/audit-sources.ts）；动作、对象跟着功能增加，只要求不为空
    accepts(db, audit, [now, 'x', '虚构', 'assistant', '以后新加的动作', '以后新加的对象', null, '{}']);
    rejects(db, audit, [now, 'x', '虚构', '', 'create', 'customers', 1, '{}']);
    rejects(db, audit, [now, 'x', '虚构', 'business-ui', 'create', 'customers', 1, '{}']);
    rejects(db, audit, [now, 'x', '虚构', 'page', '', 'customers', 1, '{}']);
    rejects(db, audit, [now, 'x', '虚构', 'page', 'create', '', 1, '{}']);
    rejects(db, audit, [now, 'x', '虚构', 'page', 'create', 'customers', 0, '{}']);
    rejects(db, audit, [now, 'x', '虚构', 'page', 'create', 'customers', 1, '{bad']);
    const lifecycle = 'INSERT INTO record_lifecycle(entity,record_id,archived_at,actor_id) VALUES(?,?,?,?)';
    accepts(db, lifecycle, ['flow_delivery', 1, now, 'x']);
    rejects(db, lifecycle, ['customers', 0, now, 'x']);
    const tombstone = 'INSERT INTO permanent_record_deletions(entity,record_id,deleted_at,actor_id,label) VALUES(?,?,?,?,?)';
    accepts(db, tombstone, ['stock_items', 1, now, 'x', '虚构']);
  });
});

test('收件箱和唛头：附件四列同有同无，转成了什么和状态对得上，处理人和处理时间一起记；文件大小对得上，页码不为负', () => {
  withBusinessDb((db) => {
    const inbox = 'INSERT INTO inbox_items(channel,external_id,kind,file_name,file_mime,file_size,file_sha256,received_at,created_at) VALUES(?,?,?,?,?,?,?,?,?)';
    accepts(db, inbox, ['manual', 'a', 'text', null, null, null, null, now, now]);
    accepts(db, inbox, ['wecom_bot', 'b', 'file', '虚构.pdf', 'application/pdf', 3, sha('a'), now, now]);
    accepts(db, inbox, ['feishu_bot', 'b', 'text', null, null, null, null, now, now]);
    accepts(db, inbox, ['dingtalk_bot', 'b', 'text', null, null, null, null, now, now]);
    rejects(db, inbox, ['manual', 'c', 'file', '虚构.pdf', null, null, null, now, now]);
    rejects(db, inbox, ['manual', 'c', 'file', '虚构.pdf', 'application/pdf', -1, sha('a'), now, now]);
    rejects(db, "UPDATE inbox_items SET status='done' WHERE external_id='a'");
    rejects(db, "UPDATE inbox_items SET converted_kind='purchase' WHERE external_id='a'");
    rejects(db, "UPDATE inbox_items SET handled_by='x' WHERE external_id='a'");
    accepts(db, "UPDATE inbox_items SET status='converted',converted_kind='order',handled_by='x',handled_at=? WHERE external_id='a'", [now]);
    const bytes = new Uint8Array([1, 2, 3]);
    accepts(db, 'INSERT INTO inbox_files(sha256,size,content) VALUES(?,?,?)', [sha('a'), 3, bytes]);
    rejects(db, 'INSERT INTO inbox_files(sha256,size,content) VALUES(?,?,?)', [sha('b'), 4, bytes]);
    rejects(db, 'INSERT INTO inbox_files(sha256,size,content) VALUES(?,?,?)', ['not-a-hash', 3, bytes]);
    rejects(db, 'INSERT INTO inbox_files(sha256,size,content) VALUES(?,?,?)', [sha('c'), 3, '不是二进制'], /cannot store TEXT value in BLOB column/);
    // 唛头
    accepts(db, 'INSERT INTO mark_files(sha256,size,mime,file_name,content) VALUES(?,?,?,?,?)', [sha('d'), 3, 'image/png', '虚构.png', bytes]);
    rejects(db, 'INSERT INTO mark_files(sha256,size,mime,file_name,content) VALUES(?,?,?,?,?)', [sha('e'), 0, 'image/png', '虚构.png', new Uint8Array()]);
    rejects(db, 'INSERT INTO mark_files(sha256,size,mime,file_name,content) VALUES(?,?,?,?,?)', [sha('e'), 5, 'image/png', '虚构.png', bytes]);
    const product = newProduct(db, '虚构纸箱');
    const mark = 'INSERT INTO product_marks(product_id,file_sha256,page,source_kind,created_by,created_at,updated_at) VALUES(?,?,?,?,?,?,?)';
    accepts(db, mark, [product, sha('d'), 0, 'manual', 'x', now, now]);
    rejects(db, mark, [product, sha('d'), -1, 'manual', 'x', now, now]);
  });
});

test('助手的表：对话和消息的内容是 JSON，卡片过期时间不为负，工具和状态不为空，附件有大小、摘要是 64 位十六进制', () => {
  withBusinessDb((db) => {
    const thread = 'INSERT INTO assistant_threads(id,user_id,title,created_at,updated_at,document) VALUES(?,?,?,?,?,?)';
    accepts(db, thread, ['t-1', 'x', '虚构对话', now, now, '{}']);
    rejects(db, thread, ['t-2', 'x', '虚构对话', now, now, '[]']);
    const message = 'INSERT INTO assistant_messages(id,thread_id,role,created_at,text,document) VALUES(?,?,?,?,?,?)';
    accepts(db, message, ['msg-1', 't-1', 'assistant', now, '虚构', '{}']);
    rejects(db, message, ['msg-2', 't-1', 'user', now, '虚构', '{bad']);
    const run = 'INSERT INTO assistant_runs(id,thread_id,user_id,state,created_at,document) VALUES(?,?,?,?,?,?)';
    accepts(db, run, ['r-1', 't-1', 'x', 'running', now, '{}']);
    const preview = 'INSERT INTO assistant_previews(id,thread_id,user_id,session_binding,expires_at,digest,document,result) VALUES(?,?,?,?,?,?,?,?)';
    accepts(db, preview, ['p-1', 't-1', 'x', 's', Date.now() + 60000, 'd', '{}', null]);
    accepts(db, "UPDATE assistant_previews SET expires_at=0 WHERE id='p-1'");
    accepts(db, "UPDATE assistant_previews SET result='null' WHERE id='p-1'");
    rejects(db, "UPDATE assistant_previews SET expires_at=-1 WHERE id='p-1'");
    rejects(db, "UPDATE assistant_previews SET result='{bad' WHERE id='p-1'");
    const logged = 'INSERT INTO assistant_audit(user_id,thread_id,tool,state,created_at,document) VALUES(?,?,?,?,?,?)';
    accepts(db, logged, ['x', 't-1', '以后新加的工具', '以后新加的状态', now, '{}']);
    rejects(db, logged, ['x', 't-1', '', 'executed', now, '{}']);
    rejects(db, logged, ['x', 't-1', 'records.get', '', now, '{}']);
    const attachment =
      'INSERT INTO assistant_attachments(id,thread_id,user_id,upload_id,name,size,mime,kind,sha256,created_at,metadata) VALUES(?,?,?,?,?,?,?,?,?,?,?)';
    accepts(db, attachment, ['a-1', 't-1', 'x', 'u-1', '虚构.txt', 4, 'text/plain', 'text', sha('f'), now, '{}']);
    rejects(db, attachment, ['a-2', 't-1', 'x', 'u-2', '虚构.txt', 0, 'text/plain', 'text', sha('f'), now, '{}']);
    rejects(db, attachment, ['a-2', 't-1', 'x', 'u-2', '虚构.txt', 4, 'text/plain', 'text', 'fictional-hash', now, '{}']);
    rejects(db, attachment, ['a-2', 't-1', 'x', 'u-2', '虚构.txt', 4, 'text/plain', 'text', sha('f'), now, '{bad']);
  });
});
