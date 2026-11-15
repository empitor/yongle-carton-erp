// 助手的数据管理命令（management.execute）交给原数据管理服务（DataManagementService）之前要补的一件事：
// 改产品、库存品的尺寸单位时，按原单位把每条记录的长宽高换算好（dimensionPolicy 不是 relabel），
// 放进 patches 按记录给；原单位不知道就拒绝，不猜。别的命令原样交过去。
import { convertDimension, normalizeDimensionUnit } from '../../shared/core/index.js';
import { AppError } from '../core/index.js';
import { field } from './chat/result-fields.js';

type Command = {
  module: string;
  action: string;
  items: { id: number; version: number }[];
  patch: Record<string, unknown>;
  patches?: Record<string, Record<string, unknown>>;
  dimensionPolicy?: 'convert' | 'relabel';
};

/** 记录上一边的尺寸：数字或没填（null）；别的样子说明记录读错了 */
function dimension(record: unknown, axis: string) {
  const value = field(record, axis);
  if (value === null || typeof value === 'number') return value;
  throw new Error('记录的尺寸不是数字：' + axis);
}

/** records 是这几条记录改之前的样子（按编号能找到） */
export function withDimensionConversion<T extends Command>(command: T, records: readonly unknown[]): Omit<T, 'dimensionPolicy'> {
  const { dimensionPolicy, ...input } = command;
  const converts =
    command.action === 'update' &&
    !!command.patch.dimensionUnit &&
    ['products', 'stock_items'].includes(command.module) &&
    dimensionPolicy !== 'relabel';
  if (!converts) return input;
  const to = normalizeDimensionUnit(command.patch.dimensionUnit);
  const patches: Record<string, Record<string, unknown>> = { ...command.patches };
  for (const item of command.items) {
    const before = records.find((r) => field(r, 'id') === item.id);
    const from = normalizeDimensionUnit(field(before, 'dimensionUnit'));
    if (!before || !from || !to)
      throw new AppError('原尺寸单位未知，不能猜测换算；请明确仅更正标签或实际尺寸。', 409);
    const each: Record<string, unknown> = { ...patches[String(item.id)] };
    for (const axis of ['length', 'width', 'height'])
      if (!Object.hasOwn(command.patch, axis)) each[axis] = convertDimension(dimension(before, axis), from, to);
    patches[String(item.id)] = each;
  }
  return { ...input, patches };
}
