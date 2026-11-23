import {
  DRAFT_NOTE_MAX,
  fieldLabels,
  evaluateDraft,
  invalidateImportMapping,
  type DraftField,
  type DraftOperation,
  type DraftChange,
  type ImportMapping,
  type OrderDraft,
} from '../../shared/import/index.js';
import { dateSchema, normalizeDimensionUnit, parseDimension, convertDimension, dimensionKeys, readTaxRate } from '../../shared/core/index.js';
import { AppError } from '../core/index.js';
import type { Workspace } from './workspace-document.js';

/**
 * 订单识别结果的修改规则：人工和 AI 聊天的逐字段修改、撤回、保存客户和产品的匹配。
 * 只改传进来的工作区对象，不读写库；保存由调用方做。
 */
export type EditableWorkspace = Pick<
  Workspace,
  'draft' | 'history' | 'mapping' | 'mappingInvalidated' | 'changes'
>;

const numericFields = ['quantity', 'unitPrice', 'statedAmount', 'statedTotalQuantity', 'statedTotalAmount'];
/** 最多能撤回几次 */
const MAX_UNDO = 80;

/** 换尺寸单位时，同一行没一起改的长宽高按 1cm=10mm 换算后跟着改 */
function withDimensionConversions(draft: OrderDraft, operations: DraftOperation[]) {
  const expanded = [...operations];
  for (const op of operations) {
    if (op.op !== 'set-line' || op.field !== 'dimensionUnit') continue;
    const line = draft.lines.find((l) => l.id === op.lineId);
    if (!line) continue;
    const from = normalizeDimensionUnit(line.fields.dimensionUnit.value),
      to = normalizeDimensionUnit(op.value);
    if (!from || !to || from === to) continue;
    for (const axis of dimensionKeys) {
      if (operations.some((o) => o.op === 'set-line' && o.lineId === op.lineId && o.field === axis)) continue;
      try {
        const number = convertDimension(parseDimension(line.fields[axis].value), from, to);
        if (number !== null)
          expanded.unshift({
            op: 'set-line',
            lineId: op.lineId,
            field: axis,
            value: String(number),
            reason: '尺寸单位换算：1cm=10mm',
          });
      } catch {
        throw new AppError('尺寸不是有效正数，请先修正或清空后再切换单位。');
      }
    }
  }
  return expanded;
}

/** 一次修改指向的那一格；明细编号不存在就拒绝 */
function targetField(draft: OrderDraft, op: DraftOperation): DraftField {
  if (op.op === 'set-header') return draft.header[op.field];
  const line = draft.lines.find((l) => l.id === op.lineId);
  if (!line) throw new AppError('修改指向不存在的订单明细。', 422, 'model-schema');
  return line.fields[op.field];
}
/** 改成的值合不合格：数字栏要明确的非负十进制数（数量大于零），日期要有效 */
function checkValue(field: DraftOperation['field'], value: string | null) {
  if (value === null) return;
  if (
    numericFields.includes(field) &&
    (!/^(?:0|[1-9]\d{0,14})(?:\.\d{1,12})?$/.test(value) || (field === 'quantity' && Number(value) <= 0))
  )
    throw new AppError('数量、单价和金额必须是明确的非负十进制数；数量须大于零。');
  if (field === 'taxRate' && readTaxRate(value) === null)
    throw new AppError('税率须在 0% 到 100% 之间，最多两位小数。小于 1% 的非零税率要写百分号，例如 0.5%。');
  if (['orderDate', 'deliveryDate'].includes(field) && !dateSchema.safeParse(value).success)
    throw new AppError('修改日期必须填写有效 YYYY-MM-DD；年份不明时应先提问。');
}
/** 把新值写进这一格，标成人改过、记下谁改的和为什么 */
function writeField(field: DraftField, op: DraftOperation, value: string | null, edit: { origin: 'manual' | 'ai'; recalculate: boolean }) {
  if (op.field === 'taxRate' && field.originalValue === undefined) field.originalValue = field.value;
  field.value = value;
  field.certainty = 'user-modified';
  if (edit.recalculate && ['quantity', 'unitPrice'].includes(op.field)) field.recalculated = true;
  else delete field.recalculated;
  // 来源如实记：助手改的就写助手改的，不说成“用户说的”
  if (edit.origin === 'ai') field.editedBy = 'assistant';
  else delete field.editedBy;
  field.note = ((edit.origin === 'ai' ? '助手改的：' : '人工修改：') + op.reason).slice(0, DRAFT_NOTE_MAX);
}

