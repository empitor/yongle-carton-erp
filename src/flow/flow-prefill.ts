import { blankArrivalLine, type FlowDocView, type FlowKind } from '../../shared/business/index';
import { today, type DimensionUnit } from '../../shared/core/index';
import type { DeliveryEditing } from './delivery-stock';
import type { ProductionEditing } from './ProductionForm';
import type { TaskEditing } from './TaskForm';

/** 新建这几种单据各有自己的窗口，单据编辑窗只装已有的单据 */
const ownWindow: Partial<Record<FlowKind, string>> = {
  task: '新建生产任务请用“安排生产”。',
  production: '登记完工请用“登记完工”，挂不挂生产任务都在那里登记。',
  delivery: '新建送货请用“安排送货”。',
};

/** 编辑窗里到货单一行的纸板：名称、单位、规格、尺寸和尺寸单位、材质、楞型、纸板备注 */
type ArrivalEditItem = {
  name: string;
  unit: string;
  specification: string;
  material: string;
  flute: string;
  length: number | null;
  width: number | null;
  height: number | null;
  dimensionUnit: DimensionUnit | null;
  notes: string;
};
/** 编辑窗里到货单的一行：库存品、采购明细可能还没选；数量、单价是正在填的文字；合格、不合格、入库空着按默认算 */
export type ArrivalEditLine = {
  stockId: number | null;
  purchaseLineId: number | null;
  item: ArrivalEditItem;
  quantity: string;
  acceptedQuantity?: string | null;
  rejectedQuantity?: string | null;
  stockedQuantity?: string | null;
  statedQuantity?: string | null;
  statedArea: string | null;
  unitPrice: string | null;
  priceBasis: string | null;
  differenceReason: string;
};
/**
 * 编辑窗里的到货单（ArrivalForm 改它）：已有到货单的副本，或新登记的空白单（没有编号、版本，供应商还没选）。
 * AI 识别的送货单带着原件（sourceId），挂哪份订货单（orderBatchId）或“不挂采购单”（withoutPurchase，只在核对窗里用、不存进单据）。
 */
export type ArrivalEditing = {
  kind: 'arrival';
  id?: number;
  version?: number;
  sourceId: string | null;
  supplierId: number | null;
  orderBatchId?: number;
  withoutPurchase?: boolean;
  reference: string;
  date: string;
  actualTime?: string | null;
  notes: string;
  lines: ArrivalEditLine[];
};
/**
 * 单据编辑窗里正在改的单据（已有单据的副本，或新登记的空白到货单），按种类分，各是那种表单的编辑内容
 * （生产任务 TaskForm、完工 ProductionForm、送货 delivery-stock.ts）。保存时按这种单据的录入规则整理（flowInput）。
 */
export type FlowEditing = ArrivalEditing | TaskEditing | ProductionEditing | DeliveryEditing;

/** 新登记的空白到货单：还没有编号和版本，不预填采购明细 */
const blankArrival = (): ArrivalEditing => ({
  kind: 'arrival' as const,
  date: today(),
  notes: '',
  actualTime: null,
  supplierId: null,
  reference: '',
  sourceId: null,
  lines: [blankArrivalLine()],
});

/**
 * 打开单据编辑窗时装进去的内容：编辑已有的单据就是它的副本。新建只剩没有采购单的到货（空白单，不预填采购明细）；
 * 安排生产、登记完工、安排送货各有自己的窗口（TaskPlanDialog、ProductionBatchDialog、DeliveryPlanDialog）。
 * 只算数据，不发请求。
 */
export function flowDocumentFor<K extends FlowKind>(k: K, value?: FlowDocView<K>) {
  if (value) return structuredClone(value);
  if (k !== 'arrival') throw new Error(ownWindow[k]);
  return blankArrival();
}
