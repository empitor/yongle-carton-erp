/** 仅从当前真实用户原话匹配服务器实际业务身份；不从备注或模型生成文本取确认。 */
export function namedRecordIds(text: string, rows: any[]): number[] {
  const normalize = (s: string) => s.normalize('NFKC').toLocaleUpperCase();
  const source = normalize(text),
    hits: { id: number; value: string; at: number }[] = [];
  for (const row of rows)
    for (const field of ['name', 'number', 'customerProductCode', 'supplierProductCode']) {
      const value = typeof row[field] === 'string' ? normalize(row[field].trim()) : '';
      if (value.length < 2) continue;
      const at = source.indexOf(value);
      if (at >= 0) hits.push({ id: row.id, value, at });
    }
  const exact = hits.filter(
    (h) =>
      !hits.some(
        (other) =>
          other.value.length > h.value.length &&
          other.at <= h.at &&
          other.at + other.value.length >= h.at + h.value.length,
      ),
  );
  return [
    ...new Set(
      exact
        .filter(
          (h) => new Set(exact.filter((x) => x.value === h.value).map((x) => x.id)).size === 1,
        )
        .map((h) => h.id),
    ),
    ...partlyNamedRecordIds(source, rows, normalize),
  ];
}
const MIN_NAME_FRAGMENT = 4;
function longestSharedFragment(a: string, b: string) {
  let best = '';
  let previous = new Array(b.length + 1).fill(0);
  for (let i = 1; i <= a.length; i++) {
    const current = new Array(b.length + 1).fill(0);
    for (let j = 1; j <= b.length; j++)
      if (a[i - 1] === b[j - 1]) {
        current[j] = previous[j - 1] + 1;
        if (current[j] > best.length) best = a.slice(i - current[j], i);
      }
    previous = current;
  }
  return best;
}
/**
 * 用户常常只说产品名的前半截，比如档案叫“虚构外箱（双瓦楞）（电商）”，用户说“虚构外箱（双瓦楞）”。
 * 说出的那段只有这一条档案有，才算点名；几条共有的部分（“虚构”）不算，那是真歧义。
 */
function partlyNamedRecordIds(source: string, rows: any[], normalize: (s: string) => string) {
  const names = rows
    .filter((row) => typeof row.name === 'string' && row.name.trim())
    .map((row) => ({ id: row.id as number, name: normalize(row.name.trim()) }));
  return names
    .filter(({ id, name }) => {
      const fragment = longestSharedFragment(name, source);
      return (
        fragment.length >= MIN_NAME_FRAGMENT &&
        !names.some((other) => other.id !== id && other.name.includes(fragment))
      );
    })
    .map(({ id }) => id);
}
