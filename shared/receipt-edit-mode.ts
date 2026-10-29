/** 只读取真实用户消息，用于保留已明确的操作范围，不能提供管理员权限。 */
export function receiptEditMode(text: string): 'business' | 'data-edit' | undefined {
  const choices: { index: number; mode: 'business' | 'data-edit' }[] = [];
  for (const m of text.matchAll(
    /(?:不要|无需|不必|不需|不)(?:扣减|扣|调整|同步|变动)(?:当前|实际)?库存|库存(?:不变|保持不变)|仅(?:编辑|修改|修正)[^。；\n]{0,12}(?:历史|到货|业务)|数据编辑(?:模式)?/g,
  )) {
    if (/不要|不用|不采用/.test(text.slice(Math.max(0, m.index! - 3), m.index))) continue;
    choices.push({ index: m.index!, mode: 'data-edit' });
  }
  for (const m of text.matchAll(/同步(?:调整)?库存|正常业务更正/g)) {
    if (/不|无需|不要|不必/.test(text.slice(Math.max(0, m.index! - 3), m.index))) continue;
    choices.push({ index: m.index!, mode: 'business' });
  }
  return choices.sort((a, b) => a.index - b.index).at(-1)?.mode;
}
