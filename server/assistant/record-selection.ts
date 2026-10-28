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
  ];
}
