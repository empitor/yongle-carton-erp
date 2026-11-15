import type { DatabaseSync } from 'node:sqlite';
import type { Order } from '../../shared/core/index.js';
import { AppError } from './errors.js';

/*
 * 订单表归基础，但订单的发货进度、订料进度和“已有生产、送货记录的订单能不能这样改”都由单据决定，
 * 单据（送货单、生产任务）归单据流转、采购单归采购库存，基础不读它们的表。这里只定义要什么，由单据流转提供：
 * 单据流转加载时登记（server/flow/order-progress.ts 末尾）；没登记就报错，不会悄悄少字段、漏校验。
 * 过渡：合拢时订单视图整体搬到单据流转、调用方（server/app.ts 等）改调那边以后，删掉进度这两项。
 */

export type MaterialProgress = 'pending' | 'partial' | 'done';
export type OrderRules = {
  /** 每条订单明细的有效已发数量（千分单位，只算已确认的送货单）；orderIds 不给是全部订单 */
  shipped(db: DatabaseSync, orderIds: readonly number[] | undefined): Map<number, number>;
  /** 每张订单的订料进度（按有效采购明细的到货）；没有关联有效采购的订单不在结果里 */
  material(db: DatabaseSync, orderIds: readonly number[] | undefined): Map<number, MaterialProgress>;
  /** 改已有订单前按单据核对（maintenance 是本机管理员的数据维护） */
  editGuard(db: DatabaseSync, maintenance: boolean): OrderEditGuard;
};
let rules: OrderRules | null = null;
export function registerOrderRules(r: OrderRules) {
  rules = r;
}
export function orderRules(): OrderRules {
  if (!rules) throw new AppError('订单的发货、订料进度和改单核对要单据流转模块配合，但单据流转模块没有加载。', 500);
  return rules;
}

/** 这次要保存的订单（明细已按保存规则补齐单位、名称、价格） */
export type OrderEditInput = {
  customerId: number;
  status: string;
  lines: { id?: number; productId: number; quantity: number; unit: string; specification: string }[];
};
/**
 * 改已有订单前的校验。Store.saveOrder 在补齐明细之后、写库之前调它：
 * linked 是订单有没有关联生产、送货记录（有就原地改明细、保留编号，没有就整批重写明细）；
 * removeMissingLines：有关联时，这次没带上的原明细删掉（本机管理员的数据维护）；
 * 不允许的改法直接抛错。
 */
export type OrderEditGuard = (
  id: number,
  previous: Order | undefined,
  next: OrderEditInput,
) => { linked: boolean; removeMissingLines?: boolean };
