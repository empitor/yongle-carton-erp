/**
 * 比较名字用的几种键，只用于比较，不改写保存的内容。全站比名字都从这里取，口径只有这三档：
 * - looseKey：去空白、英文小写。订单指纹和采购单号查重用它（口径不变）。
 * - nameKey：再统一全角半角（NFKC）。识别结果对应客户、产品用它。
 * - duplicateKey：再去掉常见分隔符号，“纸箱-A”“纸箱 a”“纸箱（A）”算同一个。新建客户、产品前查重用它（最严）。
 */
export const looseKey = (s: string) => s.trim().replace(/\s+/g, '').toLowerCase();
export const nameKey = (s: string) => s.normalize('NFKC').replace(/\s/g, '').toLowerCase();
export const duplicateKey = (value: unknown) =>
  nameKey(value === null || value === undefined ? '' : String(value)).replace(/[-_/\.·•,、:;'"“”‘’`()[\]【】{}<>《》|#*]+/g, '');
