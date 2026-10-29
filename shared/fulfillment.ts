export type ShippingProgress = '未发货' | '部分发货' | '已发完' | '历史数量待核对';
export type ArrivalProgress = '未到货' | '部分到货' | '全部到货';
export function arrivalLineStatus(planned: number, received: number) {
  return received >= planned ? '已到齐' : received > 0 ? '部分到货' : '未到货';
}
export function shippingLineStatus(planned: number, shipped: number | null): ShippingProgress {
  return shipped === null
    ? '历史数量待核对'
    : shipped >= planned
      ? '已发完'
      : shipped > 0
        ? '部分发货'
        : '未发货';
}
// 仅由后端在读取真实有效单据后调用；界面、报表及工具直接使用返回结果。
export function fulfillmentSummary(
  states: string[],
  complete: string,
  partial: string,
  empty: string,
  unknown?: string,
) {
  const completedLines = states.filter((s) => s === complete).length;
  const unknownLines = unknown ? states.filter((s) => s === unknown).length : 0;
  return {
    progress: unknownLines
      ? unknown!
      : states.length && completedLines === states.length
        ? complete
        : states.some((s) => s !== empty)
          ? partial
          : empty,
    completedLines,
    totalLines: states.length,
    unknownLines,
  };
}
