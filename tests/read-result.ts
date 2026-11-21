// 从结果里取测试要的数据，取不到就让测试失败（说清找的是什么）。
import { z } from 'zod';

/** 读命令、读接口的结果是 unknown：按结构取出测试要比的几项（没列的键原样留着），对不上结构就让测试失败。 */
export const readAs = <T extends z.ZodRawShape>(value: unknown, shape: T) => z.looseObject(shape).parse(value);

/** 测试数据里一定有的记录：没有就让测试失败 */
export function must<T>(value: T | null | undefined, what: string): T {
  if (value == null) throw new Error('测试数据：没有' + what);
  return value;
}
