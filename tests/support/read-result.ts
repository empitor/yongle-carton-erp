// 从结果里取测试要的数据，取不到就让测试失败（说清找的是什么）。
import type { FlowKind } from '../../shared/core/index.js';
import { z } from 'zod';
import type { FlowDocView } from '../../shared/business/index.js';

/** 读命令、读接口的结果是 unknown：按结构取出测试要比的几项（没列的键原样留着），对不上结构就让测试失败。 */
export const readAs = <T extends z.ZodRawShape>(value: unknown, shape: T) => z.looseObject(shape).parse(value);

/** 单据视图按种类收窄（测试要读这一种单据才有的栏目）：种类对不上就让测试失败 */
export function viewAs<K extends FlowKind>(view: FlowDocView, kind: K): FlowDocView<K> {
  if (!isKind(view, kind)) throw new Error('测试数据：单据 ' + view.id + ' 是 ' + view.kind + '，不是 ' + kind);
  return view;
}
const isKind = <K extends FlowKind>(view: FlowDocView, kind: K): view is FlowDocView<K> => view.kind === kind;

/** 测试数据里一定有的记录：没有就让测试失败 */
export function must<T>(value: T | null | undefined, what: string): T {
  if (value == null) throw new Error('测试数据：没有' + what);
  return value;
}
