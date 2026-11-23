import type { z } from 'zod';
import { type Store } from '../core/index.js';
import { customerSchema, productSchema, orderSchema, storedOrderInput, flowKinds, type FlowKind } from '../../shared/core/index.js';
import { supplierSchema, purchaseSchema, stockItemSchema } from '../../shared/business/index.js';
import { flowInput, type FlowDocView } from '../../shared/business/index.js';
import { arrivalSchema, deliverySchema, productionSchema, taskSchema } from '../../shared/business/index.js';
import type { RecordEntity, dataManagementModules } from '../../shared/business/index.js';
import { entityRecords, namedDocuments, type EntityRecordOf } from '../business/index.js';
import type { FlowService } from '../flow/index.js';
// 数据管理读记录：一个模块的全部记录或选中的几条，每条给列表显示用的 record 和编辑窗用的 input（补上名字、单号、用没用过）。

/** 数据管理的模块：档案、订单、采购单、库存品和四种单据 */
export type ManagedModule = (typeof dataManagementModules)[number];
/** 档案、订单、采购单、库存品的一行 */
type BusinessRecord<E extends RecordEntity> = EntityRecordOf[E];
/** 档案、订单、采购单、库存品按各自的保存校验整理成编辑窗的内容；单据用 flowInput */
export const recordSchemas = {
  customers: customerSchema,
  products: productSchema,
  orders: orderSchema,
  suppliers: supplierSchema,
  purchases: purchaseSchema,
  stock_items: stockItemSchema,
};
/**
 * 每个模块的录入结构（哪些栏目收）：档案、订单、采购单、库存品同上；单据用各自的录入规则
 * （flowInput 整理到货单用的那一份只是明细数量可以是 0，栏目和 arrivalSchema 一样）
 */
export const inputSchemas: Record<ManagedModule, z.core.$ZodType> = {
  ...recordSchemas,
  arrival: arrivalSchema,
  task: taskSchema,
  production: productionSchema,
  delivery: deliverySchema,
};
type RecordInput<E extends RecordEntity> = z.output<(typeof recordSchemas)[E]>;
/** 每类记录整理成编辑窗的内容；采购单的状态取它自己定的那个（baseStatus），不是按到货派生的 */
const businessInputs: { [E in RecordEntity]: (record: BusinessRecord<E>) => RecordInput<E> } = {
  customers: (r) => customerSchema.parse(r),
  products: (r) => productSchema.parse(r),
  // 库里的旧含税口径照原样带进编辑窗（下拉里列成“原来写的……（请改选）”），不在这里拦
  orders: (r) => storedOrderInput(r),
  suppliers: (r) => supplierSchema.parse(r),
  purchases: (r) => purchaseSchema.parse({ ...r, status: r.baseStatus }),
  stock_items: (r) => stockItemSchema.parse(r),
};
type InputOf<M extends ManagedModule> = M extends RecordEntity
  ? RecordInput<M>
  : M extends FlowKind
    ? ReturnType<typeof flowInput<M>>
    : never;
type RecordOf<M extends ManagedModule> = M extends RecordEntity
  ? BusinessRecord<M>
  : M extends FlowKind
    ? FlowDocView<M>
    : never;
/** 选中的一条：按编号读的 record，和编辑窗用的 input */
export type Selected<M extends ManagedModule = ManagedModule> = { record: RecordOf<M>; input: InputOf<M> };
type Usage = NonNullable<ReturnType<FlowService['views']['usage']>>;
/** 列表显示另补在 record 上的：库存品用没用过；到货单的订货单号和原件文件名（供应商名、客户名补在单据自己的字段上） */
type Shown = { stock_items: { usage: Usage | null }; arrival: { orderBatchNumber?: string; sourceFileName?: string } };
/** 列表的一条：显示用的 record（补了 Shown 里的几项），和编辑窗用的 input */
export type Listed<M extends ManagedModule = ManagedModule> = {
  record: RecordOf<M> & (M extends keyof Shown ? Shown[M] : unknown);
  input: InputOf<M>;
};
export const isFlowModule = (module: string): module is FlowKind => flowKinds.some((k) => k === module);

export class ManagedRecords {
  constructor(
    readonly store: Store,
    readonly flow: FlowService,
  ) {}
  /** 一个模块的全部记录（含归档的） */
  list<M extends ManagedModule>(module: M): Listed<M>[];
  list(module: ManagedModule): Listed[] {
    if (isFlowModule(module))
      return this.flowDisplayed(module).map((record) => ({ record, input: flowInput(module, record) }));
    return this.businessListed(module);
  }
  /**
   * 选中的那几条：按编号读、各自组装（含归档的），和 list 给的同一份 input。
   * 改一条记录不再把这个模块的全部记录组装一遍。
   */
  selected<M extends ManagedModule>(module: M, ids: readonly number[]): Map<number, Selected<M>>;
  selected(module: ManagedModule, ids: readonly number[]): Map<number, Selected> {
    const found: Selected[] = isFlowModule(module)
      ? this.flow.list(module, true, undefined, ids).map((record) => ({ record, input: flowInput(module, record) }))
      : this.businessSelected(module, ids);
    return new Map(found.map((s) => [s.record.id, s]));
  }
  private businessSelected<E extends RecordEntity>(entity: E, ids: readonly number[]) {
    return entityRecords(this.store, entity, true, ids).map((record) => ({
      record,
      input: businessInputs[entity](record),
    }));
  }
  /**
   * 库存品补 usage：有出入库流水是 moved，被采购明细或单据引用是 referenced，没用过是 null。
   * 直接用单据流转的 views.usages（保存库存品时拦截用的同一个判断）；用过的库存品服务端不让改种类、不让改成品关联的产品，
   * 编辑窗据此做成只读并写明原因。只补在显示用的 record 上，input 和库里都不改。
   */
  private businessListed<E extends RecordEntity>(entity: E) {
    const records = entityRecords(this.store, entity, true);
    const usage = entity === 'stock_items' && records.length ? this.flow.views.usages(records.map((r) => r.id)) : undefined;
    return records.map((record) => ({
      record: usage ? { ...record, usage: usage.get(record.id) ?? null } : record,
      input: businessInputs[entity](record),
    }));
  }
  /**
   * 单据列表：业务汇总按模块读记录的那一份（namedDocuments），补上关联的名称——待入库、已取消的到货单和待送货的送货单
   * document 里还没记名字（确认时才写），按档案补；到货单另补订货单号和原件文件名。只补显示用的 record，单据内容（input）和库里都不改。
   */
  private flowDisplayed(kind: FlowKind): FlowDocView[] {
    return namedDocuments(this.flow, kind, true);
  }
}
