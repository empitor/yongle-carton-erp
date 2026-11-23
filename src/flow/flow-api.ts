import type { FlowApi, FlowPreview, flowUndoActions } from '../../shared/business/index';
import type { LifecycleAction } from '../recordkit/lifecycle';
import { call } from '../ui/index';
import { PREVIEW_CHANGED_CODE, type FlowKind } from '../../shared/core/index';
import { previewChangedMessage } from './flow-words';

/**
 * 单据流转的请求：单据页、仓库页、各办理窗口和 AI 导入的到货单都走这里，组件里不写地址。
 * 按接口表发（shared/business/flow/flow-api.ts），参数和回答的类型都来自表。
 */
const flow = call<FlowApi>();

/** 到货单原件（送货单拍照、扫描件）的地址：详情里“查看原件”的链接都用它 */
export const flowSourceFileUrl = (sourceId: string) => '/api/flow/sources/' + sourceId + '/file';

/** 读一张单据（按钮按它现在的状态算） */
export const readFlow = (id: number) => flow('GET /flow/:id', { params: { id } });

/** 一类单据的列表；archived 为真时读已归档的 */
export const readFlowList = (kind: FlowKind, archived: boolean) =>
  flow('GET /flow', { query: { kind, archived: archived ? '1' : undefined } });

const readDaily = (query: FlowApi['GET /flow/daily']['query']) => flow('GET /flow/daily', { query });
/** 到货、送货的台账回答（按到货、送货读的，不会是生产任务） */
function ledger(d: Awaited<ReturnType<typeof readDaily>>) {
  if (d.kind === 'task') throw new Error('仓库台账要的是到货、送货记录，读到的却是生产任务。');
  return d;
}

/** 到货、送货页的记录：days 给了只读待处理的和最近这么多天的，不给读全部 */
export const readFlowDaily = (kind: 'arrival' | 'delivery', days: number | null) =>
  readDaily(days === null ? { kind, scope: 'all' } : { kind, scope: 'recent', days }).then(ledger);

/**
 * 点开的这张到货单、送货单在台账里的样子（验收入库、每行的采购单或订单进度、入库出库流水），已归档的也读得到。
 * 台账按单据编号只组装这一张；单据已经删掉时没有（null）。
 */
export const readFlowRecord = (kind: 'arrival' | 'delivery', id: number) =>
  readDaily({ kind, doc: id }).then((d) => ledger(d).records.at(0) ?? null);

/** 新建一张单据（正文带请求号）：没有采购单的到货、生产任务、送货；完工只走登记完工 */
export const createFlow = (kind: Exclude<FlowKind, 'production'>, body: FlowApi['POST /flow/:kind']['body']) =>
  flow('POST /flow/:kind', { params: { kind }, body });

/** 改写还没核对的这张：正文带请求号和打开时的版本号 */
export const updateFlow = (id: number, body: FlowApi['PUT /flow/:id']['body']) =>
  flow('PUT /flow/:id', { params: { id }, body });

/** 取消（还没核对的作废）、撤销（已核对的撤回）：版本号、原因、确认看过了 */
export const undoFlow = (
  id: number,
  action: (typeof flowUndoActions)[number],
  body: FlowApi['POST /flow/:id/cancel']['body'],
) => flow(`POST /flow/:id/${action}`, { params: { id }, body });

/** 批量归档、恢复（每张单独办，逐张回成没成）：和档案同一个样子、同一套说法（src/recordkit/lifecycle.ts 的 lifecycleOutcome） */
export const archiveFlows = (action: LifecycleAction, rows: readonly { id: number; version: number }[]) =>
  flow('POST /flow/batch', {
    body: { action, acknowledged: true, items: rows.map((r) => ({ id: r.id, version: r.version })) },
  }).then((r) => r.results);

/** 送货中的送货单客户收到了：打开时的版本号、送达日期 */
export const markDelivered = (id: number, body: FlowApi['POST /flow/:id/delivered']['body']) =>
  flow('POST /flow/:id/delivered', { params: { id }, body });

/**
 * 已生效的到货、送货、完工单的“编辑”：只改备注、时间、地址联系人、操作人这类说明，不动库存和金额、不出替代单。
 * body 是 expectedVersion 加上改了的那几项（批次块的“写备注”也走这里）。
 */
