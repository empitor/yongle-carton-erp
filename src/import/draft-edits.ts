import { headerFields, lineFields, type DraftField, type DraftOperation, type OrderDraft } from '../../shared/import/index';

const isHeaderField = (key: string): key is (typeof headerFields)[number] => headerFields.some((k) => k === key);
const isLineField = (key: string): key is (typeof lineFields)[number] => lineFields.some((k) => k === key);
/** 识别结果里的一个格子：给了明细编号是那一行的格子，不给是单头的；没有这个格子返回 undefined */
function fieldOf(draft: OrderDraft, key: string, lineId?: string): DraftField | undefined {
  if (!lineId) return isHeaderField(key) ? draft.header[key] : undefined;
  const line = draft.lines.find((l) => l.id === lineId);
  return line && isLineField(key) ? line.fields[key] : undefined;
}

/**
 * 订单识别结果的本地修改：页面上改的先留在浏览器里，保存时把“和上次保存的比，改了哪些格子”
 * 变成修改操作发给服务端。只管比对和改值，不发请求、不依赖 React。
 */
export function draftOperations(before?: OrderDraft | null, after?: OrderDraft | null): DraftOperation[] {
  if (!before || !after) return [];
  const result: DraftOperation[] = [];
  for (const k of headerFields)
    if (before.header[k].value !== after.header[k].value)
      result.push({ op: 'set-header', field: k, value: after.header[k].value, reason: '人工编辑' });
  for (const line of after.lines) {
    const old = before.lines.find((l) => l.id === line.id);
    if (old)
      for (const k of lineFields)
        if (old.fields[k].value !== line.fields[k].value)
          result.push({
            op: 'set-line',
            lineId: line.id,
            field: k,
            value: line.fields[k].value,
            reason: '人工编辑',
          });
  }
  return result;
}

/** 改一个格子：返回改好的新识别结果（原来的不动）；空字符串存成“没有值”，并标成人工改过。 */
export function withFieldValue(draft: OrderDraft, key: string, value: string, lineId?: string): OrderDraft {
  const next = structuredClone(draft);
  const field = fieldOf(next, key, lineId);
  if (!field) return draft;
  field.value = value || null;
  field.certainty = 'user-modified';
  delete field.editedBy;
  return next;
}
