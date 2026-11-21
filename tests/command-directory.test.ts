// 命令目录（server/assistant/command-directory.ts）：目录文字、用法、找命令、常用名单。直接调纯函数，输入是注册表按账号给出的可用命令。
import { pageActor, actor, superActor } from './actor-fixture.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod';
import { AssistantToolRegistry } from '../server/assistant/tool-registry.js';
import { toolCatalog, toolDefinitions } from '../server/assistant/tool-catalog.js';
import { trimSchema } from '../server/assistant/chat/model-tools.js';
import {
  commandDirectory,
  commandTools,
  commandUsage,
  commandUsages,
  commandLabel,
  commonCommands,
  findCommands,
  firstSentence,
} from '../server/assistant/command-directory.js';
import { FILTER_KEYS_HINT } from '../server/assistant/tools/records-filter.js';
import { AssistantTools } from '../server/assistant/tools.js';
import { Store } from '../server/core/db.js';
import type { Actor } from '../server/core/index.js';
import { field } from '../server/assistant/chat/result-fields.js';
import { readAs } from './read-result.js';

const cashier = pageActor({ id: 'dir-cashier', name: '虚构出纳', permissions: ['finance:view', 'finance:cash'], role: 'admin' });
function usableFor(who: Actor) {
  const registry = new AssistantToolRegistry(':memory:', () => true);
  try {
    return registry.exposed(who);
  } finally {
    registry.close();
  }
}
function named<T extends { name: string }>(items: readonly T[], name: string) {
  const item = items.find((entry) => entry.name === name);
  assert.ok(item, name);
  return item;
}
const describe = (name: string) => named(toolCatalog, name).description;
const parameterShape = z.looseObject({
  properties: z.record(z.string(), z.unknown()).optional(),
  required: z.array(z.string()).optional(),
  anyOf: z.array(z.unknown()).optional(),
  oneOf: z.array(z.unknown()).optional(),
});
function keys(value: unknown): string[][] {
  const s = parameterShape.parse(value);
  return s.properties ? [Object.keys(s.properties).sort(), [...(s.required ?? [])].sort()] : (s.anyOf ?? s.oneOf ?? []).flatMap(keys);
}
const lineOf = (name: string) => new RegExp('^' + name.replace(/\./g, '\\.') + '：', 'gm');

test('目录：这个账号能用的命令每条恰好出现一次，按组分小节；没权限的不出现', () => {
  for (const who of [superActor(), actor, cashier]) {
    const usable = usableFor(who),
      text = commandDirectory(usable);
    for (const c of usable) assert.equal(text.match(lineOf(c.name))?.length, 1, c.name);
    assert.equal(text.split('\n').filter((l) => /^[a-z_]+\.[a-z_.]+：/.test(l)).length, usable.length);
    for (const group of new Set(usable.map((c) => c.module))) assert.match(text, new RegExp('^## ' + group + '$', 'm'));
    for (const c of toolCatalog.filter((t) => !usable.some((u) => u.name === t.name))) assert.doesNotMatch(text, lineOf(c.name), c.name);
  }
  // 业务员看不到只给超级管理员的；出纳只看得到财务和白名单里的，看不到业务记录
  assert.doesNotMatch(commandDirectory(usableFor(actor)), lineOf('accounts.list'));
  const cashierText = commandDirectory(usableFor(cashier));
  assert.match(cashierText, lineOf('finance.receivables'));
  assert.doesNotMatch(cashierText, lineOf('records.search'));
});

