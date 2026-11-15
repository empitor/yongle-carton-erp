// 登记完工的测试共用（batch-completion、production-completion-single）：内存库、虚构数据。
import { randomUUID } from 'node:crypto';
import { Store } from '../server/core/db.js';
import { OperationsService } from '../server/operations/service.js';
import { FlowService } from '../server/flow/service.js';
import { ManualProductionCompletion } from '../server/flow/production-completion.js';
import { productSchema, today } from '../shared/core/domain.js';
import { actor } from './assistant-fixture.js';

/**
 * 纸板期初 100 张；两种有尺寸材质的纸箱（甲、乙），各一张没挂订单、已下达的任务（3 只、2 只）。
 * input() 是整批登记两张任务全部做完、共用 5 张纸板按产量比例分的输入。
 */
export function completionFixture(store = new Store(':memory:')) {
  const ops = new OperationsService(store),
    flow = new FlowService(store),
    completion = new ManualProductionCompletion(store);
  const raw = ops.saveItem({ name: '虚构共享纸板', kind: 'raw', unit: '张' }, actor);
  ops.move(
    raw.id,
    { expectedVersion: raw.version, requestId: randomUUID(), action: 'in', quantity: '100', date: today(), notes: '虚构期初', acknowledged: true },
    actor,
  );
  const products = ['虚构纸箱甲', '虚构纸箱乙'].map((name) =>
    store.saveProduct(productSchema.parse({ name, length: 300, width: 200, height: 150, dimensionUnit: 'mm', material: 'K=A', flute: 'B' })),
  );
  const tasks = products.map((p, i) =>
    flow.save('task', { productId: p.id, quantity: String(i ? 2 : 3), unit: '只', date: today(), plannedDate: today(), orderIds: [] }, actor),
  );
  const input = () => ({
    requestId: randomUUID(),
    taskIds: tasks.map((t) => t.id),
    date: today(),
    operator: '虚构生产人员',
    allocation: 'shared-proportional',
    materials: [{ stockId: raw.id, unit: '张', issued: '5', returned: '0' }],
    quantities: tasks.map((t) => ({ taskId: t.id, goodQuantity: t.quantity, scrapQuantity: '0' })),
  });
  return { store, ops, flow, completion, raw, tasks, input };
}
