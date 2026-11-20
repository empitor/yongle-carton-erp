import type { z } from 'zod';
import { many, rows, type Store } from '../core/index.js';
import { customerSchema, productSchema, orderSchema } from '../../shared/core/index.js';
import { supplierSchema, purchaseSchema, stockItemSchema } from '../../shared/business/index.js';
import { flowKinds, flowInput, type FlowDocView, type FlowKind } from '../../shared/business/index.js';
import { arrivalSchema, deliverySchema, productionSchema, taskSchema } from '../../shared/business/index.js';
import type { RecordEntity, dataManagementModules } from '../../shared/business/index.js';
import { businessList, businessRecords } from '../business/index.js';
import type { OperationsService } from '../operations/index.js';
import type { FlowService } from '../flow/index.js';
// 数据管理读记录：一个模块的全部记录或选中的几条，每条给列表显示用的 record 和编辑窗用的 input（补上名字、单号、用没用过）。

/** 数据管理的模块：档案、订单、采购单、库存品和四种单据 */
export type ManagedModule = (typeof dataManagementModules)[number];
/** 档案、订单、采购单、库存品的一行（业务汇总的 businessRecords 按类型给的） */
type BusinessRecord<E extends RecordEntity> = ReturnType<typeof businessRecords<E>>[number];
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
  orders: (r) => orderSchema.parse(r),
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
type Usage = NonNullable<ReturnType<ReturnType<OperationsService['usages']>['get']>>;
/** 列表显示另补在 record 上的：库存品用没用过；到货单的订货单号和原件文件名（供应商名、客户名补在单据自己的字段上） */
type Shown = { stock_items: { usage: Usage | null }; arrival: { orderBatchNumber?: string; sourceFileName?: string } };
/** 列表的一条：显示用的 record（补了 Shown 里的几项），和编辑窗用的 input */
export type Listed<M extends ManagedModule = ManagedModule> = {
  record: RecordOf<M> & (M extends keyof Shown ? Shown[M] : unknown);
  input: InputOf<M>;
};
export const isFlowModule = (module: string): module is FlowKind => flowKinds.some((k) => k === module);

/** 待入库的到货单、待送货的送货单还没记名字（确认时才写）：缺名字的编号（去重） */
const unnamedIds = (docs: readonly { name: string | undefined; id: number }[]) => [
  ...new Set(docs.filter((d) => !d.name).map((d) => d.id)),
];

export class ManagedRecords {
  constructor(
    readonly store: Store,
    readonly ops: OperationsService,
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
    return businessRecords(this.store, entity, ids, true).map((record) => ({
      record,
      input: businessInputs[entity](record),
    }));
  }
  /**
   * 库存品补 usage：有出入库流水是 moved，被采购明细或单据引用是 referenced，没用过是 null。
   * 直接用 OperationsService.usages（saveItem 拦截用的同一个判断）；用过的库存品服务端不让改种类、不让改成品关联的产品，
   * 编辑窗据此做成只读并写明原因。只补在显示用的 record 上，input 和库里都不改。
   */
  private businessListed<E extends RecordEntity>(entity: E) {
    const records = businessList(this.store, entity, true);
    const usage = entity === 'stock_items' && records.length ? this.ops.usages(records.map((r) => r.id)) : undefined;
    return records.map((record) => ({
      record: usage ? { ...record, usage: usage.get(record.id) ?? null } : record,
      input: businessInputs[entity](record),
    }));
  }
  /** 单据列表上要另补的（到货单的供应商名、订货单号、原件文件名，送货单的客户名），一个模块一次批量查 */
  private flowDisplayed(kind: FlowKind): FlowDocView[] {
    if (kind === 'arrival') return this.arrivalDisplay(this.supplierNames(this.flow.list('arrival', true)));
    if (kind === 'delivery') return this.customerNames(this.flow.list('delivery', true));
    return this.flow.list(kind, true);
  }
  /**
   * 列表上显示的供应商、客户名：待入库、已取消的到货单和待送货的送货单，document 里还没记名字（确认时才写），
   * 和到货页面一样读的时候补上。缺名字的一次按编号批量查，只补显示用的 record，单据内容（input）和库里都不改。
   */
  private supplierNames(docs: FlowDocView<'arrival'>[]) {
    const ids = unnamedIds(docs.map((d) => ({ name: d.supplierName, id: d.supplierId })));
    if (!ids.length) return docs;
    const names = new Map(this.ops.repo.suppliers(true, ids).map((p) => [p.id, p.name] as const));
    return docs.map((d) => {
      const name = names.get(d.supplierId);
      return !d.supplierName && name !== undefined ? { ...d, supplierName: name } : d;
    });
  }
  private customerNames(docs: FlowDocView<'delivery'>[]) {
    const ids = unnamedIds(docs.map((d) => ({ name: d.customerName, id: d.customerId })));
    if (!ids.length) return docs;
    const names = new Map(this.store.customers(true, ids).map((p) => [p.id, p.name] as const));
    return docs.map((d) => {
      const name = names.get(d.customerId);
      return !d.customerName && name !== undefined ? { ...d, customerName: name } : d;
    });
  }
  /** 到货单的订货单号和原件文件名：编辑窗显示单号和文件名，不露内部编号 */
  private arrivalDisplay(docs: FlowDocView<'arrival'>[]) {
    const batchIds = [...new Set(docs.flatMap((d) => (d.orderBatchId != null ? [d.orderBatchId] : [])))],
      sourceIds = [...new Set(docs.flatMap((d) => (d.sourceId ? [d.sourceId] : [])))];
    const batches = new Map(
      batchIds.length
        ? many(
            this.store.db,
            rows.order_batches.pick({ id: true, number: true }),
            'SELECT id,number FROM order_batches WHERE id IN (SELECT value FROM json_each(?))',
            JSON.stringify(batchIds),
          ).map((b) => [b.id, b.number] as const)
        : [],
    );
    const sources = new Map(
      sourceIds.length
        ? many(
            this.store.db,
            rows.flow_sources.pick({ id: true, file_name: true }),
            'SELECT id,file_name FROM flow_sources WHERE id IN (SELECT value FROM json_each(?))',
            JSON.stringify(sourceIds),
          ).map((s) => [s.id, s.file_name] as const)
        : [],
    );
    return docs.map((d) => {
      const orderBatchNumber = d.orderBatchId != null ? batches.get(d.orderBatchId) : undefined,
        sourceFileName = d.sourceId ? sources.get(d.sourceId) : undefined;
      return {
        ...d,
        ...(orderBatchNumber !== undefined ? { orderBatchNumber } : {}),
        ...(sourceFileName !== undefined ? { sourceFileName } : {}),
      };
    });
  }
}
