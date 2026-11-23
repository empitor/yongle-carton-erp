import { isFlowKind } from '../../shared/core/index';
import type { ComponentProps } from 'react';
import { CorrectionDialog, DocumentInfoDialog, correctLabel, infoSavedMessage, isCorrectable } from '../flow/index';
import { MovementDialog } from '../operations/index';
import { DatabaseDeleteDialog } from '../recordkit/index';
import { businessRows, isManagedModule, textOf, type ListedRecord, type ManagedModule, type ManagedRecord } from './record-types';

/** 已生效的到货、送货、完工单“编辑”窗口要的内容；更正哪种单据；出入库 / 盘点窗口要的库存品 */
type InfoDoc = ComponentProps<typeof DocumentInfoDialog>['doc'];
type CorrectableKind = ComponentProps<typeof CorrectionDialog>['kind'];
type MoveItem = ComponentProps<typeof MovementDialog>['item'];
/**
 * 数据管理里和业务页面打开同一个窗口的几样：删除业务记录（先看影响清单）、已生效的到货、送货、完工单的“编辑”
 * （只改说明）和“更正××单”（改数量这类）、库存品的“出入库 / 盘点”。
 */
export type Linked =
  | { kind: 'delete'; module: ManagedModule; rows: ManagedRecord[] }
  | { kind: 'info'; doc: InfoDoc }
  | { kind: 'correct'; module: CorrectableKind; id: number }
  | { kind: 'move'; item: MoveItem };

/** 已生效、没被更正替代的到货、送货、完工单：编辑只改说明，改数量用更正 */
const effective = (module: string, r: ListedRecord) =>
  isCorrectable(module) && r.record.status === 'confirmed' && !r.record.replacedBy && !r.record.archived;
/** 已撤销、已取消、已被更正替代的单据不能再改，不出“编辑” */
export const editable = (module: string, r: ListedRecord) =>
  !isFlowKind(module) ||
  r.record.status === 'draft' ||
  (module === 'task' && r.record.status === 'confirmed') ||
  effective(module, r);
/** 库存品在出入库 / 盘点窗口里显示的几项（名称、当前数量和单位）和改它要带的版本号 */
const moveItem = (record: ManagedRecord): MoveItem => ({
  id: record.id,
  version: record.version,
  name: textOf(record.name),
  quantity: textOf(record.quantity),
  unit: textOf(record.unit),
});
/** 这一行的“编辑”打开哪个窗口：已生效的到货、送货、完工单只改说明；null 是数据管理自己的编辑窗 */
export const linkedEdit = (module: string, r: ListedRecord): Linked | null =>
  isCorrectable(module) && r.input && effective(module, r)
    ? {
        kind: 'info',
        doc: { ...r.record, kind: module, number: textOf(r.record.number), date: textOf(r.record.date) },
      }
    : null;
/**
 * 点“删除”打开哪个窗口：业务记录打开和业务页面同一个删除窗（先看影响清单，发 /deletions/execute）；
 * null 是识别文件，用数据管理自己的确认窗（走 AI 导入的地址）
 */
export const linkedDelete = (module: string, rows: readonly ListedRecord[]): Linked | null =>
  isManagedModule(module) ? { kind: 'delete', module, rows: businessRows(rows).map((r) => r.record) } : null;
/** 这一行“更多”里另有的窗口：已生效单据的更正、没归档的库存品的出入库 / 盘点 */
export const linkedExtra = (module: string, r: ListedRecord): { label: string; linked: Linked }[] =>
  isCorrectable(module) && r.input && effective(module, r)
    ? [{ label: correctLabel(module), linked: { kind: 'correct', module, id: r.record.id } }]
    : module === 'stock_items' && r.input && !r.record.archived
      ? [{ label: '出入库 / 盘点', linked: { kind: 'move', item: moveItem(r.record) } }]
      : [];

export default function LinkedDialogs({
  linked,
  close,
  finished,
}: {
  linked: Linked;
  close: () => void;
  /** 办完：关窗以后提示这句、重读列表；删除了的还要收起选择 */
  finished: (message: string, deleted: boolean) => void;
}) {
  const done = (message: string) => {
    close();
    finished(message, linked.kind === 'delete');
  };
  switch (linked.kind) {
    case 'delete':
      return <DatabaseDeleteDialog module={linked.module} rows={linked.rows} close={close} done={done} />;
    case 'info':
      return (
        <DocumentInfoDialog
          doc={linked.doc}
          close={close}
          saved={(result) => done(infoSavedMessage(linked.doc.kind, result))}
        />
      );
    case 'correct':
      return <CorrectionDialog id={linked.id} kind={linked.module} close={close} done={(result) => done(result.summary)} />;
    case 'move':
      return <MovementDialog item={linked.item} close={close} saved={() => done('库存变动已登记，流水已保存。')} />;
  }
}
