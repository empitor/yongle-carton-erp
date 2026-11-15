// AI 导入页的前端规则（不依赖 React、不发请求）：本地修改比对、页头状态、到货核对、批量归档和删除（读流见 stream-reply.test.ts）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { blankField, headerFields, lineFields, orderDraftSchema, type OrderDraft } from '../shared/import/order-draft.js';
import { workspaceRecord } from './import-fixtures.js';
import { draftOperations, withFieldValue } from '../src/import/draft-edits.js';
import { arrivalFlags, canReanalyze, fileCounts, headAction, recognizableOrders } from '../src/import/page-state.js';
import { taskPhase, type FileItem } from '../src/import/fileStatus.js';
import { arrivalEditable, arrivalValue, batchReceiveRows } from '../src/import/arrival-review.js';
import { removalNotice, removalPlan } from '../src/import/workspace-removal.js';
import { linePrice } from '../shared/core/index.js';

const LINE = '00000000-0000-4000-8000-000000000001';
function draft(): OrderDraft {
  return orderDraftSchema.parse({
    header: Object.fromEntries(headerFields.map((k) => [k, blankField()])),
    lines: [{ id: LINE, fields: Object.fromEntries(lineFields.map((k) => [k, blankField()])) }],
    warnings: [],
  });
}
const file = (patch: Partial<FileItem>): FileItem => ({ id: 'f1', fileName: '虚构.xlsx', createdAt: '', ...patch });

test('订单识别结果的本地修改：改了哪些格子就发哪些操作，空字符串存成没有值', () => {
  const before = draft();
  let after = withFieldValue(before, 'buyerName', '虚构客户甲');
  after = withFieldValue(after, 'quantity', '500', LINE);
  after = withFieldValue(after, 'notes', '', LINE);
  assert.equal(before.header.buyerName.value, null, '原来的不动');
  assert.equal(after.header.buyerName.certainty, 'user-modified');
  assert.deepEqual(draftOperations(before, after), [
    { op: 'set-header', field: 'buyerName', value: '虚构客户甲', reason: '人工编辑' },
    { op: 'set-line', lineId: LINE, field: 'quantity', value: '500', reason: '人工编辑' },
  ]);
  assert.deepEqual(draftOperations(before, undefined), []);
  assert.equal(withFieldValue(before, 'quantity', '1', 'missing-line'), before, '找不到明细时原样返回');
});

test('AI 导入页头：计数、开始识别按钮、重新识别和到货锁定', () => {
  const files = [
    file({ id: 'a', hasDraft: true }),
    file({ id: 'b' }),
    file({ id: 'c', task: { state: 'failed' } }),
    file({ id: 'e', mode: 'arrival', arrivalStatus: 'failed' }),
    file({ id: 'f', mode: 'arrival', arrivalDocId: 3, arrivalStatus: 'confirmed' }),
  ];
  assert.deepEqual(recognizableOrders(files).map((f) => f.id), ['b', 'c']);
  assert.deepEqual(fileCounts(files, 1), { done: 2, reviewing: 1, waiting: 2, failed: 3 });
  assert.deepEqual(arrivalFlags(files[4]), { locked: true, recognized: true });
  assert.deepEqual(arrivalFlags(files[3]), { locked: false, recognized: false });
  const w = workspaceRecord({ id: 'b', fileHash: '虚构', revision: 1, draft: null, task: { state: 'failed' } });
  assert.deepEqual(headAction('order', w, files[1], false), { mode: 'order', label: '重试识别', disabled: false });
  assert.equal(headAction('order', { ...w, draft: draft() }, files[0], false), undefined);
  assert.deepEqual(headAction('arrival', w, files[3], true), { mode: 'arrival', label: '正在识别…', disabled: true });
  assert.equal(headAction('arrival', w, files[4], false), undefined, '入库后不能再识别');
  assert.equal(canReanalyze('arrival', w, files[4], false), false);
  assert.equal(canReanalyze('order', { ...w, draft: draft() }, files[0], true), false, '正在处理时不给');
});

test('刷新列表时任务的状态：排队、识别中、结束、没开始', () => {
  assert.deepEqual(taskPhase(file({ task: { state: 'backoff' } })), { kind: 'running', label: '排队等待' });
  assert.deepEqual(taskPhase(file({ task: { state: 'ready' } })), { kind: 'finished' });
  assert.deepEqual(taskPhase(file({ task: { state: 'uploaded' } })), { kind: 'idle' });
  assert.deepEqual(taskPhase(file({ mode: 'arrival', arrivalStatus: 'running' })), { kind: 'running', label: 'AI 识别中' });
});

test('到货识别核对：能不能改、改没改过', () => {
  assert.equal(arrivalEditable(null), true);
  assert.equal(arrivalEditable({ status: 'draft' }), true);
  assert.equal(arrivalEditable({ status: 'confirmed' }), false, '已入库的用“更正到货单”，本机管理员也一样');
  assert.equal(arrivalEditable({ status: 'draft', archived: true }), false);
  assert.equal(arrivalValue({ 不是到货单: true }), JSON.stringify({ 不是到货单: true }), '资料不全整理不了就原样比');
});

test('到货识别挂订货单：每行对上订货单的行，同一行的数量相加；填了实际入库的才带入库数；对不上的不存', () => {
  const board = (name: string, length: number) => ({ name, specification: '', length, width: 600, height: null, dimensionUnit: 'mm', material: 'W=A', flute: 'E' });
  const batch = { rows: [{ key: 'k1', board: board('虚构甲纸板', 800) }, { key: 'k2', board: board('虚构乙纸板', 900) }] };
  const line = (length: number, extra: Pick<Parameters<typeof batchReceiveRows>[0][number], 'acceptedQuantity' | 'rejectedQuantity' | 'stockedQuantity'> = {}) =>
    ({ item: { ...board('虚构纸板', length), unit: '张' }, quantity: '100', ...extra });
  assert.deepEqual(batchReceiveRows([line(800), line(800, { rejectedQuantity: '5' }), line(900, { acceptedQuantity: '90', stockedQuantity: '80' })], batch), [
    { key: 'k1', quantity: '200', rejectedQuantity: '5' },
    { key: 'k2', quantity: '100', rejectedQuantity: '10', stockedQuantity: '80' },
  ]);
  assert.equal(batchReceiveRows([line(1000)], batch), null, '订货单里没有这种纸板');
});

test('批量归档或永久删除：读不到版本的算没办成，结果说成一句话', () => {
  const plan = removalPlan([
    { id: 'a', revision: 3, error: '' },
    { id: 'c', revision: null, error: '读不到' },
  ]);
  assert.deepEqual(plan.ready, [{ id: 'a', version: 3 }]);
  assert.deepEqual(plan.unreadable, [{ id: 'c', success: false, message: '读不到' }]);
  const done = { id: 'a', success: true, message: '' };
  assert.equal(removalNotice([done], (id) => '文件' + id, false), '已归档1份文件，在“更多 → 历史与归档”里能恢复。');
  assert.equal(removalNotice([done, ...plan.unreadable], (id) => '文件' + id, true), '已永久删除1份文件；没办成1份：文件c：读不到');
});

test('导入预览的单价写法：精确单价优先，只有分的按分换成元', () => {
  assert.equal(linePrice({ unitPriceExact: '1.2000' }), '1.20');
  assert.equal(linePrice({ unitPriceCents: 123 }), '1.23');
  assert.equal(linePrice({}), '待定');
});
