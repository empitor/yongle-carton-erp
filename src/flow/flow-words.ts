import { flowDocNames, flowNames, type FlowKind } from '../../shared/business/index';

/**
 * 单据（生产任务、完工、到货、送货）给人看的固定说法：单据页、仓库页、各处弹出的单据窗口共用这一份，
 * 改一句话只改这里。
 */

/** 单据的叫法：详情头部的小字、窗口标题都用它。 */
export const docName = (d: { kind: FlowKind }) => flowNames[d.kind];

/** “撤销这次××”：已生效的单据撤回，业务页面不说“冲销”。 */
export const undoLabel = (kind: string) =>
  ({ delivery: '撤销这次送货', arrival: '撤销这次到货', production: '撤销这次完工', task: '撤销这张任务' })[kind] ||
  '撤销';
/** 还没生效的单据取消，生产任务做了一部分时取消的是剩下没做的。 */
export const cancelLabel = (doc: { kind: string }) =>
  doc.kind === 'delivery'
    ? '取消这次送货'
    : doc.kind === 'task'
      ? '取消这张任务'
      : doc.kind === 'production'
        ? '取消这次完工'
        : '取消这次到货';

/** 撤销后库存和关联数量怎么变：单据页和仓库页撤销送货、到货的提示都用它 */
const undoEffect: Record<string, string> = {
  delivery: '库存加回，订单已发数量减回',
  arrival: '库存扣回，采购已到货数量减回',
  production: '入库的成品扣回，领的纸板加回库存',
  task: '没有动库存',
};
/** 撤销、取消办完后的提示：办了哪几张、库存怎么变、单据还在不在 */
export const actionNotice = (type: string, done: { number: string; kind: string }[]) => {
  const numbers = done.map((r) => r.number).join('、'),
    kinds = [...new Set(done.map((r) => r.kind))];
  if (type === 'reverse')
    return (
      '已撤销 ' +
      numbers +
      (kinds.length === 1 && undoEffect[kinds[0]] ? '：' + undoEffect[kinds[0]] : '') +
      '，单据保留为“已撤销”。'
    );
  if (type === 'cancel')
    return (
      '已取消 ' +
      numbers +
      (kinds.length === 1 && kinds[0] === 'task' ? '：没做的不再生产，已做完入库的照旧' : '') +
      '，记录保留在列表里。'
    );
  return '已办好 ' + numbers + '。';
};
/** 核对后确认成功的提示 */
export const confirmedMessage = (kind: string) =>
  kind === 'delivery' ? '已出库，送货中。客户收到后点“确认送达”。' : '已核对入库，单据和库存流水已一起保存。';
/** 核对时单据、库存或关联档案被改了（服务端类别 preview-changed）：核对窗已换成最新内容，请人再看一遍 */
export const previewChangedMessage =
  '核对的时候单据、库存或关联档案有变化，下面已经换成最新的核对内容，请再看一遍再确认。';

/** 已生效以后能更正、能编辑说明的三种单据（叫法用 shared 词表的 flowDocNames） */
export type CorrectableKind = 'arrival' | 'delivery' | 'production';
export const isCorrectable = (kind: unknown): kind is CorrectableKind =>
  kind === 'arrival' || kind === 'delivery' || kind === 'production';
/** 更正已生效的单据：按钮、窗口标题都叫这个（改数量这类，撤销原单、另出一张替代单） */
export const correctLabel = (kind: CorrectableKind) => '更正' + flowDocNames[kind];
/** 核验、提交更正时这张单（版本）或关联的订单、库存刚变过：更正窗已按最新的单据重新核验 */
export const correctionChangedMessage = '这张单或关联的订单、库存刚被改过，已按最新的重新预览，请核对后再提交。';
/** 保存说明时这张单刚被别人改过（版本变了）：编辑窗已读回最新的内容，人改过的几项留着 */
export const infoChangedMessage = '这张单刚被改过，已读回最新的内容，请核对后再保存。';
/** 已生效单据的“编辑”（只改说明）保存后的提示 */
export const infoSavedMessage = (kind: CorrectableKind, result: { number: string; changed: boolean }) =>
  result.changed
    ? flowDocNames[kind] + ' ' + result.number + ' 已保存，库存' + (kind === 'production' ? '' : '和金额') + '没有变。'
    : '内容没有变化。';
/** 单据详情的链接（单据页、仓库页同一套地址） */
export const flowDocHref = (kind: string, id: number) =>
  (kind === 'delivery'
    ? '#warehouse?kind=finished&deliveries=1&doc='
    : kind === 'arrival'
      ? '#warehouse?arrivals=1&doc='
      : '#production?' + (kind === 'production' ? 'view=production&' : '') + 'doc=') + id;

/**
 * 单据保存后的提示：kind 是这张单据的类型，pageKind 是所在页面的类型（生产任务页里登记的完工要说去完工记录核对）。
 * 生产任务保存后直接下达，提示在别处。
 */
export function savedMessage(o: {
  kind: FlowKind;
  pageKind: FlowKind;
  /** 编辑窗里的单据：有编号是改已有的，没有是新登记 */
  editor: { id?: number };
  result: { number: string };
}) {
  const { kind: k, editor, result } = o;
  if (k === 'delivery')
    return (
      '送货安排 ' + result.number + ' 已保存' +
      '，在送货里待送货；导出送货单时出库。'
    );
  if (k === 'task') return '生产任务 ' + result.number + ' 已保存。';
  return (
    (editor.id
      ? (k === 'arrival' ? '到货单 ' : '完工单 ') + result.number + ' 已保存'
      : (k === 'arrival' ? '已登记到货 ' : '已登记完工 ') + result.number) +
    '，待核对入库' +
    (k === 'production' && o.pageKind !== 'production' ? '，在完工记录里核对。' : '。')
  );
}
