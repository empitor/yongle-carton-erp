import type { Store } from '../core/index.js';
import type { FlowDocView } from '../../shared/business/index.js';
import { viewContent, writeFlowDocument } from './document-store.js';

/**
 * 管理员直接改订单时，已有单据要跟着改（业务汇总的 order-edit-cascade.ts 调）。
 * 单据表归单据流转，写都落在 document-store.ts（镜像列跟着内容一起写）；改订单后由调用方调
 * FlowService.maintenanceReferences 重建关联、refreshOrderProgress 重算进度。
 * 调用方拿的是单据视图（FlowService.list、get），改好整份交回来：行上的列和派生字段不写，内容按库里的单据结构核对。
 */

/** 整份替换单据内容，版本号加一（别处打开的单据会提示已变化） */
export function replaceFlowDocument(store: Store, id: number, view: FlowDocView) {
  writeFlowDocument(store, id, viewContent(view));
}

/** 拆分送货单：拆出来的新单据沿用原单的状态和确认记录（不换版本号，它是刚建的） */
export function carryOverFlowDocument(store: Store, id: number, status: string, view: FlowDocView) {
  writeFlowDocument(store, id, viewContent(view), { status, bumpVersion: false });
}
