import type { ApiJson } from '../../shared/core/index';
import type { JsonObject } from './record-types';

/**
 * 数据管理编辑窗改了一格以后这一层的内容。module 是这一层在改哪一类记录：
 * 送货单换了客户，原来选的收货厂区属于旧客户，一起清空（保存时取新客户的默认厂区）。
 */
export function withField(value: JsonObject, key: string, next: ApiJson, module: string): JsonObject {
  const siteGone = key === 'customerId' && module === 'delivery' && value.customerId !== next;
  return { ...value, ...(siteGone ? { siteId: null } : {}), [key]: next };
}
