import type { CustomerInput, PlannedOrderInput, ProductInput } from '../core/index.js';

/*
 * 正式导入的计划和回执（服务端 server/import/import-plan.ts 生成、import-execution.ts 执行；导入预览窗、批量导入窗按它显示）。
 * 一个客户或一行产品用哪个档案：新建的带上相近的已有档案（similar，写明名称和资料），
 * 预览和助手的确认卡片上列给人看：人点确认就新建，不再要求“用户原话说过新建”。
 */
type ExistingRef = { mode: 'existing'; id: number; version: number; name: string };
type NewRef<I> = { mode: 'new'; key: string; input: I; name: string; similar: string[] };
export type CustomerPlanRef = ExistingRef | NewRef<CustomerInput>;
export type ProductPlanRef = ExistingRef | (NewRef<ProductInput> & { lineId: string });
/** 要新建、但已有同名产品（或同一张订单里另一行同名、资料不同）的一行：人确认“是另一个产品”才建 */
export type SameNameConfirmation = { lineId: string; line: number; name: string; existing: string[] };
export type Plan = {
  policyVersion: string;
  source: { id: string; hash: string; fileName: string; revision: number };
  customer: CustomerPlanRef;
  products: ProductPlanRef[];
  order: PlannedOrderInput;
  fingerprint: string;
  /** 订单金额合计（原币，精确小数）；明细数量单价有缺时算不出来是 null（这种识别结果过不了导入前的核对） */
  total: string | null;
  warnings: string[];
  confirmations: SameNameConfirmation[];
};
/** 导入预览：导入计划（给人看）和预览摘要，正式导入时带回摘要和这一版识别结果的版本号 */
export type ImportPreview = { previewDigest: string; plan: Plan };
/** 正式导入的回执：建了哪张订单，建了哪些档案（同一份预览重交时原样回这一份） */
export type ImportReceipt = {
  executionId: string;
  orderId: number;
  orderNumber: string;
  sourceId: string;
  fileHash: string;
  fileName: string;
  at: string;
  digest: string;
  created: { entity: string; id: number }[];
  orderVersion: number;
};
/** 按标准订单检查这份识别结果：还要补的（issues）、能后补的提示（notices）；还没识别是 null */
export type StandardOrderCheck = { issues: string[]; notices: string[] } | null;
