import { flowKinds, pageHref, type FlowKind, type stockKinds } from '../core/index.js';
import type { dataManagementModules } from '../business/index.js';

/*
 * 助手的模块名（records.* 的 module，raw_inventory 这一套）和全站记录种类的对照：只在这里写一次。
 * 全站记录种类是修改历史、删除、数据管理、页面“正在看哪条记录”用的那一套（档案表名、stock_items、单据种类），
 * 页面只报全站记录种类，助手模块名由服务器按这张表翻译（库存品按它是原材料还是成品分两个模块）。
 */

/** 助手查记录、改记录用的模块；顺序就是给模型看的顺序 */
export const assistantModules = [
  'customers',
  'products',
  'orders',
  'suppliers',
  'purchases',
  'raw_inventory',
  'finished_inventory',
  'arrivals',
  'production_tasks',
  'production_records',
  'deliveries',
  'movements',
] as const;
export type AssistantModule = (typeof assistantModules)[number];
/** 全站记录种类（流水不是能单独管的记录，助手单列一个 movements） */
export type RecordKind = (typeof dataManagementModules)[number] | 'movements';
type StockKind = (typeof stockKinds)[number];

/** 每个助手模块：中文名、全站记录种类、库存品是哪一种、有专门页面的打开哪一页（ui.open 的别名） */
type ModuleEntry = { name: string; record: RecordKind; stockKind?: StockKind; page?: string };
const moduleTable: Record<AssistantModule, ModuleEntry> = {
  customers: { name: '客户', record: 'customers' },
  products: { name: '产品', record: 'products' },
  orders: { name: '订单', record: 'orders' },
  suppliers: { name: '供应商', record: 'suppliers' },
  purchases: { name: '采购单', record: 'purchases' },
  raw_inventory: { name: '原材料库存', record: 'stock_items', stockKind: 'raw', page: pageHref('warehouse', { kind: 'raw' }) },
  finished_inventory: { name: '成品库存', record: 'stock_items', stockKind: 'finished', page: pageHref('warehouse', { kind: 'finished' }) },
  arrivals: { name: '到货', record: 'arrival', page: pageHref('warehouse', { arrivals: true }) },
  production_tasks: { name: '生产任务', record: 'task', page: pageHref('production') },
  production_records: { name: '完工记录', record: 'production', page: pageHref('production', { view: 'production' }) },
  deliveries: { name: '送货', record: 'delivery', page: pageHref('warehouse', { kind: 'finished', deliveries: true }) },
  movements: { name: '流水', record: 'movements', page: pageHref('warehouse', { flow: true }) },
};

export const isAssistantModule = (v: unknown): v is AssistantModule => assistantModules.some((m) => m === v);
/** 模块的中文名 */
export const moduleName = (module: AssistantModule) => moduleTable[module].name;
/** 模块对应的全站记录种类 */
export const recordKindOf = (module: AssistantModule) => moduleTable[module].record;
/** 库存品模块是原材料还是成品；别的模块没有 */
export const stockKindOf = (module: AssistantModule) => moduleTable[module].stockKind;
/** 单据模块的单据种类；别的模块没有 */
export const flowKindOfModule = (module: AssistantModule): FlowKind | undefined => flowKinds.find((k) => k === recordKindOf(module));
/** 全站记录种类（库存品再加种类）对应的助手模块；对不上是 undefined */
export const moduleOfRecord = (record: RecordKind, stockKind?: StockKind) =>
  assistantModules.find((m) => moduleTable[m].record === record && moduleTable[m].stockKind === stockKind);
/** 有专门页面的模块：模块名 → 页面地址（ui.open 按模块名打开） */
export const modulePages: Record<string, string> = Object.fromEntries(
  assistantModules.flatMap((m) => {
    const page = moduleTable[m].page;
    return page ? [[m, page]] : [];
  }),
);
