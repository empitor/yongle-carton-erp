// 单据页不渲染的纯函数（src/flow/flow-words.ts、flow-dates.ts、flow-prefill.ts、lookups.ts、src/ui/quantity-sum.ts、shared/business/task-progress.ts）：
// 日期、状态叫法和色调、办完的提示、合计、新建走哪个窗口、要读哪些档案、任务还差多少。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { flowStatusTone } from '../src/flow/FlowDetails.js';
import { activeDoc, flowStatusChoices, flowStatusText, matchesFlowSaying, matchesFlowStatus } from '../shared/business/index.js';
import { flowOverdue, shipDate } from '../src/flow/flow-dates.js';
import { businessStatusTone as warehouseTone } from '../src/recordkit/record-meta.js';
import { sumByUnit } from '../src/ui/quantity-sum.js';
import { actionNotice, previewChangedMessage, savedMessage } from '../src/flow/flow-words.js';
import { flowDocumentFor } from '../src/flow/flow-prefill.js';
import { lookupNeedKey } from '../src/flow/lookups.js';
import { completableTask, taskLeftUnits } from '../shared/business/task-progress.js';

test('送货的实际发货日就是出库那天；待送货不是灰字；业务页面不说“冲销”', () => {
  const doc = { kind: 'delivery', status: 'confirmed', date: '2026-11-01', shippedAt: '2026-11-03T02:00:00.000Z' };
  assert.equal(shipDate(doc), '2026-11-03');
  const pending = { kind: 'delivery', status: 'draft', date: '2026-11-01' };
  assert.equal(shipDate(pending), '');
  assert.notEqual(flowStatusTone({ kind: 'delivery', status: 'draft' }), 'neutral');
  assert.notEqual(warehouseTone('待送货'), 'neutral');
  assert.notEqual(warehouseTone('待入库'), 'neutral');
  assert.equal(flowStatusText({ kind: 'delivery', status: 'reversed' }), '已撤销');
  assert.equal(flowStatusText({ kind: 'arrival', status: 'confirmed' }), '已入库');
  assert.equal(flowOverdue({ kind: 'delivery', status: 'draft', date: '2000-01-01', plannedDate: '2000-01-01' }), true);
  assert.equal(flowOverdue({ kind: 'delivery', status: 'confirmed', date: '2000-01-01', plannedDate: '2000-01-01' }), false);
});

test('单据状态筛选（matchesFlowStatus）：按界面叫法比，不认存的英文状态；没选状态全都算', () => {
  const task = { status: 'confirmed', quantity: '10', completed: '4' };
  assert.equal(matchesFlowStatus(task, 'task', ''), true);
  assert.equal(matchesFlowStatus(task, 'task', '生产中'), true);
  assert.equal(matchesFlowStatus(task, 'task', '已完工'), false);
  assert.equal(matchesFlowStatus({ status: 'confirmed', quantity: '10', completed: '10' }, 'task', '已完工'), true);
  assert.equal(matchesFlowStatus({ status: 'confirmed', quantity: '10', completed: '0' }, 'task', '待生产'), true);
  // 存的英文状态、flowStatusLabel 的叫法（冲销、确认收货）都不算界面叫法
  assert.equal(matchesFlowStatus(task, 'task', 'confirmed'), false);
  assert.equal(matchesFlowStatus({ status: 'reversed' }, 'production', '已冲销'), false);
  assert.equal(matchesFlowStatus({ status: 'reversed' }, 'production', '已撤销'), true);
  assert.equal(matchesFlowStatus({ status: 'confirmed' }, 'arrival', '已确认收货'), false);
  assert.equal(matchesFlowStatus({ status: 'confirmed' }, 'arrival', '已入库'), true);
  // 到货、送货页的记录用 pending、cancelled 标记；到货被更正的叫已更正
  assert.equal(matchesFlowStatus({ pending: true }, 'delivery', '待送货'), true);
  assert.equal(matchesFlowStatus({ cancelled: true }, 'arrival', '已取消'), true);
  assert.equal(matchesFlowStatus({ status: 'confirmed', effective: false }, 'arrival', '已更正'), true);
  assert.equal(matchesFlowStatus({ status: 'confirmed', deliveredAt: '2026-11-04' }, 'delivery', '已送达'), true);
  // 每个选项都有对得上的单据叫法，不出现“草稿”“冲销”
  for (const choices of Object.values(flowStatusChoices)) assert.ok(choices.every((s) => !/草稿|冲销/.test(s)));
});

test('人说的旧叫法（助手查记录）按存的状态认：已确认收货只算确认了的到货单，不算被更正掉的原单和完工单', () => {
  assert.equal(matchesFlowSaying({ status: 'confirmed' }, 'arrival', '已确认收货'), true);
  assert.equal(matchesFlowSaying({ status: 'reversed', replacedBy: 9 }, 'arrival', '已确认收货'), false);
  assert.equal(matchesFlowSaying({ status: 'confirmed' }, 'production', '已确认收货'), false);
  assert.equal(matchesFlowSaying({ status: 'confirmed' }, 'production', '已确认完工'), true);
  assert.equal(matchesFlowSaying({ status: 'reversed', replacedBy: 9 }, 'production', '已确认完工'), false);
  // 已冲销：撤销的和被更正替代的原单都算（以前就是这样）
  assert.equal(matchesFlowSaying({ status: 'reversed', replacedBy: 9 }, 'arrival', '已冲销'), true);
  assert.equal(matchesFlowSaying({ status: 'reversed' }, 'delivery', '已冲销'), true);
  // 不是旧说法的交给界面叫法去比
  assert.equal(matchesFlowSaying({ status: 'confirmed' }, 'arrival', '已入库'), undefined);
});

