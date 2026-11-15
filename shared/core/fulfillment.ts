/** 发货进度的三种说法（订单整体、每行明细都用） */
export const shippingProgresses = ['未发货', '部分发货', '已发完'] as const;
export type ShippingProgress = (typeof shippingProgresses)[number];
export function arrivalLineStatus(planned: number, received: number) {
  return received >= planned ? '已到齐' : received > 0 ? '部分到货' : '未到货';
}
export function shippingLineStatus(planned: number, shipped: number): ShippingProgress {
  return shipped >= planned ? '已发完' : shipped > 0 ? '部分发货' : '未发货';
}
// 仅由后端在读取真实有效单据后调用；界面、报表及工具直接使用返回结果。
/** 进度的取值就是传进来的三种说法（S 按这三个推，不按 states 推，states 是 any 时进度也不会变成 any） */
export function fulfillmentSummary<S extends string>(states: readonly NoInfer<S>[], complete: S, partial: S, empty: S) {
  const completedLines = states.filter((s) => s === complete).length;
  return {
    progress:
      states.length && completedLines === states.length
        ? complete
        : states.some((s) => s !== empty)
          ? partial
          : empty,
    completedLines,
    totalLines: states.length,
  };
}