test('用法：完整说明加精简后的参数结构，参数名和必填与 Zod 结构一致；不能用的命令说清楚', () => {
  const usable = usableFor(superActor());
  for (const c of usable) {
    const text = commandUsage(c);
    const shown: unknown = JSON.parse(text.slice(text.lastIndexOf('\n参数：') + 4));
    assert.ok(text.includes(c.description), c.name);
    const schema = named(toolDefinitions, c.name).schema;
    assert.deepEqual(keys(shown), keys(trimSchema(z.toJSONSchema(schema))), c.name);
  }
  const two = commandUsages(usable, ['records.get', 'no.such']);
  assert.match(two, /### records\.get\n/);
  assert.match(two, /### no\.such\n没有这条命令，或当前账号不能用。/);
});

test('找命令：中文关键词能找到（到货、完工、应收、归档），连写的词也行；对不上的不返回', () => {
  const usable = usableFor(superActor());
  const top = (q: string, n = 5) => findCommands(usable, q, n).map((r) => r.name);
  assert.ok(top('到货 入库').includes('order_batch.receive'), top('到货 入库').join());
  assert.ok(top('登记到货').includes('order_batch.receive'), top('登记到货').join());
  assert.ok(top('完工').includes('flow.propose_production_completion'), top('完工').join());
  assert.ok(top('应收').includes('finance.receivables'), top('应收').join());
  assert.ok(top('归档').includes('records.propose_lifecycle'), top('归档').join());
  assert.deepEqual(findCommands(usable, '虚构不存在的词xyz'), []);
  const one = findCommands(usable, '应收', 1)[0];
  assert.equal(one.summary, firstSentence(named(usable, one.name).description));
});

test('常用名单是固定的十三条、名字都是注册过的命令；三个通用工具名字合法', () => {
  assert.equal(commonCommands.length, 13);
  for (const name of commonCommands) assert.ok(toolCatalog.some((t) => t.name === name), name);
  assert.deepEqual(commandTools.map((t) => t.function.name), ['find_command', 'command_usage', 'run_command']);
  for (const t of commandTools) assert.match(t.function.name, /^[a-zA-Z0-9_-]{1,64}$/);
});

test('找命令按人会怎么说：每个常用说法都能在前三条里找到对的那条命令', () => {
  const usable = usableFor(superActor());
  const cases: [string, string][] = [
    ['到货记录', 'arrival.records'],
    ['登记到货', 'order_batch.receive'],
    ['更正到货', 'arrival.correct'],
    ['更正送货单', 'delivery.correct'],
    ['完工数量登记错了', 'production.correct'],
    ['改备注', 'flow.edit_info'],
    ['批次备注', 'flow.edit_info'],
    ['登记完工', 'flow.propose_production_completion'],
    ['安排送货', 'delivery.plan'],
    ['安排生产', 'production.plan'],
    ['应收', 'finance.receivables'],
    ['应付', 'finance.payables'],
    ['盘点', 'inventory.propose_movement'],
    ['归档', 'records.propose_lifecycle'],
    ['修改历史', 'history.records'],
    ['使用说明', 'guide.read'],
    ['收件箱', 'inbox.list'],
    ['导出送货单', 'documents.export'],
    ['订货单', 'order_batch.get'],
  ];
  for (const [said, name] of cases) {
    const found = findCommands(usable, said, 3).map((r) => r.name);
    assert.ok(found.includes(name), said + ' → ' + found.join('、'));
  }
});

test('每条命令的说明不超过 200 字（命令目录里只印第一句，整段在查用法时给）', () => {
  for (const t of toolCatalog) assert.ok([...t.description].length <= 200, t.name + ' 的说明 ' + [...t.description].length + ' 字');
});

test('查记录的筛选键写在参数结构里；写错键时报错列出能用的键，不接受别名', () => {
  for (const name of ['records.search', 'records.summarize']) {
    const schema = named(toolDefinitions, name).schema;
    const shown = readAs(z.toJSONSchema(schema), {
      properties: z.looseObject({ filters: z.looseObject({ properties: z.looseObject({}) }) }),
    });
    assert.ok(shown.properties.filters.properties.customerId && shown.properties.filters.properties.q, name + ' 的参数结构里看得到筛选键');
    for (const wrong of ['orderId', 'name', 'keyword', 'number', 'orderDate', 'date']) {
      const r = schema.safeParse({ module: 'orders', filters: { [wrong]: 1 } });
      assert.equal(r.success, false, wrong + ' 不该被接受');
      assert.ok(r.error.issues.some((i) => i.message.includes('没有“' + wrong + '”') && i.message.includes(FILTER_KEYS_HINT)), wrong + '：' + JSON.stringify(r.error.issues));
    }
  }
});

test('页面上的命令叫法（状态行、“没做成”那一行）是中文：不带英文字母（AI、ERP 除外），也不说“用户”', () => {
  for (const t of toolCatalog) {
    const label = commandLabel(t.description, t.name);
    assert.doesNotMatch(label.replace(/AI|ERP/g, ''), /[A-Za-z]/, t.name + '：' + label);
    assert.doesNotMatch(label, /用户/, t.name + '：' + label);
  }
});

test('相近命令的说明互相分得开（真实模型选错过的几对）', () => {
  // 看订货单文件内容和查到货进度分得开（真实模型曾把“看订货单内容”选成 order_batch.get）
  assert.match(describe('documents.preview'), /文件上写的是什么.*查到货进度用 order_batch\.get/);
  assert.match(describe('order_batch.get'), /到货进度.*文件上写的内容用 documents\.preview/);
  // 问合计先想到汇总，不翻页自己加；查记录没提归档就不带“含已归档”（那要超级管理员模式）
  assert.match(describe('records.summarize'), /^汇总合计：问合计.*不要用 records\.search 翻页自己加/);
  assert.match(describe('records.search'), /问合计用 records\.summarize.*lifecycle=all 要超级管理员模式.*没提归档就不要带/);
  // 删除就是物理删除，出确认卡片
  assert.match(describe('records.delete'), /确认执行.*卡片.*待确认/);
});

test('从提示词里删掉的用法句，在命令说明或查字段写法里能找到；查字段写法（describe）给出和人工表单同一份参数结构，流水没有，没登录拒绝', () => {
  assert.match(describe('records.propose_save'), /describe:true.*查不到档案.*直接新建.*选填项留空.*改订单、采购状态在 patch 写 status.*导出订货单会自动标已订货/);
  assert.match(describe('flow.propose_confirmation'), /不能确认订单，订单用 records\.propose_save 改 status/);
  assert.match(describe('finance.receivables'), /应收为空不等于不欠.*finance\.monthly/);
  assert.match(describe('finance.monthly'), /理论和实际分开说/);
  assert.match(describe('order_batch.receive'), /不合格 rejectedQuantity（没有写 0.*reference 是送货单号，没给就不填/);
  // 采购单的字段写法（按面积还是按张计价、库存品留空、纸板没有高度、不关联订单当备货）在查字段写法的结果里
  const store = new Store(':memory:');
  try {
    const tools = new AssistantTools(store),
      got = readAs(tools.read('records.search', { module: 'purchases', describe: true }, actor), {});
    const text = JSON.stringify(got.dependencies);
    for (const words of ['每平方米', 'stockItemId', '高度传 null', '备货']) assert.ok(text.includes(words), words);
    const customers = readAs(tools.read('records.search', { module: 'customers', describe: true }, actor), {});
    assert.equal(customers.module, 'customers');
    assert.ok(customers.inputSchema && customers.template);
    const movements = readAs(tools.read('records.search', { module: 'movements', describe: true }, actor), {});
    assert.deepEqual([movements.inputSchema, movements.template], [null, null]);
    assert.throws(() => tools.read('records.search', { module: 'customers', describe: true }, null), (e: unknown) => field(e, 'status') === 401);
  } finally {
    store.close();
  }
});