test('单据有效（activeDoc）：没归档、没取消、没撤销；没写状态的算有效', () => {
  assert.equal(activeDoc({ status: 'confirmed' }), true);
  assert.equal(activeDoc({ status: 'draft' }), true);
  assert.equal(activeDoc({}), true);
  assert.equal(activeDoc({ status: 'cancelled' }), false);
  assert.equal(activeDoc({ status: 'reversed' }), false);
  assert.equal(activeDoc({ status: 'confirmed', archived: true }), false);
  assert.equal(activeDoc({ status: 'confirmed', archived: 1 }), false);
  assert.equal(activeDoc({ status: 'confirmed', archived: 0 }), true);
});

test('合计按单位分开写，不同单位不相加，千分整数相加没有浮点尾差', () => {
  assert.equal(sumByUnit([{ value: '1200', unit: '张' }, { value: '300', unit: '张' }]), '1500 张');
  assert.equal(sumByUnit([{ value: '0.1', unit: '张' }, { value: '0.2', unit: '张' }]), '0.3 张');
  assert.equal(sumByUnit([{ value: '100', unit: '张' }, { value: '5', unit: '箱' }]), '100 张、5 箱');
  assert.equal(sumByUnit([{ value: '', unit: '张' }, { value: ' 20 ', unit: '张' }]), '20 张');
  assert.equal(sumByUnit([{ value: 'abc', unit: '张' }]), '—');
  assert.equal(sumByUnit([]), '—');
});

test('撤销、取消办完的提示说清办了什么：哪几张、库存怎么变、单据还在不在', () => {
  assert.equal(
    actionNotice('reverse', [{ number: 'DJ-虚构-1', kind: 'production' }]),
    '已撤销 DJ-虚构-1：入库的成品扣回，领的纸板加回库存，单据保留为“已撤销”。',
  );
  assert.equal(actionNotice('reverse', [{ number: 'SC-虚构-1', kind: 'task' }]), '已撤销 SC-虚构-1：没有动库存，单据保留为“已撤销”。');
  assert.equal(
    actionNotice('reverse', [{ number: 'SH-虚构-1', kind: 'delivery' }]),
    '已撤销 SH-虚构-1：库存加回，订单已发数量减回，单据保留为“已撤销”。',
  );
  assert.equal(
    actionNotice('cancel', [
      { number: 'SC-虚构-1', kind: 'task' },
      { number: 'SC-虚构-2', kind: 'task' },
    ]),
    '已取消 SC-虚构-1、SC-虚构-2：没做的不再生产，已做完入库的照旧，记录保留在列表里。',
  );
  assert.equal(actionNotice('cancel', [{ number: 'DJ-虚构-2', kind: 'production' }]), '已取消 DJ-虚构-2，记录保留在列表里。');
});

test('核对入库时单据或库存被别人改了：提示说清已换成最新的核对内容，再看一遍', () => {
  assert.match(previewChangedMessage, /已经换成最新的核对内容，请再看一遍再确认/);
  assert.doesNotMatch(previewChangedMessage, /预览|草稿/);
});

test('新建任务、完工、送货不走单据编辑窗；要读哪些档案；保存后的提示；任务还差多少', () => {
  // 新建只剩没有采购单的到货；安排生产、登记完工、安排送货各有自己的窗口，单据编辑窗只装已有的单据
  for (const kind of ['delivery', 'task', 'production'] as const) assert.throws(() => flowDocumentFor(kind, undefined), /请用“/, kind);
  assert.equal(flowDocumentFor('arrival', undefined).lines.length, 1);
  // 要读哪些档案：编辑窗要最新的；生产任务列表本身就是任务清单时不读任务
  const base = { kind: 'task' as const, editorKind: null, batch: false, view: null, showBoard: false, unnamed: [], tasksFromRows: false };
  assert.equal(lookupNeedKey({ ...base, editorKind: 'delivery' }), 'customers!,items!,orders!,products!');
  assert.equal(lookupNeedKey({ ...base, unnamed: [{ productId: 1 }] }), 'products');
  assert.equal(lookupNeedKey({ ...base, batch: true, tasksFromRows: true }), 'items!,products!');
  assert.equal(lookupNeedKey(base), '');
  // 保存后的提示
  assert.equal(savedMessage({ kind: 'arrival', pageKind: 'arrival', editor: {}, result: { number: 'DH-虚构-1' } }), '已登记到货 DH-虚构-1，待核对入库。');
  assert.equal(savedMessage({ kind: 'production', pageKind: 'task', editor: {}, result: { number: 'DJ-虚构-1' } }), '已登记完工 DJ-虚构-1，待核对入库，在完工记录里核对。');
  // 任务还差多少：计划 − 已入库 − 待入库
  const t = { status: 'confirmed', progress: 40, quantity: '100', completed: '40', pendingCompleted: '10' };
  assert.equal(taskLeftUnits(t), 50_000);
  assert.equal(completableTask(t), true);
  assert.equal(completableTask({ ...t, pendingCompleted: '60' }), false);
});
