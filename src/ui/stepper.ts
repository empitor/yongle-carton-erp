/**
 * 详情面板里 ↑↓ 切换当前列表里的相邻记录：给 DetailPanel 的 previous、next。
 * key 取出比较用的值，current 是眼前这条的值；open 拿到相邻那条和它在列表里的位置（要翻页的页面按位置算页码）。
 * 眼前这条不在列表里时不动。
 */
export function stepper<T>(
  rows: T[],
  key: (row: T) => unknown,
  current: unknown,
  open: (row: T, index: number) => void,
) {
  const index = rows.findIndex((r) => key(r) === current);
  const go = (delta: number) => {
    const next = rows[index + delta];
    if (index >= 0 && next) open(next, index + delta);
  };
  return { previous: () => go(-1), next: () => go(1) };
}