export const saveDocumentInfo = (id: number, body: FlowApi['POST /flow/:id/info']['body']) =>
  flow('POST /flow/:id/info', { params: { id }, body });

/** 更正已生效的到货、送货、完工单：先按更正后的内容核验影响（服务端按单据种类分派） */
export const previewCorrection = (id: number, input: FlowApi['POST /flow/:id/correction-preview']['body']) =>
  flow('POST /flow/:id/correction-preview', { params: { id }, body: input });

/**
 * 按核验结果提交更正（核验的输入 + previewDigest + requestId）。被拒（版本变了、核验以后数据变了）以后怎么接着办
 * 在 correction-recover.ts，由更正窗读回最新的单据重新核验。
 */
export const commitCorrection = (id: number, body: FlowApi['POST /flow/:id/correct']['body']) =>
  flow('POST /flow/:id/correct', { params: { id }, body });

/** 只改计划日期和时间，不登记实际业务、不动库存。requestId 重试时沿用同一个。 */
export const scheduleFlow = (id: number, input: FlowApi['POST /flow/:id/schedule']['body']) =>
  flow('POST /flow/:id/schedule', { params: { id }, body: input });

/** 取核对内容：核对入库、不导出直接出库先看库存怎么变（带预览摘要 previewDigest，确认时带回去） */
export const previewFlow = (id: number) => flow('POST /flow/:id/preview', { params: { id }, body: {} });

/** 核对窗里的内容：核对接口的回答，第一次确认时记下请求号（没办成再点确认沿用同一个，服务端只办一次） */
export type FlowReview = FlowPreview & { requestId?: string };

/** 接口回答的出错类别（服务端的 code）；不是接口出错时没有 */
const failureCode = (e: unknown) => (e instanceof Error && 'code' in e ? e.code : undefined);

/**
 * 按核对内容确认。核对期间单据、库存或关联档案被别人改了（服务端类别 preview-changed）：
 * 取最新的核对内容交给 reloaded（窗口换成最新的），再报 previewChangedMessage，人看过再确认。
 * 单据页、到货页和 AI 导入的到货核对都用这一份。
 */
export async function confirmPreview(preview: FlowReview, reloaded: (next: FlowPreview) => Promise<unknown> | void) {
  try {
    return await flow('POST /flow/:id/confirm', {
      params: { id: preview.document.id },
      body: { previewDigest: preview.previewDigest, requestId: (preview.requestId ||= crypto.randomUUID()), acknowledged: true },
    });
  } catch (e: unknown) {
    if (failureCode(e) !== PREVIEW_CHANGED_CODE) throw e;
    await reloaded(await previewFlow(preview.document.id));
    throw new Error(previewChangedMessage);
  }
}

/** 成品库存品的批次（每次完工入库一批）；all 为真时连估计已发完的一起列全 */
export const readStockBatches = (stockId: number, all: boolean) =>
  flow('GET /flow/stock-batches/:id', { params: { id: stockId }, query: { depleted: all ? 'all' : undefined } });

/** 登记完工（一次几张任务）：先核验，再按核验结果办 */
export const previewCompletion = (input: FlowApi['POST /flow/production-completion/preview']['body']) =>
  flow('POST /flow/production-completion/preview', { body: input });
export const executeCompletion = (
  input: FlowApi['POST /flow/production-completion/execute']['body']['input'],
  previewDigest: string,
) => flow('POST /flow/production-completion/execute', { body: { input, previewDigest } });

/** 采购退货：到货单每行还能退多少、登记退货、到货单下的退货记录、撤销一次退货 */
export const readReturnable = (arrivalId: number) => flow('GET /flow/returns/returnable/:id', { params: { id: arrivalId } });
export const saveReturn = (body: FlowApi['POST /flow/returns']['body']) => flow('POST /flow/returns', { body });
export const readReturns = (arrivalId: number) => flow('GET /flow/returns', { query: { arrivalId } });
export const reverseReturn = (id: number, body: FlowApi['POST /flow/returns/:id/reverse']['body']) =>
  flow('POST /flow/returns/:id/reverse', { params: { id }, body });
