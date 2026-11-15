// 助手真实模型全量测试（scripts/ui-check/real-suite.mjs）的自测：不连模型、不起实例，只查场景定义和判定。
// 场景要覆盖工具目录里的每一个工具（新加工具没写场景这里就拦下），判定对几种典型记录给出对的级别。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { toolCatalog } from '../server/assistant/tool-catalog.ts';
import { loadScenes } from '../scripts/ui-check/real-scenes.mjs';
import { toolListChecks } from '../scripts/ui-check/real-scenes-kit.mjs';
import { compareRuns, expectedTools, judge, summarize, validateScenarios, worstLevel } from '../scripts/ui-check/real-suite-judge.mjs';
import { ACCOUNTS, rowDiff, rowSnapshot } from '../scripts/ui-check/real-suite-client.mjs';
import { pairLines, scoreCase } from '../scripts/ui-check/real-recognition-score.mjs';

const names = toolCatalog.map((t) => t.name);
const turn = (over = {}) => ({ text: '问', reply: '好的，查到了。', tools: [], calls: [], failed: [], executed: [], cards: [], ms: 1000, ...over });
const changedRow = (table) => ({ [table]: { added: 0, removed: 0, changed: 1 } });

test('场景定义：编号不重、账号认识、期望的工具都在目录里，目录里每个工具都有场景期望它', async () => {
  const scenes = await loadScenes();
  assert.deepEqual(validateScenarios(scenes, names, ACCOUNTS), []);
  const expected = expectedTools(scenes);
  assert.deepEqual(names.filter((n) => !expected.has(n)), [], '这些工具没有场景');
  for (const domain of ['access', 'gate', 'tools', 'flows', 'files', 'context', 'memory', 'diagnose', 'persona'])
    assert.ok(scenes.some((s) => s.domain === domain), '缺领域 ' + domain);
});

test('判定：该改没改是 B，不该改改了是 A，回答露工具名和“草稿”是 D', () => {
  const scene = { id: 'X', expect: { tools: ['records.propose_save'], rows: { customers: { changed: 1 } } } };
  const done = { turns: [turn({ tools: ['records.propose_save'] })], diff: changedRow('customers'), extraChecks: [{ name: '电话改对了', ok: true }] };
  assert.equal(worstLevel(judge(scene, done)), null);
  assert.equal(worstLevel(judge(scene, { ...done, diff: {} })), 'B');
  assert.equal(worstLevel(judge({ id: 'Y', expect: { writes: false } }, { turns: [turn()], diff: changedRow('orders') })), 'A');
  assert.equal(worstLevel(judge({ id: 'Z', expect: {} }, { turns: [turn({ reply: '已经调用 records.search 查好了草稿' })], diff: {} })), 'D');
});

test('判定：拒绝看服务器拒了或模型说不行；用了万能工具记成绕路', () => {
  const refused = { id: 'R', expect: { refused: true, writes: false } };
  assert.equal(worstLevel(judge(refused, { turns: [turn({ failed: [{ label: '查账号', message: '只有超级管理员账号能用这个工具。' }] })], diff: {} })), null);
  assert.equal(worstLevel(judge(refused, { turns: [turn({ reply: '这个账号没有权限，请找管理员' })], diff: {} })), null);
  // 没说清不行是 C；真写了由“业务数据没变”判 A
  assert.equal(worstLevel(judge(refused, { turns: [turn({ reply: '好的，查到了' })], diff: {} })), 'C');
  assert.equal(worstLevel(judge(refused, { turns: [turn({ reply: '好的，改好了' })], diff: changedRow('customers') })), 'A');
  const detour = judge({ id: 'M', expect: { tools: ['flow.propose_production_completion'] } }, { turns: [turn({ tools: ['management.execute', 'flow.propose_production_completion'] })], diff: {} });
  assert.ok(detour.some((c) => !c.ok && c.name === '没用万能工具绕路'));
});

test('判定：回答被换成套话、出卡片那一轮没说明是 B，没人点确认就有写入是 A', () => {
  const plain = { id: 'P', expect: {} };
  assert.equal(worstLevel(judge(plain, { turns: [turn({ reply: '这一轮没有保存任何修改，不能确认已经改好。' })], diff: {} })), 'B');
  const card = { id: 'card-1', label: '修改客户', state: 'waiting' };
  assert.equal(worstLevel(judge(plain, { turns: [turn({ reply: '', cards: [card] })], diff: {} })), 'B');
  assert.equal(worstLevel(judge(plain, { turns: [turn({ reply: '要把虚构客户甲的电话改成 0574-1111，卡片上核对后点确认。', cards: [card] })], diff: {} })), null);
  assert.equal(worstLevel(judge(plain, { turns: [turn({ unconfirmed: ['customers'] })], diff: changedRow('customers') })), 'A');
});

