/**
 * 产品的附属关系（比如小箱套在大箱里）：只用于显示上归组，订单、价格、库存都各算各的。
 * 产品档案上存 parentProductId；列表里附属品挂在它附属的产品下面，像主会话下面的子会话。
 */
export type FamilyProduct = { id: number; name: string; parentProductId?: number | null };

export type NestedRow<T> = {
  row: T;
  /** 0 是顶层，1 是附属品，2 是附属品的附属品 */
  depth: number;
  /** 同一个产品下面的最后一个附属品（连接线画成“└”，前面的画成“├”） */
  last: boolean;
  /** 附属的产品不在这一页（被筛掉了）时，标出它附属于谁 */
  parentOutside?: number;
};

/**
 * 按附属关系重排列表：原来的先后顺序不变，附属品紧跟在它附属的产品后面、往里缩一层。
 * productIdOf 取这一行对应的产品（产品列表就是自己的 id，成品库存是关联的产品）；
 * 一个产品对应几行（几个成品库存品）时，附属品挂在第一行下面。
 */
export function nestByFamily<T>(
  rows: readonly T[],
  productIdOf: (row: T) => number | null | undefined,
  parentOf: (productId: number) => number | null | undefined,
): NestedRow<T>[] {
  const firstRow = new Map<number, T>();
  for (const r of rows) {
    const id = productIdOf(r);
    if (id != null && !firstRow.has(id)) firstRow.set(id, r);
  }
  // 这一行挂在哪一行下面：它的产品有附属的产品，而且那个产品在这一页里
  const hostOf = (r: T): T | null => {
    const id = productIdOf(r),
      parent = id != null ? parentOf(id) : null;
    const host = parent != null ? firstRow.get(parent) : undefined;
    return host && host !== r ? host : null;
  };
  const children = new Map<T, T[]>();
  for (const r of rows) {
    const host = hostOf(r);
    if (host) children.set(host, [...(children.get(host) || []), r]);
  }
  const out: NestedRow<T>[] = [],
    placed = new Set<T>();
  const place = (r: T, depth: number, last: boolean) => {
    if (placed.has(r)) return;
    placed.add(r);
    const id = productIdOf(r),
      parent = id != null ? parentOf(id) : null;
    out.push({ row: r, depth, last, ...(depth === 0 && parent != null ? { parentOutside: parent } : {}) });
    const kids = (children.get(r) || []).filter((k) => !placed.has(k));
    kids.forEach((k, i) => place(k, depth + 1, i === kids.length - 1));
  };
  for (const r of rows) if (!hostOf(r)) place(r, 0, false);
  // 万一有绕成一圈的老数据，剩下的照原位置放在顶层
  for (const r of rows) place(r, 0, false);
  return out;
}

/** 这个产品下面所有层的附属品 id（编辑“附属于”时不能选它们，免得绕成一圈）。 */
export function descendantIds(products: readonly FamilyProduct[], id: number): Set<number> {
  const out = new Set<number>();
  let frontier = [id];
  while (frontier.length) {
    const next = products.filter((p) => p.parentProductId != null && frontier.includes(p.parentProductId) && !out.has(p.id));
    next.forEach((p) => out.add(p.id));
    frontier = next.map((p) => p.id);
  }
  return out;
}
