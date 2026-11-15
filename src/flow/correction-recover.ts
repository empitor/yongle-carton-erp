import { PREVIEW_CHANGED_CODE } from '../../shared/core/index';
import { correctionChangedMessage } from './flow-words';

/*
 * 更正窗核验、提交被拒以后怎么接着办（只算数据，读单据由调用处传进来）：别人刚改过这张单（版本变了）、
 * 或者服务端说核验以后单据、订单、库存变了（类别 preview-changed），窗口不卡住——读回最新的单据，
 * 人填的内容能留的留着，按最新的重新核验，再告诉人核对后再提交。
 */

/** 被拒的错误带的状态码和类别（src/ui 的请求出错时带上；别的错误没有） */
function rejection(error: unknown) {
  const e: object = typeof error === 'object' && error !== null ? error : {};
  return { status: 'status' in e ? e.status : undefined, code: 'code' in e ? e.code : undefined };
}

/**
 * 被 409 拒以后：先读回最新的单据。版本变了（输入带上新版本，内容一变就自己重新核验）或类别是 preview-changed
 * （版本没变，要显式再核验一次），返回要显示的那句和要不要显式重新核验；别的拒绝（库存不足、已被替代……）
 * 和别的错误返回 null，照服务端的原话显示。
 */
export async function recoverCorrection(
  error: unknown,
  version: number,
  refresh: () => Promise<{ version: number }>,
): Promise<{ notice: string; repreview: boolean } | null> {
  const e = rejection(error);
  if (e.status !== 409 && e.code !== PREVIEW_CHANGED_CODE) return null;
  const fresh = await refresh();
  const stale = fresh.version !== version;
  if (!stale && e.code !== PREVIEW_CHANGED_CODE) return null;
  return { notice: correctionChangedMessage, repreview: !stale };
}

/** 读回的最新单据上还在的行（index 还在范围里），人填的数留着；新加的行（没有 index）也留着 */
export function keepRows<T extends { index?: number }>(rows: T[], lines: unknown[] | undefined) {
  const kept = rows.filter((r) => r.index === undefined || r.index < (lines?.length ?? 0));
  return kept.length === rows.length ? rows : kept;
}
