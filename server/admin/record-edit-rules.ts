import { z, type ZodError } from 'zod';
import { dataManagementFieldName } from '../../shared/business/index.js';
import { priceEdit, userError } from '../../shared/core/index.js';
import { AppError } from '../core/index.js';
// 数据管理改一条记录时的几条规则：校验没过怎么说、改价的补丁是什么意思（DataManagementService.execute 用）

/**
 * 数据管理窗口保存时校验没过：和全站同一个写法（shared/core/user-errors.ts 的 userError，中文冒号、“明细第2项的数量”这样说），
 * 只是字段按数据管理编辑窗里的叫法（“加工成本（元）”，明细的“第N项”和编辑窗卡片一致）。
 * 有“上一层.字段”专门叫法的（预估成本里的几项）已经说清是哪一项，不再带上一层的名字；
 * 单价的“分”编辑窗里不显示（由“元”算出来），按“元”那一格说；同一句只说一次。
 * 不收的栏目（field-rejection.ts）也按这一套说是哪一格，另传 nameOf 先查读出来才有的栏目的叫法。
 */
const shownTwin: Record<string, string> = {
  unitPriceCents: 'unitPriceExact',
  priceCents: 'priceExact',
};
type Issue = Pick<ZodError['issues'][number], 'path' | 'message'>;
export function readableIssues(
  issues: readonly Issue[],
  module: string,
  nameOf: (key: string, parent: string) => string | undefined = () => undefined,
) {
  const namer: Parameters<typeof userError>[1] = (key, parent) => {
    const shown = shownTwin[key] || key,
      label = nameOf(key, parent) ?? dataManagementFieldName(shown, parent, module);
    return { label, alone: !!parent && label !== dataManagementFieldName(shown) };
  };
  return [
    ...new Set(issues.map((i) => userError(i.path.join('.') + ': ' + i.message, namer))),
  ].join('；');
}
/**
 * 补丁是不是整条记录带回来的、只少了 key 这一个键：数据管理的单条编辑把列表给的 input 整份改完带回来，
 * 原来有这个键、现在别的键都在、唯独它没了，就是人把它删了（当作点名清空）。只带改的字段的补丁不算。
 */
export function wholeRecordWithout(
  patch: Record<string, unknown>,
  input: Record<string, unknown> | undefined,
  key: string,
) {
  return (
    !!input &&
    Object.hasOwn(input, key) &&
    !Object.hasOwn(patch, key) &&
    Object.keys(input).every((k) => k === key || Object.hasOwn(patch, k))
  );
}
/** 一行明细：一个对象；带回来的不是对象的原样交给订单校验去拦 */
const lineObject = z.record(z.string(), z.unknown());
const withLines = z.object({ lines: z.array(lineObject) });
/** 原订单（列表给的 record）、编辑窗内容（input）里的明细；没有明细的当没有 */
const linesOf = (holder: unknown) => {
  const parsed = withLines.safeParse(holder);
  return parsed.success ? parsed.data.lines : [];
};
const textOf = (value: unknown) => (typeof value === 'string' ? value : '');
/**
 * 数据管理改订单明细的单价：每一行先按 priceEdit（shared/core/precision.ts）判断，把保存时 chosenExact
 * 会得出的结论先套用到提交的明细上，订单校验（不足一分的尾数等）就按实际要存的价格算：
 * - 按“分”存的行去掉带回来的旧精确价（分改了、精确价还是原来的）。不去掉的话尾数校验按旧精确价算，
 *   改了数量和分的明细会被误拦成“精确金额包含不足一分的尾数”；
 * - 精确价点名清空、分没动的行拒收：明细单价必填，不能清成没定价。
 * 只看原有明细（编号和产品都对得上，和 Store.saveOrder 找原明细同一个办法）；新加的明细照提交的存。
 */
export function orderLinesPriceEdit(lines: readonly unknown[], before: unknown, input: unknown) {
  const oldLines = linesOf(before),
    oldInputs = linesOf(input);
  return lines.map((raw, i) => {
    const parsed = lineObject.safeParse(raw);
    if (!parsed.success) return raw;
    const line = parsed.data;
    const old = oldLines.find((x) => x.id === line.id && x.productId === line.productId);
    if (!old) return line;
    const oldInput = oldInputs.find((x) => x.id === line.id);
    const edit = priceEdit(
      line,
      old,
      { exact: 'unitPriceExact', cents: 'unitPriceCents' },
      wholeRecordWithout(line, oldInput, 'unitPriceExact'),
    );
    if (edit === 'clear')
      throw new AppError(
        '第' +
          (i + 1) +
          '项“' +
          (textOf(line.productName) || textOf(old.productName)) +
          '”：请填写单价。订单明细的单价不能清空，要按“单价（分）”存就把分改成新的价格。',
      );
    if (edit !== 'cents') return line;
    const rest = { ...line };
    delete rest.unitPriceExact;
    return rest;
  });
}
