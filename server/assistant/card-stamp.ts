// 方案绑定的数据版本（stamp）：出卡片时记下相关记录的编号和版本号（库存品另记库存余额，归档了的标上），
// 确认时再取一遍比（previews.ts），对不上就是出卡片以后数据变了，卡片作废，并说出是哪几条（stale-card.ts 按单号或名称说）。
// 只按版本号这几列取（采购库存、单据流转的轻量读函数），不读单据内容、不组装记录。各命令自己有绑定的（tools/ 下写入表里的 stamp）不走这里。
import type { Store } from '../core/index.js';
import { namedVersions, numberedVersions, stockVersions } from '../operations/index.js';
import { documentVersions, pendingCompletionVersions } from '../flow/index.js';
import { isAssistantModule, recordKindOf, stockKindOf, type AssistantModule } from '../../shared/assistant/index.js';
import { type ToolPlan } from './plan-rules.js';
import { field } from './chat/result-fields.js';

/**
 * 方案参数里写了助手模块的：绑定这个模块的记录（按模块对应的全站记录种类取；生产任务另带待入库的完工单）。
 * 流水不是能单独改的记录，没有自己的绑定（undefined，按通用的取）。
 */
function moduleVersions(store: Store, module: AssistantModule): unknown[] | undefined {
  const record = recordKindOf(module);
  switch (record) {
    case 'customers':
    case 'suppliers':
    case 'products':
      return namedVersions(store, record);
    case 'orders':
    case 'purchases':
      return numberedVersions(store, record);
    case 'stock_items':
      return stockVersions(store, stockKindOf(module));
    case 'task':
      return [...documentVersions(store, record), ...pendingCompletionVersions(store)];
    case 'arrival':
    case 'production':
    case 'delivery':
      return documentVersions(store, record);
    case 'movements':
      return undefined;
  }
}

/**
 * 只绑定当前方案涉及的业务域版本；审计、聊天变化不会使卡片误失效。
 * 参数里写了助手模块的绑定这个模块的记录和客户、产品；别的（按单据、库存品、订货单办事的）绑定库存品、采购单、订单和单据。
 */
export function planStamp(store: Store, plan: Pick<ToolPlan, 'args'>) {
  const module = field(plan.args, 'module');
  const rows = isAssistantModule(module) ? moduleVersions(store, module) : undefined;
  if (rows) return { rows, customers: namedVersions(store, 'customers'), products: namedVersions(store, 'products') };
  return {
    items: stockVersions(store),
    purchases: numberedVersions(store, 'purchases'),
    orders: numberedVersions(store, 'orders'),
    documents: documentVersions(store),
  };
}
