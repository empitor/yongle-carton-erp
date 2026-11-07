/**
 * 把工具参数的 JSON Schema 压成一行短写法给模型看，信息不丢：字段名、选填、类型、可选值、数组都在。
 * 原来的 JSON Schema 每次调用模型都要带上六七万字，又贵又慢；页面上的“插件与工具”仍显示完整结构。
 *
 * 写法：{id:int, note?:str, status:a|b, items:[{lineId:int}]}，? 是选填，| 是可选值，[] 是数组。
 */
export function compactSchema(schema: unknown): string {
  const s = (schema ?? {}) as Record<string, any>;
  if (Array.isArray(s.enum)) return s.enum.map(String).join('|');
  if (s.const !== undefined) return String(s.const);
  for (const key of ['anyOf', 'oneOf'] as const)
    if (Array.isArray(s[key])) {
      const parts = s[key].filter((x: any) => x?.type !== 'null').map(compactSchema);
      const text = [...new Set(parts)].join('|');
      return s[key].some((x: any) => x?.type === 'null') ? text + '|null' : text;
    }
  if (Array.isArray(s.allOf)) return s.allOf.map(compactSchema).join('&');
  if (s.type === 'array') return '[' + compactSchema(s.items) + ']';
  if (s.type === 'object' || s.properties) {
    const properties = (s.properties ?? {}) as Record<string, unknown>;
    const required = new Set<string>(s.required ?? []);
    const fields = Object.entries(properties).map(
      ([key, value]) => key + (required.has(key) ? '' : '?') + ':' + compactSchema(value),
    );
    if (!fields.length && s.additionalProperties && s.additionalProperties !== false)
      return 'map<' + compactSchema(s.additionalProperties) + '>';
    return '{' + fields.join(',') + '}';
  }
  if (s.type === 'integer') return 'int';
  if (s.type === 'number') return 'num';
  if (s.type === 'boolean') return 'bool';
  if (s.type === 'string') {
    if (s.format === 'uuid') return 'uuid';
    const pattern = String(s.pattern ?? '');
    if (pattern.includes('\\d{4}-') && pattern.includes('\\d{2}')) return 'date';
    return 'str';
  }
  return 'any';
}
