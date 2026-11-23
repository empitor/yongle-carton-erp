// 批量登记完工的方案直接调用：助手登记的完工日期、选任务、按产量比例分整张领料（纯计算，不写库）
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { flowFixture } from '../support/flow-fixture.js';
import { allocate, checkFacts, pickTasks, type CompletionInput } from '../../server/flow/production/completion-plan.js';

/** 按录入规则整理过的登记完工输入（领 10 张纸板、按产量比例分），各条只换要试的几项 */
const input = (over: Partial<CompletionInput> = {}): CompletionInput => ({
  requestId: randomUUID(),
  materials: [{ unit: '张', issued: '10', returned: '0' }],
  allocation: 'shared-proportional',
  notes: '',
  ...over,
});
/** 分领料的行：挂的任务、产品、合格和废品（千分整数）、分到的领料（先空着） */
type Rows = (Parameters<typeof allocate>[1][number] & { productId: number })[];

test('助手登记完工日期要用用户说的：没给就拦，人工登记不拦', () => {
  const v = input({ date: '2026-10-27' });
  assert.throws(() => checkFacts({ requireFacts: true }, { ...v, date: undefined }), /实际完工日期/);
  checkFacts({ requireFacts: true }, v);
  checkFacts({}, { ...v, date: undefined });
});

test('按产量比例分整张领料：最大余数法，合计不变；逐任务给定的照用', () => {
  const rows = (): Rows => [
    { task: { id: 1 }, productId: 1, good: 6000, scrap: 0, materials: [] },
    { task: { id: 2 }, productId: 1, good: 3000, scrap: 1000, materials: [] },
  ];
  const shared = rows();
  allocate(input({ allocation: 'shared-proportional' }), shared, [{ stockId: 7, issued: 10000, returned: 0 }]);
  assert.deepEqual(shared.map((r) => r.materials), [[{ stockId: 7, issued: '6', returned: '0' }], [{ stockId: 7, issued: '4', returned: '0' }]]);
  const explicit = rows();
  allocate(
    input({ allocation: 'explicit', distribution: [{ taskId: 1, materials: [{ stockId: 7, issued: '7', returned: '0' }] }, { taskId: 2, materials: [{ stockId: 7, issued: '3', returned: '0' }] }] }),
    explicit,
    [{ stockId: 7, issued: 10000, returned: 0 }],
  );
  assert.deepEqual(explicit.map((r) => r.materials[0].issued), ['7', '3']);
  assert.throws(() => allocate(input({ allocation: 'explicit', distribution: [] }), rows(), []), /逐任务分配必须完整/);
});

test('选任务：不存在的生产任务拦下', () => {
  const f = flowFixture();
  try {
    assert.throws(() => pickTasks(f.flow, input({ taskIds: [999999] })), /所选生产任务不存在/);
  } finally {
    f.store.close();
  }
});