/** 按顺序改字段；有改动就记一步可撤回的历史，并让失效的匹配作废。返回改了什么。 */
export function applyDraftOperations(w: EditableWorkspace, operations: DraftOperation[], origin: 'manual' | 'ai') {
  if (!w.draft) throw new AppError('请先识别。');
  if (w.history.length >= MAX_UNDO) throw new AppError('可撤回修改次数超过 80 次，请另建工作区。');
  const before = structuredClone(w.draft),
    changes: DraftChange[] = [];
  const priorAmountValid = !evaluateDraft(before).issues.some(
    (i) => i.severity === 'error' && /statedAmount|statedTotalQuantity|statedTotalAmount/.test(i.path),
  );
  for (const op of withDimensionConversions(w.draft, operations)) {
    const field = targetField(w.draft, op);
    const value = op.value === null ? null : op.value.trim() || null;
    checkValue(op.field, value);
    if (value === field.value) continue;
    changes.push({
      path: op.op === 'set-header' ? 'header.' + op.field : 'lines.' + op.lineId + '.' + op.field,
      label: fieldLabels[op.field],
      before: field.value,
      after: value,
      reason: op.reason,
      by: origin === 'ai' ? 'assistant' : 'person',
    });
    writeField(field, op, value, { origin, recalculate: priorAmountValid });
  }
  if (changes.length) {
    w.history.push({ draft: before, changes });
    w.changes = changes;
    const match = invalidateImportMapping(w.mapping, before, w.draft, w.mappingInvalidated);
    w.mapping = match.mapping;
    w.mappingInvalidated = match.invalidated;
  } else w.changes = [];
  return changes;
}

/** 撤回最近一次修改；改动记录反过来写 */
export function undoDraftEdit(w: EditableWorkspace) {
  const last = w.history.pop();
  // 有可撤回的修改一定有识别结果（改的就是它）
  if (!last || !w.draft) throw new AppError('没有可撤回的修改。');
  const match = invalidateImportMapping(w.mapping, w.draft, last.draft, w.mappingInvalidated);
  w.draft = last.draft;
  w.mapping = match.mapping;
  w.mappingInvalidated = match.invalidated;
  w.changes = last.changes.map((c) => ({ ...c, before: c.after, after: c.before, reason: '撤回最近一次修改' }));
  return w.changes;
}

/**
 * 保存客户和产品的匹配。选“已有档案”的先经档案核对（validate：在不在、版本对不对）。
 * 人重新选过的，从“匹配已失效”的提示里去掉。
 */
export function applyMapping(w: EditableWorkspace, mapping: ImportMapping, validate: (m: ImportMapping) => void) {
  const draft = w.draft;
  if (!draft) throw new AppError('请先识别订单。');
  if (Object.keys(mapping.products).some((id) => !draft.lines.some((l) => l.id === id)))
    throw new AppError('匹配对象不属于当前订单。');
  validate(mapping);
  w.mapping = mapping;
  if (w.mappingInvalidated) {
    if (mapping.customer.mode !== 'pending') delete w.mappingInvalidated.customer;
    for (const id of Object.keys(w.mappingInvalidated.products))
      if (mapping.products[id]?.mode && mapping.products[id].mode !== 'pending') delete w.mappingInvalidated.products[id];
  }
}
