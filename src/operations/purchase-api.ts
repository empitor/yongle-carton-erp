import type { StockFlowApi, RecordStatusAction } from '../../shared/business/index';
import { call } from '../ui/index';

/** 采购单的请求：整张保存、改状态（接口表 shared/business/stock-flow-api.ts）。 */

const stock = call<StockFlowApi>();

/** 交给服务端的采购单：录入的内容（purchaseSchema 的输入）；改的时候带打开窗口时读到的版本号 */
export type PurchaseBody = StockFlowApi['POST /purchases']['body'] & { version?: number };

/**
 * 存一张采购单：没有 id 是新建，有 id 是整张保存（不改状态）。改的时候版本号取自表单（打开窗口时读到的），
 * 没带版本号就是程序没按打开时的内容保存，本地说清楚、不发（服务端也会拒）。
 */
export const savePurchase = async (body: PurchaseBody, id?: number) => {
  if (!id) return stock('POST /purchases', { body });
  const { version } = body;
  if (version === undefined) throw new Error('改采购单要带打开时读到的版本号，请关掉窗口重新打开再改。');
  return stock('PUT /purchases/:id', { params: { id }, body: { ...body, version } });
};

/**
 * 改采购单状态（改成待到货、退回待订货、取消、恢复）：各是一个动作，POST /api/purchases/:id/<动作>，
 * 带读到时的版本号；取消要原因（记进修改历史）。整张保存不改状态。
 */
export function changePurchaseStatus(row: { id: number; version: number }, action: RecordStatusAction, reason?: string) {
  return stock(`POST /purchases/:id/${action}`, {
    params: { id: row.id },
    body: { expectedVersion: row.version, requestId: crypto.randomUUID(), ...(reason ? { reason } : {}) },
  });
}
