import type { Actor, Store } from '../../core/index.js';
import { AppError } from '../../core/index.js';
import type { OperationsService } from '../../operations/index.js';
import type { FlowDocument, FlowDocuments, FlowDocView, FlowKind, FlowPreview, StockItemBaseView } from '../../../shared/business/index.js';

/*
 * 单据流转最底下的一层：各文件共用的 fail、FlowCommands 和核对用的类型。这个文件不引用单据流转的任何别的文件。
 * 拆出去的核对、确认、撤销、更正等文件只认 FlowCommands（由 service.ts 的 FlowService 实现），不引用 service.ts。
 */

/** 单据流转的业务校验不通过：默认 422（内容不对），版本冲突、重复提交这类传 409 */
export function fail(message: string, status = 422): never {
  throw new AppError(message, status);
}

/** 到货、送货的一行明细（库里存的样子：核对时补全的字段都在） */
export type ArrivalLine = FlowDocuments['arrival']['lines'][number];
export type DeliveryLine = FlowDocuments['delivery']['lines'][number];
/** 库存品（采购库存读出来的基本视图：结余、在途） */
export type StockItemRow = StockItemBaseView;

/**
 * 一笔库存变化（单据核对 validateFlow 算出来的 changes）：到货新加的行还没有库存品时 stockId 是 null、带 newItem；
 * 核对窗口（preview.ts 的 describeChanges）再补入到哪个、现在和核对后。结构跟核对窗口的回答走（shared/business/flow-views.ts）
 */
export type StockChange = FlowPreview['changes'][number];
/** 到货行没选库存品时要入的原材料：按这份内容对上已有的，没有就新建（OperationsService.rawStockFor） */
export type NewRawItem = NonNullable<StockChange['newItem']>;

type LinesOf<D> = D extends { lines: (infer L)[] } ? L[] : never[];
/** 核对结果：库存会怎么变、提示、补全后的明细（到货、送货才有），补全明细以后的单据（和核对的那份同样：内容或视图） */
export type FlowCheck<D extends FlowDocument = FlowDocument> = Pick<FlowPreview, 'changes' | 'warnings'> & {
  lines: LinesOf<D>;
  document: D;
};

/** 完工入哪个成品库存要看的（完工单内容里的这几项） */
export type FinishedStockInput = { productId: number; taskId?: number | null; finishedStockId: number | null };

/** 拆出去的文件要用的单据能力：读单据、保存、核对、确认、事务、成品和原材料库存品的对应 */
export type FlowCommands = {
  readonly store: Store;
  readonly ops: OperationsService;
  /** 给了 kind 就只认这一种（视图按种类收窄，种类不对按不存在报） */
  get<K extends FlowKind = FlowKind>(id: number, kind?: K): FlowDocView<K>;
  /** 给了 kind 只读这一种（视图按种类收窄） */
  list<K extends FlowKind = FlowKind>(kind?: K, includeArchived?: boolean, workbenchDate?: string, ids?: readonly number[]): FlowDocView<K>[];
  waitingGood(taskIds?: readonly number[], excludeId?: number): Map<number, number>;
  save<K extends FlowKind>(kind: K, raw: unknown, who: Actor | null | undefined, id?: number, options?: { moved?: boolean; registered?: boolean }): FlowDocView<K>;
  preview(id: number, who: Actor | null | undefined): FlowPreview;
  confirm(id: number, raw: unknown, who: Actor | null | undefined): FlowDocView;
  /** 完工入哪个成品库存（按产品对应，没有就建、归档了就恢复） */
  finishedStockOf(v: FinishedStockInput, actor: Actor, document?: string): number | null;
  /** 到货行没选库存品时入哪个原材料库存品（同一张单里一样的几行共用一个） */
  createdItem(created: Map<string, number>, item: NewRawItem, actor: Actor, document: string): number;
  /** 按单据现在的内容重写关联表 */
  maintenanceReferences(id: number): void;
};

/** 按编号取生产任务（完工单挂的、更正要看的）；不是生产任务按 message 报 */
export function taskOf(flow: FlowCommands, id: number, message = '单据不是生产任务，请刷新后重新选择生产任务。'): FlowDocView<'task'> {
  const doc = flow.get(id);
  if (doc.kind !== 'task') return fail(message);
  return doc;
}

/** 到货新加的行（还没有库存品）要入的原材料：核对时一定带着（validate-arrival.ts），没有是数据不对 */
export function newItemOf(c: StockChange): NewRawItem {
  if (!c.newItem) return fail('到货明细“' + c.name + '”没有库存品，也没有要新建的原材料内容，请刷新后重新核对。', 409);
  return c.newItem;
}

/** 各种单据的校验共用的上下文：校验结果（changes、warnings）往里加；到货、送货另带补全明细的 lines（LineCheck） */
export type Check = {
  flow: FlowCommands;
  actor: Actor;
  /** 本机管理员：已归档的档案也能用，单据状态不卡 */
  maintenance: boolean;
  confirm: boolean;
  excludingId?: number;
  skipRemaining: boolean;
  /** 登记到货（register-arrival.ts）按订货单分配后存的：只有它能新建挂采购明细的到货单 */
  registered: boolean;
  /** 取库存品并核对种类、归档（没选的是 null，按没有这个库存品报） */
  item(id: number | null, kind: string): StockItemRow;
  /** 记一条库存变化 */
  change(it: StockItemRow, delta: number, reason: string, lineId?: number, orderId?: number): void;
  changes: StockChange[];
  warnings: string[];
};
/** 到货、送货的校验：补全后的明细往 lines 里加 */
export type LineCheck<L> = Check & { lines: L[] };
