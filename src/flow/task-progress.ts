import { quantityString, quantityUnits } from '../../shared/core/index';
import { taskLeftUnits, type FlowDocView } from '../../shared/business/index';

/**
 * 生产任务进度的显示：完工数、还差多少、能不能登记由服务端视图和 shared/business/flow/task-progress.ts 算，
 * 这里只把它们写成给人看的话，以及编辑一张待入库的完工单时扣掉它自己。
 */

/** 要看的任务字段：编号、计划数和单位、已核对入库、已登记待入库 */
type TaskShown = Pick<FlowDocView<'task'>, 'id' | 'quantity' | 'unit' | 'completed' | 'pendingCompleted'>;

/** 还差多少（数量文本，不小于 0） */
export const remainingText = (t: Parameters<typeof taskLeftUnits>[0]) => quantityString(Math.max(0, taskLeftUnits(t)));
/** 已登记、待核对入库的数量文本；没有时是空串 */
export function waitingText(t: { pendingCompleted?: string }) {
  const pending = t.pendingCompleted || '0';
  return quantityUnits(pending) > 0 ? pending : '';
}

type OpenedCompletion = { ownTask: unknown; own: boolean; good: unknown };
/**
 * 任务上“已核对入库”“已登记、待核对入库”的数（千分整数），扣掉正在编辑的这张待入库完工单自己（它算在 pendingCompleted 里）；
 * 挂的不是这张任务的不扣。excluded：扣过这张自己，界面上写明“不算这张”。
 */
export function taskCounts(t: Pick<TaskShown, 'id' | 'completed' | 'pendingCompleted'>, opened: OpenedCompletion) {
  const mine = opened.own && opened.ownTask === t.id ? quantityUnits(String(opened.good || '0')) : 0,
    pending = quantityUnits(t.pendingCompleted || '0');
  return {
    done: quantityUnits(t.completed || '0'),
    waiting: Math.max(0, pending - mine),
    excluded: mine > 0,
  };
}
/** 完工单编辑窗里任务选项的后半句：已完工 / 计划，另有多少待核对入库；数和超计划提示同一组 */
export function taskOptionText(t: TaskShown, opened: OpenedCompletion) {
  try {
    const { done, waiting, excluded } = taskCounts(t, opened);
    return (
      '已完工 ' + quantityString(done) + ' / ' + t.quantity + ' ' + t.unit +
      (waiting ? '（另有 ' + quantityString(waiting) + ' ' + t.unit + '待核对入库）' : '') +
      (excluded ? ' · 不算这张' : '')
    );
  } catch {
    // 数量文字读不出来（库里的数不合格式）：照原样写出来，不让选项列表整个出错
    return '已完工 ' + t.completed + ' / ' + t.quantity + ' ' + t.unit;
  }
}

/**
 * 单张完工超计划的提示（只提示不拦），和服务端（FlowService.validate）同一口径：
 * 已核对入库 + 别的已登记、待核对入库 + 本次合格，都不算正在编辑的这张自己。没超是空串。
 */
export function overPlanText(t: TaskShown & Pick<FlowDocView<'task'>, 'number'>, goodQuantity: string, opened: OpenedCompletion) {
  try {
    const { done, waiting, excluded } = taskCounts(t, opened),
      good = quantityUnits(goodQuantity || '0');
    if (done + waiting + good <= quantityUnits(t.quantity)) return '';
    return (
      '本次完工后将超过生产计划数量（生产任务 ' + t.number + ' 计划 ' + t.quantity + ' ' + t.unit +
      (excluded ? '，不算这张：' : '，') +
      '已核对入库 ' + quantityString(done) + ' ' + t.unit +
      (waiting ? '，另有 ' + quantityString(waiting) + ' ' + t.unit + '已登记、待核对入库' : '') +
      '），请核对实际产量。'
    );
  } catch {
    // 合格数还没填成数字（正在输入）：先不提示，保存时服务端会说清哪一格不对
    return '';
  }
}
