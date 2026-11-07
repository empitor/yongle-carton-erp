// 小甬和小勒的分工、接力和提示词结构。模型都是替身，数据都是虚构的。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { assistantFixture, actor } from './assistant-fixture.js';
import { PromptPresetManager } from '../server/ai/prompt-presets.js';
import { assistantDefaultPreset } from '../server/assistant/manager.js';
import { legacyAssistantDefaults } from '../server/assistant/default-preset.js';
import { normalizeAssistantReply } from '../server/assistant/reply.js';
import { assistantSystemPrompt } from '../server/assistant/system-prompt.js';
import { financeAmountsInYuan, readFinanceTool } from '../server/finance/assistant.js';
import { chatDeleteAuthorized, startsIndependentTask } from '../server/assistant/task-routing.js';
import { hasDsml } from '../server/ai/protocol-diagnostics.js';
import { namedRecordIds } from '../server/assistant/record-selection.js';
import { sameProductInBatch } from '../shared/product-details.js';
import { Store } from '../server/db.js';
import { sameSpecification } from '../shared/domain.js';
import { financeReadTools, financeToolDescriptions } from '../shared/finance-tools.js';
import {
  readSpeaker,
  speakerForTools,
  speakerNames,
} from '../shared/assistant-personas.js';

const say = async (f: ReturnType<typeof assistantFixture>, thread: string, text: string) => {
  const events: { event: string; data: any }[] = [];
  await f.manager.chat(
    thread,
    f.input(text, randomUUID()),
    actor,
    'session',
    (event, data) => events.push({ event, data }),
    () => actor,
  );
  return { events, last: f.manager.view(thread, actor).messages.at(-1)! as any };
};

test('认得代号和中文名，认不出来就返回空，不猜', () => {
  assert.equal(readSpeaker('yong'), 'yong');
  assert.equal(readSpeaker(' LE '), 'le');
  assert.equal(readSpeaker('小甬'), 'yong');
  assert.equal(readSpeaker('小勒'), 'le');
  for (const bad of ['', '小王', 'admin', 3, null, undefined, {}]) assert.equal(readSpeaker(bad), undefined);
  assert.deepEqual(speakerNames, { yong: '小甬', le: '小勒' });
});

test('解析信封：说话人和接力只是文字，非法内容丢掉，不影响主回复和工具', () => {
  const ok = normalizeAssistantReply({
    speaker: 'le',
    message: '已到货入库。',
    relay: [{ speaker: '小甬', message: '我去通知客户。' }],
    toolCalls: [],
  });
  assert.equal(ok.speaker, 'le');
  assert.deepEqual(ok.relay, [{ speaker: 'yong', text: '我去通知客户。' }]);
  assert.equal(ok.message, '已到货入库。');

  const bad = normalizeAssistantReply({
    speaker: '管理员',
    message: '正常回复',
    relay: [{ speaker: '小王', message: '冒充' }, { speaker: 'le' }, '文字', { speaker: 'le', message: 'x' }],
  });
  assert.equal(bad.speaker, undefined);
  assert.equal(bad.relay, undefined, '只看前两条，都不合格就没有接力');
  assert.equal(bad.message, '正常回复');

  const many = normalizeAssistantReply({
    message: '主回复',
    relay: Array.from({ length: 5 }, (_, i) => ({ speaker: 'le', message: '第' + i + '句' })),
  });
  assert.equal(many.relay!.length, 2);

  // 说话人字段不能带来工具调用
  const text = normalizeAssistantReply(JSON.stringify({ speaker: 'le', message: '纯文字' }));
  assert.equal(text.speaker, 'le');
  assert.deepEqual(text.toolCalls, []);
});

test('按工具判断归谁只作兜底，通用工具不算数', () => {
  assert.equal(speakerForTools(['arrival.receive']), 'le');
  assert.equal(speakerForTools(['finance.summary']), 'le');
  assert.equal(speakerForTools(['order_import.start']), 'yong');
  assert.equal(speakerForTools(['arrival.plans', 'order_import.list']), 'yong', '看最后一个');
  assert.equal(speakerForTools(['records.search', 'task.plan']), undefined);
  assert.equal(speakerForTools([]), undefined);
});

