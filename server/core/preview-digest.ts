import { createHash } from 'node:crypto';
import { PREVIEW_CHANGED_CODE } from '../../shared/core/index.js';
import { AppError } from './errors.js';

/*
 * “先预览、人看过再确认”的写入（核对入库出库、更正、删除、初始化、登记完工、识别导入、重算到期日）只有这一种保护：
 * 预览返回 previewDigest（对预览里人看到、据此决定的内容算），提交时带回来；服务端在提交的事务里按当前数据把同一份内容
 * 重算一遍再比，对不上就拒绝。不存预览、不绑会话、不设过期：只看数据变没变。版本号校验是另一道保护，照旧各自做。
 */

/** 对不上时的说法（409，类别 PREVIEW_CHANGED_CODE：核对窗、更正窗按它自动换成最新的预览） */
export const PREVIEW_CHANGED = '预览以后数据已变化，请重新预览。';

/** 对象的键按名字排好再转 JSON：同样的内容、字段先后不同，摘要一样（数组的先后算内容） */
const sortedKeys = (_key: string, value: unknown) =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
    : value;

/** 预览摘要：sha256（十六进制）。预览和提交必须对同一份内容调用 */
export const previewDigest = (content: unknown) =>
  createHash('sha256').update(JSON.stringify(content, sortedKeys)).digest('hex');

/** 提交带来的摘要（given）和按当前数据重算的（current）对不上就拒绝；没带也算对不上 */
export function assertPreviewCurrent(given: string | undefined, current: string) {
  if (given !== current) throw new AppError(PREVIEW_CHANGED, 409, PREVIEW_CHANGED_CODE);
}