test('工具清单规则：只读账号清单里有写入工具、业务员清单里有只给超级管理员的工具都算问题', () => {
  assert.ok(toolListChecks('viewer', ['records.search', 'records.propose_save']).some((c) => !c.ok));
  assert.ok(toolListChecks('staff', ['records.search', 'accounts.list']).some((c) => !c.ok));
  assert.ok(toolListChecks('cashier', ['finance.cash', 'records.search']).some((c) => !c.ok));
  assert.ok(toolListChecks('viewer', ['records.search', 'task.finish', 'web.read']).every((c) => c.ok));
});

test('汇总：没被调到的工具、每类通过率', () => {
  const records = [
    { id: 'A', domain: 'tools', account: 'local', turns: [turn({ tools: ['records.search'] })], checks: [{ ok: true, level: 'C' }] },
    { id: 'B', domain: 'tools', account: 'staff', turns: [turn()], checks: [{ ok: false, level: 'B' }] },
  ];
  const s = summarize(records, ['records.search', 'records.get']);
  assert.deepEqual(s.uncalled, ['records.get']);
  assert.deepEqual(s.byDomain.tools, { total: 2, pass: 1 });
  assert.equal(s.levels.B, 1);
});

test('行快照：增删改各算各的；只变了版本号、修改时间算没改；没有主键的表按 rowid；助手自己的表不算', () => {
  const dir = mkdtempSync(join(tmpdir(), 'erp-real-suite-'));
  try {
    const db = new DatabaseSync(join(dir, 'erp.sqlite'));
    db.exec(`CREATE TABLE customers(id INTEGER PRIMARY KEY, name TEXT, phone TEXT, version INTEGER, updated_at TEXT);
      CREATE TABLE order_batch_purchases(batch_id INTEGER, purchase_id INTEGER, PRIMARY KEY(batch_id, purchase_id));
      CREATE TABLE notes(text TEXT);
      CREATE TABLE assistant_runs(id TEXT);
      INSERT INTO customers VALUES (1,'甲','1',1,'t1'),(2,'乙','2',1,'t1'),(3,'丙','3',1,'t1');
      INSERT INTO order_batch_purchases VALUES (1,1);
      INSERT INTO notes VALUES ('a');`);
    const before = rowSnapshot(dir);
    db.exec(`UPDATE customers SET version=2, updated_at='t2' WHERE id=1;
      UPDATE customers SET phone='22' WHERE id=2;
      DELETE FROM customers WHERE id=3;
      INSERT INTO customers VALUES (4,'丁','4',1,'t2');
      INSERT INTO order_batch_purchases VALUES (1,2);
      UPDATE notes SET text='b';
      INSERT INTO assistant_runs VALUES ('r1');`);
    db.close();
    assert.deepEqual(rowDiff(before, rowSnapshot(dir)), {
      customers: { added: 1, removed: 1, changed: 1 },
      order_batch_purchases: { added: 1, removed: 0, changed: 0 },
      notes: { added: 0, removed: 0, changed: 1 },
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('判定 rows：多一行是 A、少一行是 B，没写到的表动了是 A，记账表和写了 any 的不管', () => {
  const scene = { id: 'W', expect: { rows: { purchase_returns: { added: 1 }, stock_movements: { added: 'any' } } } };
  const ran = (diff) => worstLevel(judge(scene, { turns: [turn()], diff, extraChecks: [{ name: '退了 50 张', ok: true }] }));
  const one = { purchase_returns: { added: 1, removed: 0, changed: 0 } };
  assert.equal(ran(one), null);
  assert.equal(ran({ ...one, stock_movements: { added: 3, removed: 0, changed: 0 }, flow_refs: { added: 2, removed: 0, changed: 0 } }), null);
  assert.equal(ran({ purchase_returns: { added: 2, removed: 0, changed: 0 } }), 'A');
  assert.equal(ran({}), 'B');
  assert.equal(ran({ ...one, purchase_returns: { added: 1, removed: 0, changed: 1 } }), 'A');
  assert.equal(ran({ ...one, customers: { added: 0, removed: 1, changed: 0 } }), 'A');
  // 写入场景的 check 一条核对都没给：办没办对说不清，算办不成
  assert.equal(worstLevel(judge(scene, { turns: [turn()], diff: one, extraChecks: [] })), 'B');
});

test('场景定义：写入场景要用 rows 并带 check；rows 只认确切行数或 any', () => {
  const base = { account: 'local', turns: ['改'] };
  const problems = validateScenarios(
    [
      { ...base, id: 'P1', expect: { writes: ['customers'] } },
      { ...base, id: 'P2', expect: { writes: true } },
      { ...base, id: 'P3', expect: { rows: { customers: { changed: 1 } } } },
      { ...base, id: 'P4', expect: { rows: { customers: { changed: '1' }, orders: { touched: 1 } } }, check: () => [] },
      { ...base, id: 'P5', expect: { rows: { customers: { changed: 1 }, order_lines: 'any', orders: { added: 'any' } } }, check: () => [] },
    ],
    [],
    ACCOUNTS,
  );
  assert.deepEqual(problems.map((p) => p.split(' ')[0]), ['P1', 'P2', 'P3', 'P4', 'P4']);
});

test('重复跑：按场景算 k 轮过了几轮，pass^1 是所有轮次的通过率，pass^k 是轮轮都过的场景占比', () => {
  const run = (id, trial, ok) => ({ id, approach: 'high', domain: 'tools', account: 'local', trial, turns: [turn()], checks: [{ ok, level: 'B' }] });
  const records = [1, 2, 3].flatMap((k) => [run('稳', k, true), run('晃', k, k !== 2), run('坏', k, false)]);
  const t = summarize(records, []).trials;
  assert.deepEqual(t, { k: 3, pass1: 0.556, passK: 0.333, flaky: ['晃|high（2/3）'], failing: ['坏|high'] });
});

test('前后对比：重复跑的按场景合起来，有一轮选错就不算选对', () => {
  const scenes = [{ id: 'S', expect: { tools: ['records.search'] } }];
  const run = (trial, tools) => ({ id: 'S', approach: 'high', trial, turns: [turn({ tools })] });
  const c = compareRuns(scenes, [run(1, ['records.search']), run(2, ['records.search'])], [run(1, ['records.search']), run(2, [])]);
  assert.deepEqual([c.before.scenes, c.before.right, c.after.scenes, c.after.right], [1, 1, 1, 0]);
  assert.deepEqual(c.worse.map((w) => w.id), ['S']);
});

// 识别打分：明细行先配对再比（漏读、多读一行只算那一行，顺序颠倒不算错）
const L1 = { name: 'BC五层纸板', length: '1250', width: '1000', quantity: '600' };
const L2 = { name: 'B三层纸板', length: '900', width: '700', quantity: '1100' };
const L3 = { name: 'BE五层纸板', length: '1400', width: '1100', quantity: '300' };
const receipt = { kind: 'arrival', header: { supplierName: '虚构鼎盛纸业' }, lines: [L1, L2, L3] };
const read = (lines) => scoreCase(receipt, { supplierName: '虚构鼎盛纸业', lines });
const brief = (r) => ({ right: r.right, cells: r.cells, missingLines: r.missingLines, extraLines: r.extraLines });

test('识别打分：漏一行只少那一行，后面的行不跟着错', () => {
  assert.deepEqual(brief(read([L1, L3])), { right: 9, cells: 9, missingLines: 1, extraLines: 0 });
});

test('识别打分：多一行单独记，原有的行照样全对', () => {
  const extra = { name: '虚构多出的纸板', length: '500', width: '400', quantity: '10' };
  assert.deepEqual(brief(read([L1, extra, L2, L3])), { right: 13, cells: 13, missingLines: 0, extraLines: 1 });
});

test('识别打分：两行顺序颠倒照样全对；读错一栏的行仍配上、只错那一栏', () => {
  assert.deepEqual(brief(read([L2, L1, L3])), { right: 13, cells: 13, missingLines: 0, extraLines: 0 });
  assert.deepEqual(brief(read([L1, { ...L2, quantity: '1000' }, L3])), { right: 12, cells: 13, missingLines: 0, extraLines: 0 });
  // 品名、规格、数量一栏都对不上的不硬配：记漏一行、多一行
  const asRead = (l) => Object.fromEntries(Object.entries(l).map(([k, v]) => [k, { value: v }]));
  assert.deepEqual(pairLines([L1, L2], [asRead({ name: '别的东西', length: '1', width: '2', quantity: '3' }), asRead(L1)]), [1, -1]);
});