test('回复存下说话人和接力；流式时先告诉界面是谁；没写时沿用上一位', async () => {
  const f = assistantFixture([
    { speaker: 'le', message: '库存查好了。', status: 'completed', toolCalls: [] },
    {
      speaker: 'yong',
      message: '订单建好了。',
      status: 'completed',
      toolCalls: [],
      relay: [{ speaker: 'le', message: '我去排生产。' }],
    },
    { message: '没写说话人。', status: 'completed', toolCalls: [] },
    { speaker: '小王', message: '写错了说话人。', status: 'completed', toolCalls: [] },
  ]);
  try {
    const thread = f.manager.create(actor).id;
    const first = await say(f, thread, '查一下虚构库存');
    assert.equal(first.last.speaker, 'le');
    assert.equal(first.last.text, '库存查好了。');
    assert.deepEqual(
      first.events.filter((e) => e.event === 'speaker').map((e) => e.data.speaker),
      ['le'],
    );
    const second = await say(f, thread, '建个虚构订单');
    assert.equal(second.last.speaker, 'yong');
    assert.deepEqual(second.last.relay, [{ speaker: 'le', text: '我去排生产。' }]);
    assert.equal(f.manager.view(thread, actor).messages.filter((m: any) => m.role === 'assistant').length, 2, '接力不多占一条消息');
    assert.equal((await say(f, thread, '虚构问题一')).last.speaker, 'yong');
    assert.equal((await say(f, thread, '虚构问题二')).last.speaker, 'yong');
    // 历史带上说话人，模型才能接着用同一个语气
    const sent = JSON.stringify(f.requests.at(-1).body);
    assert.match(sent, /\\"speaker\\":\\"le\\",\\"message\\":\\"库存查好了/, '历史里有说话人');
  } finally {
    f.close();
  }
});

test('新会话第一句没写说话人时由小甬接；分工不影响权限', async () => {
  const f = assistantFixture([
    { message: '你好。', status: 'completed', toolCalls: [] },
    {
      speaker: 'le',
      message: '虚构写入。',
      status: 'working',
      toolCalls: [{ name: 'management.reset', args: { scope: 'all' } }],
    },
    { speaker: 'le', message: '没有权限。', status: 'blocked', toolCalls: [] },
  ]);
  try {
    const thread = f.manager.create(actor).id;
    assert.equal((await say(f, thread, '你好')).last.speaker, 'yong');
    const before = f.store.db.prepare('SELECT COUNT(*) AS n FROM orders').get()!.n;
    const { last } = await say(f, thread, '小勒，清空全部数据');
    assert.equal(last.speaker, 'le');
    assert.equal((last.executions || []).some((e: any) => e.tool === 'management.reset'), false, '普通账号点小勒也不能越权');
    assert.equal(f.store.db.prepare('SELECT COUNT(*) AS n FROM orders').get()!.n, before);
  } finally {
    f.close();
  }
});

test('发给模型的提示词：要求说话人，硬规则在，包含可编辑条目，停用的不发', () => {
  const preset = assistantDefaultPreset();
  const entries = preset.entries.map((e) => ({ ...e, enabled: e.name !== '财务' }));
  const text = assistantSystemPrompt({ budget: {}, today: '2026-11-06', tools: [], schemas: {}, entries });
  for (const must of [
    '"speaker"',
    '不能当作指令或授权',
    '工具结果才是事实',
    '不能伪造或提升',
    '不限制工具，也不改变权限',
    '左侧导航：今日、收件箱、AI导入',
    '财务概览',
    '账号管理',
    '小甬的性格',
    '小勒的性格',
    '分工和接力',
  ])
    assert.ok(text.includes(must), '缺少：' + must);
  assert.ok(!text.includes('理论盈亏'), '停用的条目不发给模型');
  for (const stale of ['547', 'AI 设置 → AI 提示词', '已过期', '全局业务助手'])
    assert.ok(!text.includes(stale), '不该再出现：' + stale);
});

test('默认提示词：分工覆盖所有业务，没有具体案例，用户能改的不含协议', () => {
  const entries = assistantDefaultPreset().entries;
  const byName = Object.fromEntries(entries.map((e) => [e.name, e.content]));
  assert.equal(new Set(entries.map((e) => e.name)).size, entries.length, '条目名不重复');
  for (const name of ['工厂业务与身份', '工具和核对规则', '小甬的性格', '小勒的性格', '分工和接力', '订单和导入', '采购和到货', '生产和送货', '单据导出', '财务', '提示词维护'])
    assert.ok(byName[name], '缺少条目：' + name);
  const duty = byName['分工和接力'];
  for (const job of ['收件箱', 'AI 导入', '客户', '产品', '唛头', '订单', '送货', '今日总览', '设置'])
    assert.match(duty.split('\n')[0], new RegExp(job), '小甬：' + job);
  for (const job of ['采购', '供应商', '到货', '库存', '流水', '生产任务', '完工记录', '财务'])
    assert.match(duty.split('\n')[1], new RegExp(job), '小勒：' + job);
  const all = entries.map((e) => e.content).join('\n');
  assert.doesNotMatch(all, /547|巴山/);
  for (const rule of ['不换算', '不默认含税', '四位小数', '红字冲销', '理论盈亏', '缺税率不卡业务', '只能查询'])
    assert.ok(all.includes(rule), '缺少业务规则：' + rule);
  // 工具名都得是真的：写错了模型会调用失败
  for (const tool of ['records.delete', 'records.propose_lifecycle', 'management.reset', 'order_import.start', 'order_import.from_inbox', 'arrival.receive', 'flow.daily', 'documents.export', 'prompts.propose'])
    assert.ok(all.includes(tool), tool);
});

test('没改过的默认预设升级到新版本；改过的只补缺少的条目，原内容不动', () => {
  const manager = new PromptPresetManager(':memory:', assistantDefaultPreset);
  try {
    const untouched = legacyAssistantDefaults[0];
    const custom = {
      id: randomUUID(),
      name: '虚构自定义预设',
      entries: [
        { id: randomUUID(), name: '工厂业务与身份', enabled: true, content: '虚构的自定义身份' },
        { id: randomUUID(), name: '虚构自己的规则', enabled: false, content: '虚构内容' },
      ],
    };
    manager.change('save', { expectedRevision: 0, preset: untouched, activate: true });
    manager.change('save', { expectedRevision: 1, preset: custom, activate: false });
    manager.upgradeUntouchedDefaults(legacyAssistantDefaults, 'test-duo');
    manager.addMissingDefaultEntries('test-duo-entries');
    const state = manager.view();
    const latest = assistantDefaultPreset().entries.map((e) => e.name);
    const a = state.presets.find((p) => p.id === untouched.id)!;
    assert.deepEqual(a.entries.map((e) => e.name), latest, '没改过的直接换成新版');
    const b = state.presets.find((p) => p.id === custom.id)!;
    assert.equal(b.entries[0].content, '虚构的自定义身份', '改过的内容不动');
    assert.equal(b.entries[1].enabled, false, '停用状态不动');
    for (const name of latest) assert.ok(b.entries.some((e) => e.name === name), '补上：' + name);
    assert.equal(b.entries.filter((e) => e.name === '工厂业务与身份').length, 1, '已有的不重复加');
    // 再跑一次不再变化，用户删掉的条目也不会被加回来
    const revision = state.revision;
    manager.addMissingDefaultEntries('test-duo-entries');
    assert.equal(manager.view().revision, revision);
  } finally {
    manager.close();
  }
});

// ---- 以下来自真实模型试聊发现的问题 ----
test('规格只差排版不算不同：完工自动建的成品档案能给订单发货', () => {
  const stock = '300 × 200 × 150 mm / K=A / BC楞 / 四色印刷';
  assert.equal(sameSpecification(stock, '300×200×150mm K=A BC楞 四色印刷'), true);
  assert.equal(sameSpecification('300*200*150MM', '300x200x150mm'), true);
  assert.equal(sameSpecification(stock, '300×200×160mm K=A BC楞 四色印刷'), false, '尺寸不同还是要拦');
  assert.equal(sameSpecification('K=A BC楞', 'K=K BC楞'), false, '材质不同还是要拦');
});

test('真实试聊：模型的话不被模板盖掉', async () => {
  const f = assistantFixture([
    // 写入成功：性格文字保留，回执附在后面
    {
      speaker: 'le',
      message: '建好了，虚构供应商已入档。',
      status: 'working',
      toolCalls: [{ name: 'records.propose_save', args: { module: 'suppliers', patch: { name: '虚构真实试聊供应商' } } }],
    },
    { speaker: 'le', message: '建好了，虚构供应商已入档。', status: 'completed', toolCalls: [] },
    // 明确拒绝：解释原样给用户
    { speaker: 'le', message: '记账我做不了，请到资金发票页面录入。', status: 'blocked', toolCalls: [] },
    // 工具失败后换办法查到：不报已解决的错误
    { speaker: 'le', message: '先试一下', status: 'working', toolCalls: [{ name: 'records.search', args: { module: 'orders', filters: '不是对象' } }] },
    { speaker: 'le', message: '换个查法', status: 'working', toolCalls: [{ name: 'records.search', args: { module: 'orders', filters: {} } }] },
    { speaker: 'le', message: '查到了，一张也没有。', status: 'completed', toolCalls: [] },
    // 接力和主回复同一个人时丢掉
    { speaker: 'yong', message: '好的。', status: 'completed', toolCalls: [], relay: [{ speaker: 'yong', message: '我再说一句' }] },
  ]);
  try {
    const thread = f.manager.create(actor).id;
    const created = (await say(f, thread, '新建供应商：虚构真实试聊供应商')).last;
    assert.match(created.text, /建好了/);
    assert.match(created.text, /已实际执行/, '回执还在');
    assert.equal(created.speaker, 'le');

    const refused = (await say(f, thread, '帮我记一笔虚构收款')).last;
    assert.equal(refused.text, '记账我做不了，请到资金发票页面录入。');

    const recovered = (await say(f, thread, '查一下虚构订单')).last;
    assert.equal(recovered.text, '查到了，一张也没有。');
    assert.ok(recovered.events.some((e: any) => e.state === '未执行'), '确实失败过一次');

    const same = (await say(f, thread, '虚构问候')).last;
    assert.equal(same.relay, undefined);
  } finally {
    f.close();
  }
});

test('真实试聊：完全没写内容或循环无果时，仍然给服务器的说明', async () => {
  const f = assistantFixture([{ speaker: 'le', message: '', status: 'blocked', toolCalls: [] }]);
  try {
    const thread = f.manager.create(actor).id;
    const { last } = await say(f, thread, '虚构请求');
    assert.ok(last.text.trim().length > 0);
  } finally {
    f.close();
  }
});

test('财务工具各有说明；理论和实际盈亏不用启用财务也能查', () => {
  const texts = financeReadTools.map((name) => financeToolDescriptions[name]);
  assert.equal(new Set(texts).size, financeReadTools.length, '说明不能都一样');
  assert.match(financeToolDescriptions['finance.monthly'], /理论盈亏.*实际盈亏/);
  const store = new Store(':memory:');
  try {
    const data: any = readFinanceTool(
      store,
      { id: 'finance-reader', name: '虚构财务', permissions: ['finance:view'] } as any,
      'finance.monthly',
      {},
    );
    assert.ok(data, '没启用财务也有结果');
    assert.throws(
      () => readFinanceTool(store, { id: 'no', name: '虚构只读', permissions: [] } as any, 'finance.monthly', {}),
      /权限/,
    );
  } finally {
    store.close();
  }
});

test('提示词里写进了试聊学到的规则', () => {
  const all = assistantDefaultPreset().entries.map((e) => e.content).join('\n');
  for (const rule of ['重新判断谁来答', '不跟着上一条走', '不要问“新建还是关联”', '先回答新问题', 'flow.propose_confirmation 只确认', '问盈亏用 finance.monthly', '也不能用页面操作代替'])
    assert.ok(all.includes(rule), rule);
});

test('上一版默认预设也能认出来并升级', () => {
  const manager = new PromptPresetManager(':memory:', assistantDefaultPreset);
  try {
    const previous = legacyAssistantDefaults[0];
    assert.ok(previous.entries.some((e) => e.name === '小甬的性格'), '第一条是上一版双精灵默认');
    manager.change('save', { expectedRevision: 0, preset: previous, activate: true });
    manager.upgradeUntouchedDefaults(legacyAssistantDefaults, 'test-duo-v2');
    const all = manager.view().presets[0].entries.map((e) => e.content).join('\n');
    assert.ok(all.includes('重新判断谁来答'));
  } finally {
    manager.close();
  }
});

test('财务金额给模型前换成元：曾把 7692.60 元说成 76.9 万', () => {
  const out: any = financeAmountsInYuan({
    ordered: 769260,
    theoreticalProfit: -12345,
    missingPrice: 3,
    filteredRecords: 2,
    page: 1,
    rows: [{ amount: 5, partyId: 7, overdueDays: 30, remainingAmount: 100 }],
  });
  assert.equal(out.ordered, '7692.60');
  assert.equal(out.theoreticalProfit, '-123.45');
  assert.equal(out.missingPrice, 3, '条数不换');
  assert.equal(out.filteredRecords, 2);
  assert.equal(out.page, 1);
  assert.equal(out.rows[0].amount, '0.05');
  assert.equal(out.rows[0].partyId, 7);
  assert.equal(out.rows[0].overdueDays, 30);
  assert.equal(out.rows[0].remainingAmount, '1.00');
});

test('上一件事没答完时，问情况的话另起一件事；回答问题的话还接着上一件', () => {
  const current: any = { goal: '建虚构采购单', state: 'needs_input', memory: {} };
  for (const text of ['订单现在是什么状态？', '今天生产、到货、送货分别有什么？', '库存还有多少', '有没有逾期的单子'])
    assert.equal(startsIndependentTask(text, current), true, text);
  for (const text of ['留空', '新建一个', '单位是张', '继续'])
    assert.equal(startsIndependentTask(text, current), false, text);
});

test('同一批导入：名称尺寸相同、其他不冲突才复用，加工要求不同不算冲突', () => {
  const box = { name: '虚构邮购盒', length: 88, width: 15, height: 5.5, dimensionUnit: 'cm', material: '', flute: '', requirements: '', customerProductCode: '' };
  assert.equal(sameProductInBatch(box, { ...box, requirements: '按虚构文件打印' }), true);
  assert.equal(sameProductInBatch(box, { ...box, material: 'K=A' }), true, '一边没写不算冲突');
  assert.equal(sameProductInBatch({ ...box, material: 'K=K' }, { ...box, material: 'K=A' }), false);
  assert.equal(sameProductInBatch(box, { ...box, height: 6 }), false);
  assert.equal(sameProductInBatch(box, { ...box, name: '虚构别的盒' }), false);
  assert.equal(sameProductInBatch(box, { ...box, length: 880, width: 150, height: 55, dimensionUnit: 'mm' }), true, '换算后相同');
  assert.equal(sameProductInBatch(box, { ...box, dimensionUnit: null }), false, '一边没单位不猜');
  assert.equal(sameProductInBatch({ ...box, length: null }, { ...box, length: null }), false, '没尺寸不猜');
});

test('上一版默认提示词能被认出并升到新版', () => {
  const previous = legacyAssistantDefaults[1].entries.map((e) => e.content).join('\n');
  assert.equal(previous.includes('选填项'), false);
  assert.equal(previous.includes('createMissingFinished'), false);
  assert.equal(previous.includes('当备货'), false);
  assert.equal(previous.includes('采购单已经发出对应“已订货”'), true);
});

test('用户只说产品名前半截时，这段只有一条档案有才算点名', () => {
  const rows = [
    { id: 1, name: '虚构清洁器杆子邮购盒' },
    { id: 2, name: '第五代虚构清洁器纸箱（电商）' },
    { id: 3, name: '第五代虚构清洁器外箱（双瓦楞）（电商）' },
  ];
  assert.deepEqual(namedRecordIds('给第五代虚构清洁器外箱（双瓦楞）排生产', rows), [3]);
  assert.deepEqual(namedRecordIds('第五代虚构清洁器纸箱做完了', rows), [2]);
  assert.deepEqual(namedRecordIds('第五代虚构清洁器排生产', rows), [], '两条共有，是真歧义');
  assert.deepEqual(namedRecordIds('虚构清洁器排生产', rows), [], '三条共有');
  assert.deepEqual(namedRecordIds('随便说点别的', rows), []);
});

test('计划里的步骤没带 requestId，执行时带了，也算同一步，不会一直挂着', () => {
  const f = assistantFixture();
  try {
    const t = f.manager.create(actor);
    f.manager.tasks.plan(
      t.id,
      actor,
      { goal: '登记虚构到货', steps: [{ label: '登记到货', tool: 'arrival.receive', args: { purchaseId: 1, quantity: '3' } }] },
      () => {},
    );
    const step = f.manager.tasks.stage(
      t.id,
      actor,
      { name: 'arrival.receive', args: { purchaseId: 1, quantity: '3', requestId: 'r-1' } },
      '登记虚构到货',
      {},
    );
    const all = f.manager.tasks.get(t.id, actor)!.steps.filter((s) => s.tool === 'arrival.receive');
    assert.equal(all.length, 1);
    assert.equal(all[0].id, step.id);
    assert.equal(all[0].label, '登记到货');
  } finally {
    f.close();
  }
});

test('没调用工具却说做完了：先让模型重来，还这样就不算数', async () => {
  const f = assistantFixture([
    { speaker: 'le', message: '已完成完工入库。\n已实际执行：生产完工、领料及成品入库', status: 'completed', toolCalls: [] },
    { speaker: 'le', message: '已完成完工入库。\n已实际执行：生产完工', status: 'completed', toolCalls: [] },
  ]);
  try {
    const t = f.manager.create(actor);
    const { last } = await say(f, t.id, '虚构箱这个生产任务做完了，合格10个');
    const text = last.text;
    assert.equal(f.calls(), 2);
    assert.doesNotMatch(text, /已实际执行/);
    assert.match(text, /不能确认/);
  } finally {
    f.close();
  }
});

test('财务月度：模型传 date 也按那个月查，不退回本月', () => {
  const store = new Store(':memory:');
  try {
    const out: any = readFinanceTool(store, { id: 'finance-reader', name: '虚构财务', permissions: ['finance:view'] } as any, 'finance.monthly', { date: '2026-10-01' });
    assert.equal(out.period, '2026-10');
  } finally {
    store.close();
  }
});

test('DSML 标记的各种写法都认得', () => {
  assert.equal(hasDsml('{"q":"x"}</｜｜DSML｜｜ parameter>'), true);
  assert.equal(hasDsml('<|DSML|invoke>'), true);
  assert.equal(hasDsml('普通回复'), false);
});

test('删聊天记录要用户本人明确说：这一条说了，或者上一条说了这一条确认', () => {
  for (const text of ['把历史聊天记录全部删掉', '清空聊天记录', '删除这个会话', '这些对话都删了'])
    assert.equal(chatDeleteAuthorized(text), true, text);
  assert.equal(chatDeleteAuthorized('确认', '把聊天记录都删了'), true);
  assert.equal(chatDeleteAuthorized('好的', '把聊天记录都删了'), true);
  for (const text of ['确认', '把订单删了', '继续', '看看今天的库存'])
    assert.equal(chatDeleteAuthorized(text), false, text);
  assert.equal(chatDeleteAuthorized('确认这张虚构订单可以发货了吗', '把聊天记录都删了'), false, '不是确认删除');
});

test('助手删聊天：只删自己的；没授权不删；当前会话等回复发完再清；业务数据不动', async () => {
  const del = (args: any) => ({ message: '好', toolCalls: [{ name: 'chat.delete', args }] });
  const f = assistantFixture([
    del({ all: true }),
    { message: '没有删', status: 'blocked', toolCalls: [] },
    { message: '没有删', status: 'blocked', toolCalls: [] },
    { message: '没有删', status: 'blocked', toolCalls: [] },
    { message: '没有删', status: 'blocked', toolCalls: [] },
    del({ all: true, includeCurrent: true }),
    { message: '都删了。', status: 'completed', toolCalls: [] },
  ]);
  try {
    const other = { ...actor, id: 'other-user', name: '虚构别人' };
    const theirs = f.manager.create(other as any);
    const a = f.manager.create(actor),
      b = f.manager.create(actor),
      current = f.manager.create(actor);
    f.store.db
      .prepare("INSERT INTO assistant_messages(id,thread_id,role,text,document,created_at) VALUES('m-a',?,'user','旧聊天','{}','2026-01-01')")
      .run(a.id);
    const count = () => Number(f.store.db.prepare('SELECT COUNT(*) n FROM assistant_threads WHERE user_id=?').get(actor.id)!.n);
    // 模型自己要删，用户没说：拦住
    await say(f, current.id, '看看今天有什么事');
    assert.equal(count(), 3);
    while ((f as any).replies.length > 2) (f as any).replies.shift();
    const { last } = await say(f, current.id, '把聊天记录全部删掉');
    assert.equal(count(), 1, '另外两个删了，当前的保留');
    assert.equal(f.store.db.prepare('SELECT 1 FROM assistant_threads WHERE id=?').get(theirs.id) ? 1 : 0, 1, '别人的不动');
    assert.equal(f.store.db.prepare('SELECT 1 FROM assistant_threads WHERE id=?').get(b.id), undefined);
    const view = f.manager.view(current.id, actor);
    assert.equal(view.messages.length, 1, '只留最后这条回复');
    assert.equal(view.messages[0].text, last.text);
    assert.match(last.text, /都删了/);
  } finally {
    f.close();
  }
});
