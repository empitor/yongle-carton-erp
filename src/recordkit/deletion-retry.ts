/*
 * 删除窗按查到的清单（范围摘要）删除被拒以后怎么接着办，和更正窗、核对窗同一个做法：服务端说预览以后数据变了
 * （409，类别 preview-changed，server/core/storage/preview-digest.ts），窗口不卡住——按最新的重新查一遍会一起处理的记录，
 * 告诉人清单换过了，核对后再点删除。别的拒绝（版本对不上、权限、密码不对……）照服务端的原话报。
 */
import { PREVIEW_CHANGED_CODE } from '../../shared/core/index';

/** 清单换成最新的以后给人看的那句 */
export const deletionChangedMessage = '要删的记录或会一起处理的记录刚有变化，下面已经换成最新的清单，请核对后再删除。';

const previewChanged = (error: unknown) => error instanceof Error && 'code' in error && error.code === PREVIEW_CHANGED_CODE;

/**
 * 删除（execute）；被拒的原因是预览以后数据变了时，调 repreview 按最新的重新查清单，查成了交回提示，不当出错；
 * 重新查也没查成，照查清单的出错抛出（清单没换成最新的，不说换过了）。办成交回结果；别的出错原样抛出。
 */
export async function deleteOrRepreview<R>(
  execute: () => Promise<R>,
  repreview: () => Promise<void>,
): Promise<{ done: R } | { notice: string }> {
  try {
    return { done: await execute() };
  } catch (e) {
    if (!previewChanged(e)) throw e;
  }
  await repreview();
  return { notice: deletionChangedMessage };
}
