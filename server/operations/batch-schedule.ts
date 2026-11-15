import { z } from 'zod';
import { parseStoredJson } from '../core/index.js';
import { storedScheduleEntrySchema, type ScheduleEntry } from '../../shared/business/index.js';

/**
 * 订货单的到货安排（order_batches.schedule）：每段的结构是共用的 storedScheduleEntrySchema（shared/business/operations-stored.ts）。
 * 写（batches.ts 建订货单、改安排、移出采购单，deletion.ts 删采购单时去掉只属于它的行）和读都按这一份。
 */
const storedSchedule = z.array(storedScheduleEntrySchema);

/** 读一份订货单的到货安排：对不上按库里的数据报（StoredDataError，回 500、记日志） */
export const readBatchSchedule = (text: string, batchId: number): ScheduleEntry[] =>
  parseStoredJson(storedSchedule, text, 'order_batches.schedule（订货单 ' + batchId + '）');

/**
 * 要写进 schedule 列的文字：写之前按同一份结构核对。对不上是服务端自己拼错了安排，
 * 按服务端错误报（出错处理回 500、写进日志），不当成“输入不对”。which 说明是哪份订货单。
 */
export function batchScheduleText(entries: readonly ScheduleEntry[], which: string) {
  const checked = storedSchedule.safeParse(entries);
  if (!checked.success)
    throw new Error('到货安排不合库里的结构，没有写入（' + which + '）：' + z.prettifyError(checked.error), {
      cause: checked.error,
    });
  return JSON.stringify(checked.data);
}
